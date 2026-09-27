import "server-only";
import { z } from "zod";
import { prisma } from "../db";
import { parseDoc, textblocks } from "../doc/doc";
import { creditLine, searchCommons, type CommonsImage } from "../images/commons";
import { buildMessages } from "./prompts";
import { chatJson } from "./tasks";

/**
 * 이미지 추천 — 절의 문단마다 맞는 전문 이미지(논문 도표·그래프·도식 등)를 찾아 제시한다.
 *  1) AI(image-suggest): 그림이 필요한 문단을 고르고 영어 검색어를 만든다
 *  2) Wikimedia Commons 검색: 문단마다 검색어로 후보를 모은다(중복 제거)
 *  3) AI(image-pick): 후보 제목·설명을 문단과 맞춰 보고 맞는 것만 관련도 순으로 고르며 캡션을 쓴다
 * 넣기(승인)는 편집기가 한다 — 문단 끝에 캡션(+출처)과 함께.
 */

export type ImageCandidate = CommonsImage & { id: string; caption: string; credit: string; score: number };
export type ImageSuggestion = {
  /** 문단 번호(1부터, 서버 textblocks 순서) */
  paragraph: number;
  /** 넣을 때 문단을 다시 찾는 단서 — 문단 앞부분 */
  anchor: string;
  kind: string;
  need: string;
  queries: string[];
  candidates: ImageCandidate[];
};

const suggestSchema = z.object({
  items: z
    .array(
      z.object({
        paragraph: z.coerce.number(),
        kind: z.string().default("figure"),
        need: z.string().default(""),
        queries: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});

const pickSchema = z.object({
  items: z
    .array(
      z.object({
        paragraph: z.coerce.number(),
        picks: z.array(z.object({ id: z.string(), score: z.coerce.number().default(50), caption: z.string().default("") })).default([]),
      }),
    )
    .default([]),
});

async function limit<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export const ANCHOR_LEN = 40;
const MAX_PARAS_CHARS = 16000;

export async function suggestImages(sectionId: string, contentJson: string, opts: { max?: number; signal?: AbortSignal } = {}): Promise<{ items: ImageSuggestion[]; searched: number }> {
  const sec = await prisma.section.findUnique({
    where: { id: sectionId },
    select: { title: true, chapter: { select: { project: { select: { id: true, title: true, audience: true } } } } },
  });
  if (!sec) throw Object.assign(new Error("절을 찾을 수 없습니다."), { status: 404 });
  const project = sec.chapter.project;
  const blocks = textblocks(parseDoc(contentJson));
  const paras = blocks.map((b, i) => ({ n: i + 1, text: b.text.trim(), type: b.type })).filter((b) => b.type === "paragraph" && b.text.length >= 40);
  if (!paras.length) return { items: [], searched: 0 };

  // 1) 그림이 필요한 문단과 검색어 — 긴 절은 앞에서부터 16,000자까지(한 번 부르기)
  let used = 0;
  const shown = paras.filter((p) => (used += p.text.length) <= MAX_PARAS_CHARS || p === paras[0]);
  const total = shown.reduce((a, p) => a + p.text.length, 0);
  const max = Math.max(1, Math.min(opts.max ?? 6, Math.round(total / 1500) || 1));
  const { messages } = await buildMessages("image-suggest", {
    title: project.title,
    audience: project.audience,
    sectionTitle: sec.title,
    max,
    numberedParagraphs: shown.map((p) => `[${p.n}] ${p.text.slice(0, 1500)}`).join("\n"),
  });
  const plan = await chatJson(suggestSchema, { purpose: "image_suggest", projectId: project.id, messages, temperature: 0.2, maxTokens: 6000, signal: opts.signal });
  const byN = new Map(paras.map((p) => [p.n, p]));
  const seenPara = new Set<number>();
  const wanted = (plan.value?.items ?? [])
    .filter((it) => byN.has(it.paragraph) && !seenPara.has(it.paragraph) && seenPara.add(it.paragraph))
    .map((it) => ({ ...it, queries: it.queries.map((q) => q.replace(/["'“”]/g, "").trim()).filter(Boolean).slice(0, 3) }))
    .filter((it) => it.queries.length)
    .slice(0, max);
  if (!wanted.length) return { items: [], searched: 0 };

  // 2) 검색 — 문단마다 검색어를 차례로, 후보가 8개 모이면 멈춘다
  let searched = 0;
  const pools = await limit(wanted, 3, async (it) => {
    const pool: CommonsImage[] = [];
    const seen = new Set<string>();
    for (const q of it.queries) {
      if (pool.length >= 8 || opts.signal?.aborted) break;
      searched++;
      const found = await searchCommons(q, { limit: 10, signal: opts.signal }).catch((e) => {
        console.warn("[image-suggest] 검색 실패", q, e?.message);
        return [] as CommonsImage[];
      });
      for (const f of found) if (!seen.has(f.src) && pool.length < 8) (seen.add(f.src), pool.push(f));
    }
    return pool;
  });

  // 3) 후보 고르기·캡션 — 한 번에
  const ided = wanted.map((it, i) => pools[i].map((c, j) => ({ ...c, id: `${it.paragraph}-${j + 1}` })));
  const withPool = wanted.map((it, i) => ({ it, pool: ided[i] })).filter((x) => x.pool.length);
  if (!withPool.length) return { items: [], searched };
  const blocksText = withPool
    .map(({ it, pool }) => {
      const para = byN.get(it.paragraph)!.text.slice(0, 700);
      const cands = pool.map((c) => `  - ${c.id}: ${c.title}${c.description ? ` — ${c.description.slice(0, 200)}` : ""} (${c.width}×${c.height})`).join("\n");
      return `[문단 ${it.paragraph}] (필요한 그림: ${it.need || it.kind})\n${para}\n후보:\n${cands}`;
    })
    .join("\n\n");
  const pick = await chatJson(pickSchema, {
    purpose: "image_pick",
    projectId: project.id,
    messages: (await buildMessages("image-pick", { title: project.title, blocks: blocksText })).messages,
    temperature: 0.2,
    maxTokens: 6000,
    signal: opts.signal,
  });
  const picks = new Map((pick.value?.items ?? []).map((p) => [p.paragraph, p.picks]));

  const items: ImageSuggestion[] = [];
  for (const { it, pool } of withPool) {
    const byId = new Map(pool.map((c) => [c.id, c]));
    // AI가 고르지 못했으면(응답 오류) 검색 순서대로 3개, 골랐는데 맞는 게 없으면 뺀다
    const chosen = pick.value
      ? (picks.get(it.paragraph) ?? [])
          .filter((p) => byId.has(p.id) && p.score >= 40)
          .sort((a, b) => b.score - a.score)
          .slice(0, 3)
          .map((p) => ({ c: byId.get(p.id)!, score: Math.round(p.score), caption: p.caption.trim() }))
      : pool.slice(0, 3).map((c) => ({ c, score: 0, caption: "" }));
    if (!chosen.length) continue;
    items.push({
      paragraph: it.paragraph,
      anchor: byN.get(it.paragraph)!.text.slice(0, ANCHOR_LEN),
      kind: it.kind,
      need: it.need,
      queries: it.queries,
      candidates: chosen.map(({ c, score, caption }) => ({
        ...c,
        score,
        caption: (caption || it.need || c.title).replace(/^["'“”]+|["'“”]+$/g, "").replace(/^그림\s*\d+[.:]?\s*/, "").slice(0, 120),
        credit: creditLine(c),
      })),
    });
  }
  items.sort((a, b) => a.paragraph - b.paragraph);
  return { items, searched };
}
