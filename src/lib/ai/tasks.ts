import "server-only";
import { z } from "zod";
import { prisma } from "../db";
import { flatSections, loadBook, type Book, type BookChapter, type BookSection } from "../book";
import { charCount, docPlainText, docToMarkdown, findFootnotes, hashText, parseDoc, textblocks } from "../doc/doc";
import { chat, chatStream, extractJson } from "./client";
import { buildMessages } from "./prompts";

/* ---------------- 공통 텍스트 조립 ---------------- */

export function styleProfileText(raw: string | null | undefined): string {
  if (!raw) return "";
  try {
    const p = JSON.parse(raw);
    const lines = [
      p.endingStyle && `- 종결어미: ${p.endingStyle}`,
      p.sentenceLength && `- 문장 길이·리듬: ${p.sentenceLength}`,
      p.paragraphing && `- 문단: ${p.paragraphing}`,
      p.voice && `- 화자·독자 거리: ${p.voice}`,
      p.tone && `- 어조: ${Array.isArray(p.tone) ? p.tone.join(", ") : p.tone}`,
      p.devices?.length && `- 자주 쓰는 장치: ${p.devices.join(" / ")}`,
      p.signaturePhrases?.length && `- 자주 쓰는 표현: ${p.signaturePhrases.join(", ")}`,
      p.avoid?.length && `- 쓰지 않는 것: ${p.avoid.join(" / ")}`,
    ].filter(Boolean);
    return lines.join("\n");
  } catch {
    return raw;
  }
}

function styleExcerpts(raw: string | null | undefined): string {
  try {
    const p = JSON.parse(raw ?? "");
    return (p.sampleExcerpts ?? [])
      .slice(0, 3)
      .map((e: string, i: number) => `(${i + 1}) ${e}`)
      .join("\n");
  } catch {
    return "";
  }
}

function signaturePhrases(raw: string | null | undefined): string {
  try {
    return (JSON.parse(raw ?? "").signaturePhrases ?? []).join(", ");
  } catch {
    return "";
  }
}

function glossaryText(book: Book) {
  return book.project.glossary
    .map((g) => `- ${g.term} → ${g.preferred}${g.note ? ` (${g.note})` : ""}`)
    .join("\n");
}

function chapterName(c: BookChapter) {
  return c.label || (c.kind === "front" ? "앞붙이" : "뒷붙이");
}

function tocOutline(book: Book, currentId?: string) {
  return book.chapters
    .map((c) => {
      const head = `${c.label ? c.label + " " : ""}${c.title}${c.promise ? ` — ${c.promise}` : ""}`;
      const secs = c.sections
        .map((s) => `   ${s.label ? s.label + " " : "- "}${s.title}${s.gist ? `: ${s.gist}` : ""}${s.id === currentId ? "  ◀ 지금 쓰는 절" : ""}`)
        .join("\n");
      return head + (secs ? "\n" + secs : "");
    })
    .join("\n");
}

function bookVars(book: Book) {
  const p = book.project;
  return {
    title: p.title,
    subtitle: p.subtitle,
    author: p.author,
    topic: p.topic,
    intent: p.intent,
    audience: p.audience,
    keyMessage: p.keyMessage,
    tone: p.tone,
    references: p.references,
    targetPages: p.targetPages,
    extra: p.extra,
    styleProfile: styleProfileText(p.styleProfile),
    styleExcerpts: styleExcerpts(p.styleProfile),
    glossary: glossaryText(book),
  };
}

/* ---------------- 목차 설계 ---------------- */

const tocSchema = z.object({
  concept: z.string(),
  flow: z.string().default(""),
  chapters: z
    .array(
      z.object({
        title: z.string(),
        promise: z.string().default(""),
        rationale: z.string().default(""),
        sections: z
          .array(
            z.object({
              title: z.string(),
              gist: z.string().default(""),
              hook: z.string().default(""),
              targetPages: z.coerce.number().default(3),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
  readerHooks: z.array(z.string()).default([]),
  differentiation: z.array(z.string()).default([]),
  estimatedPages: z.coerce.number().default(0),
  frontMatter: z.array(z.string()).default([]),
  backMatter: z.array(z.string()).default([]),
});
export type TocDesign = z.infer<typeof tocSchema>;

export async function designToc(
  projectId: string,
  opts: { regenerate?: boolean; chapterIndex?: number; previousConcept?: string } = {},
): Promise<{ design?: TocDesign; raw: string; error?: string }> {
  const book = await loadBook(projectId);
  if (!book) throw new Error("프로젝트를 찾을 수 없습니다.");
  const { messages } = await buildMessages("toc-design", {
    ...bookVars(book),
    regenerate: opts.regenerate,
    previousConcept: opts.previousConcept,
    chapterOnly: opts.chapterIndex !== undefined,
    chapterIndex: opts.chapterIndex,
    currentToc: tocOutline(book),
  });
  let raw = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await chat({ purpose: "toc_design", projectId, messages, temperature: 0.8, maxTokens: 32000 });
    raw = r.text;
    try {
      const design = tocSchema.parse(extractJson(raw));
      // 번호는 앱이 붙이므로 AI가 넣은 "1장.", "제1장", "1.1" 같은 접두어 제거
      for (const c of design.chapters) {
        c.title = c.title.replace(/^\s*(제\s*)?\d+\s*(장|부)\s*[.:·\-–—]?\s*/, "").trim() || c.title;
        for (const s of c.sections) s.title = s.title.replace(/^\s*\d+(\.\d+)*\s*[.:)\-–—]?\s+/, "").trim() || s.title;
      }
      return { design, raw };
    } catch {}
  }
  return { raw, error: "목차 응답을 해석하지 못했습니다. 원문을 확인하세요." };
}

/* ---------------- 요약 (앞 내용 연결용) ---------------- */

async function ensureSectionSummary(book: Book, c: BookChapter, s: BookSection): Promise<string> {
  const text = docPlainText(parseDoc(s.content));
  if (!text.trim()) return "";
  const h = hashText(text);
  if (s.summary && s.summaryHash === h) return s.summary;
  const { messages } = await buildMessages("section-summary", {
    chapterNo: chapterName(c),
    sectionNo: s.label,
    sectionTitle: s.title,
    content: text.slice(0, 20000),
  });
  const r = await chat({ purpose: "summary", projectId: book.project.id, messages, temperature: 0.3, maxTokens: 5000 });
  const summary = r.text.trim();
  await prisma.section.update({ where: { id: s.id }, data: { summary, summaryHash: h } });
  s.summary = summary;
  s.summaryHash = h;
  return summary;
}

export async function summarizeSection(sectionId: string) {
  const sec = await prisma.section.findUnique({ where: { id: sectionId }, include: { chapter: true } });
  if (!sec) return "";
  const book = await loadBook(sec.chapter.projectId);
  if (!book) return "";
  for (const c of book.chapters) for (const s of c.sections) if (s.id === sectionId) return ensureSectionSummary(book, c, s);
  return "";
}

async function ensureChapterSummary(book: Book, c: BookChapter): Promise<string> {
  const parts: string[] = [];
  for (const s of c.sections) {
    const sm = await ensureSectionSummary(book, c, s);
    if (sm) parts.push(`${s.label || "-"} ${s.title}: ${sm}`);
  }
  if (!parts.length) return "";
  const joined = parts.join("\n");
  const h = hashText(joined);
  if (c.summary && c.summaryHash === h) return c.summary;
  const { messages } = await buildMessages("chapter-summary", {
    chapterNo: chapterName(c),
    chapterTitle: c.title,
    sectionSummaries: joined,
  });
  const r = await chat({ purpose: "chapter_summary", projectId: book.project.id, messages, temperature: 0.3, maxTokens: 6000 });
  const summary = r.text.trim();
  await prisma.chapter.update({ where: { id: c.id }, data: { summary, summaryHash: h } });
  return summary;
}

/** 이전 장들은 장 단위 요약, 같은 장은 절 요약 전부. 최대 2,500자(가까운 내용 우선) */
async function previousSummaries(book: Book, chapterIdx: number, sectionIdx: number) {
  const chunks: string[] = [];
  for (let ci = 0; ci < chapterIdx; ci++) {
    const c = book.chapters[ci];
    const sm = await ensureChapterSummary(book, c);
    if (sm) chunks.push(`[${chapterName(c)} ${c.title}] ${sm}`);
  }
  const cur = book.chapters[chapterIdx];
  for (let si = 0; si < sectionIdx; si++) {
    const s = cur.sections[si];
    const sm = await ensureSectionSummary(book, cur, s);
    if (sm) chunks.push(`[${s.label || ""} ${s.title}] ${sm}`);
  }
  let out = "";
  for (let i = chunks.length - 1; i >= 0; i--) {
    if ((chunks[i] + "\n" + out).length > 2500) break;
    out = chunks[i] + (out ? "\n" + out : "");
  }
  return out;
}

function tailOf(content: string, maxChars = 800) {
  const blocks = textblocks(parseDoc(content))
    .map((b) => b.text)
    .filter((t) => t.trim());
  const tail: string[] = [];
  let len = 0;
  for (let i = blocks.length - 1; i >= 0 && tail.length < 3; i--) {
    if (len + blocks[i].length > maxChars && tail.length) break;
    tail.unshift(blocks[i]);
    len += blocks[i].length;
  }
  return tail.join("\n\n");
}

/* ---------------- 절 집필 ---------------- */

export type WriteEvent =
  | { t: "status"; v: string }
  | { t: "delta"; v: string }
  | { t: "done"; chars: number }
  | { t: "error"; v: string };

export type WriteOptions = {
  targetPages: number;
  mode: "overwrite" | "continue" | "newVersion";
  extraInstruction?: string;
  signal?: AbortSignal;
};

const outlineSchema = z.object({
  parts: z
    .array(
      z.object({
        heading: z.string(),
        points: z.array(z.string()).default([]),
        sketchItems: z.array(z.string()).default([]),
        chars: z.coerce.number(),
      }),
    )
    .min(1),
});

export async function* writeSection(sectionId: string, opts: WriteOptions): AsyncGenerator<WriteEvent> {
  const sec = await prisma.section.findUnique({ where: { id: sectionId }, include: { chapter: true } });
  if (!sec) throw new Error("절을 찾을 수 없습니다.");
  const book = await loadBook(sec.chapter.projectId);
  if (!book) throw new Error("프로젝트를 찾을 수 없습니다.");
  const projectId = book.project.id;

  const flat = flatSections(book);
  const idx = flat.findIndex((f) => f.section.id === sectionId);
  const { chapter, section } = flat[idx];
  const ci = book.chapters.findIndex((c) => c.id === chapter.id);
  const si = chapter.sections.findIndex((s) => s.id === sectionId);
  const prev = flat[idx - 1];
  const next = flat[idx + 1];

  yield { t: "status", v: "앞 내용 정리 중…" };
  const prevSummaries = await previousSummaries(book, ci, si);

  const cpp = book.project.charsPerPage || 700;
  const targetChars = Math.round(opts.targetPages * cpp);
  const existing = parseDoc(section.content);
  const baseVars = {
    ...bookVars(book),
    chapterNo: chapterName(chapter),
    chapterTitle: chapter.title,
    sectionNo: section.label || "",
    sectionTitle: section.title,
    sectionGist: section.gist,
    previousSummaries: prevSummaries,
    previousTail: prev ? tailOf(prev.section.content) || "(앞 절 미작성)" : "(책의 첫 절)",
    nextGist: next ? `${next.section.title}: ${next.section.gist}` : "(마지막 절)",
    sketch: section.sketch,
    targetPages: opts.targetPages,
    targetChars,
    minChars: Math.round(targetChars * 0.9),
    maxChars: Math.round(targetChars * 1.1),
    tocOutline: tocOutline(book, sectionId),
    lastInChapter: si === chapter.sections.length - 1,
    extraInstruction: opts.extraInstruction,
    mode_continue: opts.mode === "continue",
    existingContent: opts.mode === "continue" ? docToMarkdown(existing).md.slice(-6000) : "",
  };

  let total = 0;
  // 이 모델은 본문 전에 생각(추론) 토큰을 쓰므로 넉넉하게 잡는다
  const maxTokens = (chars: number) => Math.min(Math.round(chars * 2.5 + 8000), 32000);

  if (opts.targetPages <= 5) {
    yield { t: "status", v: "구상 중… 첫 문장이 나오기까지 30초~1분 걸릴 수 있습니다" };
    const { messages, instructionIncluded } = await buildMessages("section-write", baseVars);
    const gen = chatStream({
      purpose: "section_write",
      projectId,
      messages,
      temperature: 0.7,
      maxTokens: maxTokens(targetChars),
      signal: opts.signal,
      instructionIncluded,
    });
    let r = await gen.next();
    while (!r.done) {
      total += r.value.length;
      yield { t: "delta", v: r.value };
      r = await gen.next();
    }
    if (r.value?.truncated) yield { t: "status", v: "truncated" };
  } else {
    // 긴 절: 개요 → 파트별 생성
    yield { t: "status", v: "긴 절이라 소제목 개요를 먼저 만드는 중…" };
    const om = await buildMessages("section-outline", baseVars);
    let parts: z.infer<typeof outlineSchema>["parts"] = [];
    for (let a = 0; a < 2 && !parts.length; a++) {
      const r = await chat({
        purpose: "section_outline",
        projectId,
        messages: om.messages,
        temperature: 0.5,
        maxTokens: 8000,
        signal: opts.signal,
        instructionIncluded: om.instructionIncluded,
      });
      try {
        parts = outlineSchema.parse(extractJson(r.text)).parts;
      } catch {}
    }
    if (!parts.length) parts = [{ heading: "", points: [], sketchItems: [], chars: targetChars }];
    let written = "";
    for (let p = 0; p < parts.length; p++) {
      if (opts.signal?.aborted) break;
      const part = parts[p];
      yield { t: "status", v: `집필 중… (${p + 1}/${parts.length}) ${part.heading} — 파트마다 첫 문장까지 30초 정도 걸립니다` };
      if (part.heading) {
        const h = `${written ? "\n\n" : ""}## ${part.heading}\n\n`;
        written += h;
        yield { t: "delta", v: h };
      }
      const lastPara = written.trim().split(/\n+/).filter((l) => l.trim() && !l.startsWith("## ")).slice(-1)[0] ?? "";
      const partInfo = [
        `[이번 파트] ${part.heading || "(소제목 없음)"} / 다룰 내용: ${part.points.join("; ") || "(개요 없음)"} / 배정된 스케치: ${part.sketchItems.join("; ") || "(없음)"} / 분량 약 ${part.chars}자`,
        p > 0 ? `앞 파트 마지막 문단: ${lastPara}\n절 도입부를 다시 쓰지 말고 앞 파트에서 자연스럽게 이어 쓴다.` : "이 파트는 절의 도입부다.",
        p === parts.length - 1 ? "이 파트에서 절을 마무리한다." : "이 파트에서 절을 마무리하지 않는다.",
        "소제목은 앱이 붙이므로 출력하지 않는다.",
      ].join("\n");
      const { messages, instructionIncluded } = await buildMessages("section-write", { ...baseVars, partInfo });
      const gen = chatStream({
        purpose: "section_write_part",
        projectId,
        messages,
        temperature: 0.7,
        maxTokens: maxTokens(part.chars),
        signal: opts.signal,
        instructionIncluded,
      });
      let r = await gen.next();
      while (!r.done) {
        total += r.value.length;
        written += r.value;
        yield { t: "delta", v: r.value };
        r = await gen.next();
      }
      if (r.value?.truncated) yield { t: "status", v: "truncated" };
    }
  }
  yield { t: "done", chars: total };
}

/* ---------------- 분량 조정 ---------------- */

export async function* adjustLength(
  sectionId: string,
  targetChars: number,
  signal?: AbortSignal,
): AsyncGenerator<WriteEvent> {
  const sec = await prisma.section.findUnique({ where: { id: sectionId }, include: { chapter: true } });
  if (!sec) throw new Error("절을 찾을 수 없습니다.");
  const doc = parseDoc(sec.content);
  const current = charCount(doc);
  const { md } = docToMarkdown(doc);
  const { messages, instructionIncluded } = await buildMessages("length-adjust", {
    currentChars: current,
    targetChars,
    direction: targetChars > current ? "늘린다" : "줄인다",
    sketch: sec.sketch,
    content: md,
  });
  yield { t: "status", v: targetChars > current ? "분량 늘리는 중…" : "분량 줄이는 중…" };
  let total = 0;
  for await (const d of chatStream({
    purpose: "length_adjust",
    projectId: sec.chapter.projectId,
    messages,
    temperature: 0.5,
    maxTokens: Math.min(Math.round(Math.max(targetChars, current) * 2.5 + 8000), 32000),
    signal,
    instructionIncluded,
  })) {
    total += d.length;
    yield { t: "delta", v: d };
  }
  yield { t: "done", chars: total };
}

/* ---------------- 교정·교열 ---------------- */

export type ProofChange = {
  paragraph: number;
  before: string;
  after: string;
  type: string;
  reason: string;
};

const proofSchema = z.object({
  changes: z
    .array(
      z.object({
        paragraph: z.coerce.number(),
        before: z.string(),
        after: z.string(),
        type: z.string().default(""),
        reason: z.string().default(""),
      }),
    )
    .default([]),
});

export async function proofread(sectionId: string, contentJson: string, level: "proof" | "light") {
  const sec = await prisma.section.findUnique({ where: { id: sectionId }, include: { chapter: true } });
  if (!sec) throw new Error("절을 찾을 수 없습니다.");
  const book = await loadBook(sec.chapter.projectId);
  if (!book) throw new Error("프로젝트를 찾을 수 없습니다.");
  const blocks = textblocks(parseDoc(contentJson)).map((b) => b.text);

  // 약 2,000자 단위 문단 묶음
  const chunks: number[][] = [];
  let cur: number[] = [];
  let len = 0;
  blocks.forEach((t, i) => {
    if (!t.trim()) return;
    if (len + t.length > 2000 && cur.length) {
      chunks.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(i);
    len += t.length;
  });
  if (cur.length) chunks.push(cur);

  const run = async (idxs: number[]) => {
    const { messages, instructionIncluded } = await buildMessages("proofread", {
      glossary: glossaryText(book),
      level_light_edit: level === "light",
      signaturePhrases: signaturePhrases(book.project.styleProfile),
      numberedParagraphs: idxs.map((i) => `[${i + 1}] ${blocks[i]}`).join("\n"),
    });
    for (let a = 0; a < 2; a++) {
      const r = await chat({
        purpose: "proofread",
        projectId: book.project.id,
        messages,
        temperature: 0.1,
        maxTokens: 24000,
        instructionIncluded,
      });
      try {
        return proofSchema.parse(extractJson(r.text)).changes;
      } catch {}
    }
    return [] as ProofChange[];
  };

  const results: ProofChange[] = [];
  for (let i = 0; i < chunks.length; i += 3) {
    const batch = await Promise.all(chunks.slice(i, i + 3).map(run));
    batch.forEach((b) => results.push(...b));
  }

  // 검증: before가 해당 문단에 정확히 한 번 나와야 적용 가능
  const valid: ProofChange[] = [];
  const failed: ProofChange[] = [];
  for (const c of results) {
    const text = blocks[c.paragraph - 1];
    if (!text || !c.before || c.before === c.after) {
      failed.push(c);
      continue;
    }
    const first = text.indexOf(c.before);
    if (first < 0 || text.indexOf(c.before, first + 1) >= 0) failed.push(c);
    else valid.push(c);
  }
  return { changes: valid, failed };
}

/* ---------------- 선택 영역 부분 수정 ---------------- */

export async function rewriteSelection(
  sectionId: string,
  input: { action: string; before: string; selection: string; after: string; toneTarget?: string },
) {
  const sec = await prisma.section.findUnique({ where: { id: sectionId }, include: { chapter: true } });
  if (!sec) throw new Error("절을 찾을 수 없습니다.");
  const book = await loadBook(sec.chapter.projectId);
  if (!book) throw new Error("프로젝트를 찾을 수 없습니다.");
  const ratio = input.action === "expand" ? 1.5 : input.action === "shorten" ? 0.6 : 1;
  const { messages, instructionIncluded } = await buildMessages("rewrite-selection", {
    styleProfile: styleProfileText(book.project.styleProfile),
    glossary: glossaryText(book),
    ratio,
    toneTarget: input.toneTarget ?? "",
    action: input.action,
    before: input.before.slice(-800),
    selection: input.selection,
    after: input.after.slice(0, 800),
  });
  const r = await chat({
    purpose: "rewrite_" + input.action,
    projectId: book.project.id,
    messages,
    temperature: 0.6,
    maxTokens: Math.min(Math.round(input.selection.length * 3 + 6000), 24000),
    instructionIncluded,
  });
  return r.text.trim();
}

/* ---------------- 각주 ---------------- */

async function bookOfSection(sectionId: string) {
  const sec = await prisma.section.findUnique({ where: { id: sectionId }, include: { chapter: true } });
  if (!sec) throw new Error("절을 찾을 수 없습니다.");
  const book = await loadBook(sec.chapter.projectId);
  if (!book) throw new Error("프로젝트를 찾을 수 없습니다.");
  return book;
}

/** 작가가 고른 단어 하나에 붙일 각주 */
export async function writeFootnote(sectionId: string, input: { term: string; context: string; current?: string }) {
  const book = await bookOfSection(sectionId);
  const { messages } = await buildMessages("footnote", {
    title: book.project.title,
    audience: book.project.audience,
    glossary: glossaryText(book),
    term: input.term.slice(0, 200),
    context: input.context.slice(0, 1200),
    current: input.current?.slice(0, 600) ?? "",
  });
  const r = await chat({ purpose: "footnote", projectId: book.project.id, messages, temperature: 0.3, maxTokens: 4000 });
  return r.text
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/^\s*(각주|주)\s*[:：]\s*/, "")
    .slice(0, 600);
}

export type AutoFootnote = { paragraph: number; term: string; note: string };

const autoFootnoteSchema = z.object({
  footnotes: z
    .array(z.object({ paragraph: z.coerce.number(), term: z.string(), note: z.string() }))
    .default([]),
});

/** 절 전체에서 각주가 필요한 중요 키워드를 골라 각주를 쓴다. term이 해당 문단에 실제로 있는 것만 돌려준다. */
export async function autoFootnotes(sectionId: string, contentJson: string): Promise<AutoFootnote[]> {
  const book = await bookOfSection(sectionId);
  const doc = parseDoc(contentJson);
  const blocks = textblocks(doc).map((b) => b.text);
  const existing = findFootnotes(doc)
    .map((f) => String(f.attrs?.term ?? ""))
    .filter(Boolean);

  const chunks: number[][] = [];
  let cur: number[] = [];
  let len = 0;
  blocks.forEach((t, i) => {
    if (!t.trim()) return;
    if (len + t.length > 5000 && cur.length) {
      chunks.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(i);
    len += t.length;
  });
  if (cur.length) chunks.push(cur);

  const run = async (idxs: number[]) => {
    const size = idxs.reduce((a, i) => a + blocks[i].length, 0);
    const { messages } = await buildMessages("footnote-auto", {
      title: book.project.title,
      audience: book.project.audience,
      glossary: glossaryText(book),
      existing: existing.join(", "),
      max: Math.max(1, Math.round(size / 1500)),
      numberedParagraphs: idxs.map((i) => `[${i + 1}] ${blocks[i]}`).join("\n"),
    });
    for (let a = 0; a < 2; a++) {
      const r = await chat({ purpose: "footnote_auto", projectId: book.project.id, messages, temperature: 0.2, maxTokens: 16000 });
      try {
        return autoFootnoteSchema.parse(extractJson(r.text)).footnotes;
      } catch {}
    }
    return [] as AutoFootnote[];
  };

  const results: AutoFootnote[] = [];
  for (let i = 0; i < chunks.length; i += 3) {
    const batch = await Promise.all(chunks.slice(i, i + 3).map(run));
    batch.forEach((b) => results.push(...b));
  }
  const seen = new Set(existing);
  return results.filter((f) => {
    const term = f.term.trim();
    const note = f.note.trim();
    if (!term || !note || seen.has(term) || !blocks[f.paragraph - 1]?.includes(term)) return false;
    seen.add(term);
    f.term = term;
    f.note = note.slice(0, 600);
    return true;
  });
}

/* ---------------- 문체 분석 ---------------- */

export async function analyzeStyle(samples: string, projectId?: string) {
  const { messages } = await buildMessages("style-analyze", { samples });
  for (let a = 0; a < 2; a++) {
    const r = await chat({ purpose: "style_analyze", projectId, messages, temperature: 0.3, maxTokens: 16000 });
    try {
      const j = extractJson(r.text);
      if (j && typeof j === "object") return j;
    } catch {}
  }
  throw new Error("문체 분석 응답을 해석하지 못했습니다.");
}
