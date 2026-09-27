import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { fillContent, loadBookOutline, type BookOutline } from "../book";
import { parseDoc, textblocks } from "../doc/doc";
import { getSetting, setSetting } from "../app-settings";
import { buildMessages } from "./prompts";
import { loadAiSettings } from "./settings";
import { chapterName, chatJson, ensureChapterSummary, glossaryText } from "./tasks";
import { betaSchema, consistencySchema, mapBetaRefs, mapConsistencyRefs, type BetaResult, type ConsistencyResult, type SectionIndex } from "./review-shape";

/**
 * 책 전체 일관성 점검 · AI 베타 리더.
 * 결과는 입력(원고·요약)과 모델 설정의 해시로 AppSetting에 캐시한다 — 다시 열어도 다시 청구하지 않는다.
 *   ai:consistency:{책 id}           = { sig, result, at }
 *   ai:beta:{책 id}:{장 또는 절 id}  = { hash, result, at }
 */

const err = (message: string, status = 400) => Object.assign(new Error(message), { status, expose: status >= 500 });
const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

async function modelSig() {
  const { provider, baseUrl, model, reasoningEffort, maxOutputTokens } = await loadAiSettings("revision");
  return { provider, baseUrl, model, reasoningEffort, maxOutputTokens };
}

function sectionIndex(book: BookOutline): SectionIndex {
  return book.chapters.flatMap((c) =>
    c.sections.map((s) => ({ sectionId: s.id, chapterId: c.id, label: s.label ?? "", title: s.title, chapterTitle: `${chapterName(c)} ${c.title}`.trim() })),
  );
}

/* ---------------- 책 전체 일관성 ---------------- */

export const consistencyKey = (projectId: string) => `ai:consistency:${projectId}`;
type ConsistencyCache = { sig: string; result: ConsistencyResult; at: string };

/** 원고가 바뀌었는지 가볍게 보는 서명 — 절 수정 시각·장 제목·약속·용어집 (본문을 읽지 않는다) */
function bookSig(book: BookOutline) {
  return sha({
    chapters: book.chapters.map((c) => [c.id, c.title, c.promise, c.sections.map((s) => [s.id, s.title, String(s.updatedAt)])]),
    glossary: book.project.glossary.map((g) => [g.term, g.preferred, g.note]),
    audience: book.project.audience,
    keyMessage: book.project.keyMessage,
  });
}

export async function loadConsistency(projectId: string) {
  const book = await loadBookOutline(projectId);
  if (!book) throw err("책을 찾을 수 없습니다.", 404);
  const saved = await getSetting<ConsistencyCache>(consistencyKey(projectId), { fresh: true });
  if (!saved) return { result: null, at: null, stale: false };
  return { result: saved.result, at: saved.at, stale: saved.sig !== bookSig(book) + (await modelSigHash()) };
}

async function modelSigHash() {
  return sha(await modelSig()).slice(0, 12);
}

/** 요약 준비에 쓰는 최대 시간 — 나머지는 점검 호출(최대 240초 중 일부)에 남긴다 */
const SUMMARY_BUDGET_MS = 110_000;
const BOOK_TEXT_MAX = 90_000;

export async function runConsistency(projectId: string, opts: { force?: boolean; signal?: AbortSignal } = {}) {
  const started = Date.now();
  const book = await loadBookOutline(projectId);
  if (!book) throw err("책을 찾을 수 없습니다.", 404);
  const sig = bookSig(book) + (await modelSigHash());
  const key = consistencyKey(projectId);
  const saved = await getSetting<ConsistencyCache>(key, { fresh: true });
  if (!opts.force && saved?.sig === sig) return { result: saved.result, at: saved.at, stale: false, cached: true };

  const index = sectionIndex(book);
  const written = book.chapters.filter((c) => c.sections.some((s) => s.charCount > 0));
  if (written.length < 2) throw err("본문이 있는 장이 두 개 이상일 때 책 전체를 점검할 수 있습니다.");

  // 장 요약(과 그 안의 절 요약)을 가까운 것부터 준비한다 — 시간이 모자라면 남은 장은 있던 요약·목차 요지로 본다
  let skipped = 0;
  for (const c of written) {
    opts.signal?.throwIfAborted();
    if (Date.now() - started > SUMMARY_BUDGET_MS) {
      skipped++;
      continue;
    }
    try {
      await ensureChapterSummary(projectId, c);
    } catch (e: any) {
      if (opts.signal?.aborted) throw e;
      console.warn("[consistency] 장 요약 실패", c.id, e?.message);
      skipped++;
    }
  }

  // 요약을 저장하면 절의 수정 시각이 바뀌므로 서명은 요약을 준비한 뒤의 책으로 다시 잰다(다음에 열 때 ‘바뀜’으로 보이지 않게)
  const fresh = await loadBookOutline(projectId);
  const finalSig = fresh ? bookSig(fresh) + (await modelSigHash()) : sig;
  const sNo = new Map(index.map((s, i) => [s.sectionId, i + 1]));
  const parts: string[] = [];
  book.chapters.forEach((c, ci) => {
    const head = `## [C${ci + 1}] ${chapterName(c)} ${c.title}${c.promise ? ` — 장의 약속: ${c.promise}` : ""}`;
    const secs = c.sections.map((s) => {
      const sum = (s.summary ?? "").trim();
      const body = s.charCount > 0 ? (sum ? sum.slice(0, 700) : `(요약 없음) 요지: ${s.gist || "없음"}`) : "(아직 쓰지 않음)";
      return `- [S${sNo.get(s.id)}] ${s.label ? s.label + " " : ""}${s.title}: ${body}`;
    });
    parts.push([head, c.summary && c.sections.some((s) => s.charCount > 0) ? `장 요약: ${c.summary.slice(0, 1200)}` : "", ...secs].filter(Boolean).join("\n"));
  });
  let bookSummary = parts.join("\n\n");
  if (bookSummary.length > BOOK_TEXT_MAX) bookSummary = bookSummary.slice(0, BOOK_TEXT_MAX) + "\n…(분량 한도로 뒤 생략)";

  const { messages } = await buildMessages("book-consistency", {
    title: book.project.title,
    audience: book.project.audience,
    keyMessage: book.project.keyMessage,
    glossary: glossaryText(book.project.glossary),
    maxItems: Math.min(30, Math.max(8, written.length * 2)),
    bookSummary,
    partial: skipped ? `시간 한도로 ${skipped}개 장은 요약을 새로 만들지 못해 이전 요약이나 목차 요지로만 표시했다. 그 장의 판단은 조심스럽게 한다.` : "",
  });
  const r = await chatJson(consistencySchema, { purpose: "consistency", projectId, messages, temperature: 0.2, maxTokens: 16000, signal: opts.signal });
  if (!r.value) throw err("일관성 점검 응답을 해석하지 못했습니다. 다시 시도하세요.", 502);
  const result: ConsistencyResult = { ...mapConsistencyRefs(r.value, index), coverage: { chapters: written.length, skipped } };
  const at = new Date().toISOString();
  await setSetting(key, { sig: finalSig, result, at } satisfies ConsistencyCache).catch((e) => console.warn("[consistency] 결과 저장 실패", e?.message));
  return { result, at, stale: false, cached: false };
}

/* ---------------- 베타 리더 ---------------- */

export const betaKey = (projectId: string, targetId: string) => `ai:beta:${projectId}:${targetId}`;
type BetaCache = { hash: string; result: BetaResult; at: string };
const BETA_TEXT_MAX = 60_000;

/** 읽을 부분의 프롬프트와 해시 — 조회(GET)와 실행이 같은 계산을 쓴다 */
async function betaInput(projectId: string, target: { chapterId?: string; sectionId?: string }) {
  const book = await loadBookOutline(projectId);
  if (!book) throw err("책을 찾을 수 없습니다.", 404);
  const chapter = target.sectionId ? book.chapters.find((c) => c.sections.some((s) => s.id === target.sectionId)) : book.chapters.find((c) => c.id === target.chapterId);
  if (!chapter) throw err("읽을 장·절을 찾을 수 없습니다.", 404);
  const sections = target.sectionId ? chapter.sections.filter((s) => s.id === target.sectionId) : chapter.sections;
  await fillContent(sections);
  const blocks = sections.map((s) => textblocks(parseDoc(s.content ?? "")).map((b) => b.text));
  const total = blocks.flat().join("").length;
  if (total < 300) throw err("읽을 본문이 거의 없습니다. 먼저 집필하세요.");
  // 너무 길면 절마다 비례해 앞부분만 보낸다
  const ratio = total > BETA_TEXT_MAX ? BETA_TEXT_MAX / total : 1;
  const numbered = sections
    .map((s, si) => {
      let budget = Math.round(blocks[si].join("").length * ratio);
      const lines: string[] = [];
      blocks[si].forEach((t, pi) => {
        if (!t.trim() || budget <= 0) return;
        lines.push(`[S${si + 1}-${pi + 1}] ${t}`);
        budget -= t.length;
      });
      return `### S${si + 1}. ${s.label ?? ""} ${s.title}\n${lines.join("\n") || "(비어 있음)"}`;
    })
    .join("\n\n");
  const targetId = target.sectionId ?? chapter.id;
  const targetLabel = target.sectionId ? `${chapterName(chapter)} 「${chapter.title}」 > ${sections[0]?.label ?? ""} 「${sections[0]?.title ?? ""}」` : `${chapterName(chapter)} 「${chapter.title}」 (절 ${sections.length}개)`;
  const { messages } = await buildMessages("beta-reader", {
    title: book.project.title,
    topic: book.project.topic,
    keyMessage: book.project.keyMessage,
    audience: book.project.audience.trim() || "(책 정보에 대상 독자가 비어 있다 — 이 주제에 관심 있는 일반 성인 독자로 읽는다)",
    maxItems: 8,
    targetLabel,
    chapterPromise: target.sectionId ? "" : chapter.promise,
    truncated: ratio < 1 ? `분량이 길어 절마다 앞부분 약 ${Math.round(ratio * 100)}%만 실었다.` : "",
    numbered,
  });
  const hash = sha({ messages, model: await modelSig() });
  const index: SectionIndex = sections.map((s) => ({ sectionId: s.id, chapterId: chapter.id, label: s.label ?? "", title: s.title, chapterTitle: `${chapterName(chapter)} ${chapter.title}`.trim() }));
  return { messages, hash, targetId, index, blocks, audienceMissing: !book.project.audience.trim() };
}

export async function loadBeta(projectId: string, target: { chapterId?: string; sectionId?: string }) {
  const input = await betaInput(projectId, target);
  const saved = await getSetting<BetaCache>(betaKey(projectId, input.targetId), { fresh: true });
  if (!saved) return { result: null, at: null, stale: false, audienceMissing: input.audienceMissing };
  return { result: saved.result, at: saved.at, stale: saved.hash !== input.hash, audienceMissing: input.audienceMissing };
}

export async function runBeta(projectId: string, target: { chapterId?: string; sectionId?: string }, opts: { force?: boolean; signal?: AbortSignal } = {}) {
  const input = await betaInput(projectId, target);
  const key = betaKey(projectId, input.targetId);
  const saved = await getSetting<BetaCache>(key, { fresh: true });
  if (!opts.force && saved?.hash === input.hash) return { result: saved.result, at: saved.at, stale: false, cached: true, audienceMissing: input.audienceMissing };
  const r = await chatJson(betaSchema, { purpose: "beta_reader", projectId, messages: input.messages, temperature: 0.5, maxTokens: 12000, signal: opts.signal });
  if (!r.value) throw err("베타 리더 응답을 해석하지 못했습니다. 다시 시도하세요.", 502);
  const result = mapBetaRefs(r.value, input.index, input.blocks);
  const at = new Date().toISOString();
  await setSetting(key, { hash: input.hash, result, at } satisfies BetaCache).catch((e) => console.warn("[beta-reader] 결과 저장 실패", e?.message));
  return { result, at, stale: false, cached: false, audienceMissing: input.audienceMissing };
}
