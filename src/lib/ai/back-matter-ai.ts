import "server-only";
import { z } from "zod";
import { prisma, rawTable } from "../db";
import { docPlainText, parseDoc } from "../doc/doc";
import { collectBiblioCandidates, frequentWords, type IndexTerm, normalizeIndex } from "../back-matter";
import { readMemoryText } from "../book-memory-store";
import { buildMessages } from "./prompts";
import { chatJson, glossaryText } from "./tasks";

/* 찾아보기 용어 추천 · 참고문헌 정리 — 작가가 버튼을 누를 때 한 번만 부른다(집필 흐름에 끼지 않는다) */

async function bookRows(projectId: string) {
  const p = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: {
      title: true,
      audience: true,
      glossary: true,
      chapters: {
        orderBy: { order: "asc" },
        select: { title: true, kind: true, summary: true, sections: { orderBy: { order: "asc" }, select: { id: true, title: true, gist: true, content: true } } },
      },
    },
  });
  if (!p) throw Object.assign(new Error("책을 찾을 수 없습니다."), { status: 404 });
  return p;
}

const indexSchema = z.object({ terms: z.array(z.object({ term: z.string(), aliases: z.array(z.string()).default([]) })).default([]) });

/** 찾아보기 용어 추천 — 원고에 실제로 나오는 용어만 돌려준다(원고에 없는 말은 빼고 개수만 알린다) */
export async function suggestIndexTerms(projectId: string, existing: IndexTerm[], max = 60) {
  const p = await bookRows(projectId);
  const body = p.chapters.filter((c) => c.kind === "body");
  const text = body.flatMap((c) => c.sections.map((s) => docPlainText(parseDoc(s.content)))).join("\n");
  if (text.length < 1000) throw Object.assign(new Error("본문이 아직 짧습니다. 원고를 더 쓴 뒤 추천받으세요."), { status: 400 });
  const outline = body
    .map((c) => [`# ${c.title}${c.summary ? ` — ${c.summary.slice(0, 400)}` : ""}`, ...c.sections.map((s) => `- ${s.title}${s.gist ? `: ${s.gist.slice(0, 200)}` : ""}`)].join("\n"))
    .join("\n")
    .slice(0, 20000);
  const { messages } = await buildMessages("index-suggest", {
    title: p.title,
    audience: p.audience,
    glossary: glossaryText(p.glossary),
    bookMemory: await readMemoryText(projectId),
    existing: existing.map((t) => t.term).join(", "),
    outline,
    frequent: frequentWords(text).join(", "),
    maxTerms: max,
  });
  const r = await chatJson(indexSchema, { purpose: "index_suggest", projectId, messages, temperature: 0.2, maxTokens: 6000 });
  if (!r.value) throw Object.assign(new Error("추천 응답을 해석하지 못했습니다. 다시 시도하세요."), { expose: true, httpStatus: 502 });
  const have = new Set(existing.map((t) => t.term));
  const flat = text.replace(/\s+/g, " ");
  const found: IndexTerm[] = [];
  let dropped = 0;
  for (const t of normalizeIndex({ terms: r.value.terms }).terms) {
    if (have.has(t.term)) continue;
    const forms = [t.term, ...t.aliases].filter((w) => flat.includes(w));
    if (!forms.length) {
      dropped++;
      continue;
    }
    const term = forms.includes(t.term) ? t.term : forms[0];
    found.push({ term, aliases: t.aliases.filter((a) => a !== term && flat.includes(a)), see: "" });
  }
  return { terms: found.slice(0, max), dropped };
}

const biblioSchema = z.object({ entries: z.array(z.string()).default([]) });

/** 원고에서 출처 후보를 모아 참고문헌 목록으로 정리한다. AI가 실패하면 모은 후보를 그대로 돌려준다(formatted: false) */
export async function collectBiblio(projectId: string) {
  const p = await bookRows(projectId);
  const sectionIds = p.chapters.flatMap((c) => c.sections.map((s) => s.id));
  const refRows = sectionIds.length
    ? await prisma.$queryRaw<{ key: string; name: string | null }[]>`
        SELECT key, (value::jsonb ->> 'name') AS name FROM ${rawTable("AppSetting")}
        WHERE starts_with(key, 'ref:') AND split_part(key, ':', 2) = ANY(${sectionIds})`
    : [];
  const refsOf = new Map<string, string[]>();
  for (const r of refRows) {
    const sid = r.key.split(":")[1];
    if (r.name) refsOf.set(sid, [...(refsOf.get(sid) ?? []), r.name]);
  }
  const candidates = collectBiblioCandidates(
    p.chapters.flatMap((c) => c.sections.map((s) => ({ where: `${c.title} · ${s.title}`, content: parseDoc(s.content), refs: refsOf.get(s.id) ?? [] }))),
  );
  if (!candidates.length) return { entries: [] as string[], candidates: 0, formatted: false };
  const FROM = { footnote: "각주", figure: "그림", reference: "참고 자료" } as const;
  const { messages } = await buildMessages("biblio-format", {
    title: p.title,
    candidates: candidates
      .map((c) => `- [${FROM[c.from]} · ${c.where}] ${c.text}`)
      .join("\n")
      .slice(0, 40000),
  });
  try {
    const r = await chatJson(biblioSchema, { purpose: "biblio_format", projectId, messages, temperature: 0.1, maxTokens: 12000 });
    if (r.value?.entries.length) return { entries: r.value.entries, candidates: candidates.length, formatted: true };
  } catch (e: any) {
    console.warn("[biblio] 정리 실패 — 후보를 그대로 돌려준다", e?.message);
  }
  return { entries: candidates.map((c) => c.text), candidates: candidates.length, formatted: false };
}
