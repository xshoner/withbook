import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { prisma } from "../db";
import { flatSections, loadBook, type Book, type BookChapter, type BookSection } from "../book";
import { charCount, docPlainText, docToMarkdown, findFootnotes, hashText, parseDoc, textblocks } from "../doc/doc";
import { numberChapters, parseLayout } from "../layout";
import { editStats, pickLearningPairs, type EditPair } from "../style/edits";
import { chat, chatStream, extractJson, type ChatOptions } from "./client";
import { buildMessages } from "./prompts";
import { singleFlight } from "./single-flight";
import { collectRecentContext } from "./recent-context";
import { WriteClock, type WriteTiming } from "./write-timing";
import { getSetting, setSetting } from "../app-settings";
import { loadAiSettings } from "./settings";

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
      p.prefer?.length && `- 작가가 고쳐 쓰는 방식(따른다): ${p.prefer.join(" / ")}`,
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

type GlossaryRow = { term: string; preferred: string; note: string };

function glossaryText(glossary: GlossaryRow[]) {
  return glossary.map((g) => `- ${g.term} → ${g.preferred}${g.note ? ` (${g.note})` : ""}`).join("\n");
}

function chapterName(c: { label: string; kind: string }) {
  return c.label || (c.kind === "front" ? "앞붙이" : "뒷붙이");
}

/** 전체 목차 — 절마다 같은 글이어야 system 프롬프트가 캐시된다(현재 절 표시는 user 메시지에) */
function tocOutline(book: Book) {
  return book.chapters
    .map((c) => {
      const head = `${c.label ? c.label + " " : ""}${c.title}${c.promise ? ` — ${c.promise}` : ""}`;
      const secs = c.sections.map((s) => `   ${s.label ? s.label + " " : "- "}${s.title}${s.gist ? `: ${s.gist}` : ""}`).join("\n");
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
    glossary: glossaryText(p.glossary),
  };
}

/* ---------------- 공통 도우미 ---------------- */

/** JSON 응답 호출 — 형식이 틀리면 무엇이 틀렸는지 알려 주고 한 번 더 묻는다 */
export async function chatJson<T>(schema: z.ZodType<T>, opts: ChatOptions, attempts = 2): Promise<{ value?: T; raw: string }> {
  let messages = opts.messages;
  let raw = "";
  for (let a = 0; a < attempts; a++) {
    const r = await chat({ ...opts, messages });
    raw = r.text;
    try {
      return { value: schema.parse(extractJson(raw)), raw };
    } catch (e) {
      if (opts.signal?.aborted || r.usage.truncated) break; // 잘린 응답은 다시 물어도 같은 한도에 걸린다
      const why = e instanceof z.ZodError ? e.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : "JSON을 해석할 수 없음";
      messages = [
        ...opts.messages,
        { role: "assistant", content: raw.slice(0, 12000) },
        { role: "user", content: `위 응답은 요구한 JSON 형식이 아니다 (${why}). 설명 없이 형식에 맞는 JSON 하나만 다시 출력하라.` },
      ];
    }
  }
  return { raw };
}

/** 문단 번호 목록을 글자 수 기준으로 묶는다 (빈 문단 제외) */
function chunkBlocks(blocks: string[], size: number): number[][] {
  const chunks: number[][] = [];
  let cur: number[] = [];
  let len = 0;
  blocks.forEach((t, i) => {
    if (!t.trim()) return;
    if (len + t.length > size && cur.length) {
      chunks.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(i);
    len += t.length;
  });
  if (cur.length) chunks.push(cur);
  return chunks;
}

/** 동시에 n개까지만 실행 (결과 순서 유지) */
async function mapLimit<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/** 절과 책 전체 (집필처럼 목차·앞뒤 절이 필요한 작업) */
async function sectionInBook(sectionId: string) {
  const sec = await prisma.section.findUnique({ where: { id: sectionId }, select: { chapter: { select: { projectId: true } } } });
  if (!sec) throw new Error("절을 찾을 수 없습니다.");
  const book = await loadBook(sec.chapter.projectId);
  if (!book) throw new Error("프로젝트를 찾을 수 없습니다.");
  return book;
}

/** 절과 책 정보만 (교정·부분 수정·각주처럼 다른 절 본문이 필요 없는 작업) */
async function sectionLite(sectionId: string) {
  const sec = await prisma.section.findUnique({
    where: { id: sectionId },
    select: {
      id: true,
      sketch: true,
      content: true,
      chapter: { select: { projectId: true, project: { select: { id: true, title: true, audience: true, styleProfile: true, glossary: true } } } },
    },
  });
  if (!sec) throw new Error("절을 찾을 수 없습니다.");
  return { sec, project: sec.chapter.project };
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
  const { value: design, raw } = await chatJson(tocSchema, { purpose: "toc_design", projectId, messages, temperature: 0.8, maxTokens: 24000 });
  if (!design) return { raw, error: "목차 응답을 해석하지 못했습니다. 원문을 확인하세요." };
  // 번호는 앱이 붙이므로 AI가 넣은 "1장.", "제1장", "1.1" 같은 접두어 제거
  for (const c of design.chapters) {
    c.title = c.title.replace(/^\s*(제\s*)?\d+\s*(장|부)\s*[.:·\-–—]?\s*/, "").trim() || c.title;
    for (const s of c.sections) s.title = s.title.replace(/^\s*\d+(\.\d+)*\s*[.:)\-–—]?\s+/, "").trim() || s.title;
  }
  return { design, raw };
}

/* ---------------- 요약 (앞 내용 연결용) ---------------- */

type SummaryTarget = { id: string; label: string; title: string; content: string; summary: string | null; summaryHash: string | null };
const pendingSectionSummary = singleFlight<string>();

async function ensureSectionSummary(projectId: string, c: { label: string; kind: string }, s: SummaryTarget): Promise<string> {
  const text = docPlainText(parseDoc(s.content));
  if (!text.trim()) return "";
  const h = hashText(text);
  if (s.summary && s.summaryHash === h) return s.summary;
  const summary = await pendingSectionSummary(`${projectId}:${s.id}:${h}`, async () => {
    // Another request may have finished since this book snapshot was loaded.
    const latest = await prisma.section.findUnique({ where: { id: s.id }, select: { summary: true, summaryHash: true } });
    if (latest?.summary && latest.summaryHash === h) return latest.summary;
    const { messages } = await buildMessages("section-summary", {
      chapterNo: chapterName(c),
      sectionNo: s.label,
      sectionTitle: s.title,
      content: text.slice(0, 20000),
    });
    const r = await chat({ purpose: "summary", projectId, messages, temperature: 0.3, maxTokens: 5000 });
    const summary = r.text.trim();
    await prisma.section.updateMany({ where: { id: s.id, content: s.content }, data: { summary, summaryHash: h } });
    return summary;
  });
  s.summary = summary;
  s.summaryHash = h;
  return summary;
}

/** 절 하나만 요약 — 책 전체 본문을 읽지 않고 번호만 계산한다 */
export async function summarizeSection(sectionId: string) {
  const sec = await prisma.section.findUnique({ where: { id: sectionId }, include: { chapter: { select: { projectId: true } } } });
  if (!sec) return "";
  const project = await prisma.project.findUnique({
    where: { id: sec.chapter.projectId },
    select: { layout: true, chapters: { select: { id: true, kind: true, order: true, sections: { select: { id: true }, orderBy: { order: "asc" } } } } },
  });
  if (!project) return "";
  const chapters = numberChapters(project.chapters, parseLayout(project.layout).numberFormat);
  const c = chapters.find((x) => x.sections.some((s) => s.id === sectionId));
  const label = c?.sections.find((s) => s.id === sectionId)?.label ?? "";
  const summary = await ensureSectionSummary(sec.chapter.projectId, c ?? { label: "", kind: "body" }, { ...sec, label });
  // Warm the chapter only when its section summaries are already current.
  // Never fan out into other uncached sections from an idle preparation request.
  const chapter = await prisma.chapter.findUnique({ where: { id: sec.chapterId }, include: { sections: { orderBy: { order: "asc" } } } });
  if (chapter && c && chapter.sections.every((s) => {
    const text = docPlainText(parseDoc(s.content));
    return !text.trim() || Boolean(s.summary && s.summaryHash === hashText(text));
  })) {
    const numbered = { ...chapter, label: c.label, sections: chapter.sections.map((s) => ({ ...s, label: c.sections.find((row) => row.id === s.id)?.label ?? "" })) };
    await ensureChapterSummary(sec.chapter.projectId, numbered);
  }
  return summary;
}

const pendingChapterSummary = singleFlight<string>();
async function ensureChapterSummary(projectId: string, c: Pick<BookChapter, "id" | "label" | "kind" | "title" | "summary" | "summaryHash"> & { sections: SummaryTarget[] }): Promise<string> {
  const sums = await mapLimit(c.sections, 3, (s) => ensureSectionSummary(projectId, c, s));
  const parts = c.sections.map((s, i) => (sums[i] ? `${s.label || "-"} ${s.title}: ${sums[i]}` : "")).filter(Boolean);
  if (!parts.length) return "";
  const joined = parts.join("\n");
  const h = hashText(joined);
  if (c.summary && c.summaryHash === h) return c.summary;
  const summary = await pendingChapterSummary(`${projectId}:${c.id}:${h}`, async () => {
    const latest = await prisma.chapter.findUnique({ where: { id: c.id }, select: { summary: true, summaryHash: true } });
    if (latest?.summary && latest.summaryHash === h) return latest.summary;
    const { messages } = await buildMessages("chapter-summary", {
      chapterNo: chapterName(c),
      chapterTitle: c.title,
      sectionSummaries: joined,
    });
    const r = await chat({ purpose: "chapter_summary", projectId, messages, temperature: 0.3, maxTokens: 6000 });
    const summary = r.text.trim();
    await prisma.chapter.updateMany({
      where: { id: c.id, AND: c.sections.map((s) => ({ sections: { some: { id: s.id, content: s.content } } })) },
      data: { summary, summaryHash: h },
    });
    return summary;
  });
  c.summary = summary;
  c.summaryHash = h;
  return summary;
}

/**
 * 가까운 절부터 필요한 2,500자만 확보한다. 예산이 차면 오래된 장은 조회·생성하지 않는다.
 */
async function previousSummaries(book: Book, chapterIdx: number, sectionIdx: number, signal?: AbortSignal) {
  const cur = book.chapters[chapterIdx];
  const items = [
    ...cur.sections.slice(0, sectionIdx).reverse().map((s) => async () => {
      const summary = await ensureSectionSummary(book.project.id, cur, s);
      return summary ? `[${s.label || ""} ${s.title}] ${summary}` : "";
    }),
    ...book.chapters.slice(0, chapterIdx).reverse().map((c) => async () => {
      const summary = await ensureChapterSummary(book.project.id, c);
      return summary ? `[${chapterName(c)} ${c.title}] ${summary}` : "";
    }),
  ];
  return collectRecentContext(items, 2500, signal);
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

/** status v: "truncated"(출력 한도) | "partial"(서버 시간 한도로 남은 파트를 쓰지 못함) | 진행 안내 문구 */
export type WriteEvent =
  | { t: "status"; v: string }
  | { t: "delta"; v: string }
  | { t: "done"; chars: number }
  | { t: "timing"; timing: WriteTiming }
  | { t: "error"; v: string }
  | { t: "resume"; fromPart: number; parts: OutlineParts };

export type WriteResume = { fromPart: number; written: string; parts: OutlineParts };

export type WriteOptions = {
  targetPages: number;
  mode: "overwrite" | "continue" | "newVersion";
  extraInstruction?: string;
  signal?: AbortSignal;
  /** 긴 절 자동 이어 쓰기 (같은 개요로 fromPart부터) */
  resume?: WriteResume;
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

type OutlineParts = z.infer<typeof outlineSchema>["parts"];
const pendingOutline = singleFlight<{ parts: OutlineParts; cached: boolean }>();
async function preparedOutline(sectionId: string, projectId: string, vars: Record<string, unknown>) {
  const om = await buildMessages("section-outline", vars);
  const { provider, baseUrl, model, reasoningEffort, maxOutputTokens } = await loadAiSettings("outline");
  // Include all rendered inputs and generation settings, but no credentials.
  const hash = createHash("sha256").update(JSON.stringify({ messages: om.messages, provider, baseUrl, model, reasoningEffort, maxOutputTokens })).digest("hex");
  const key = `ai:outline-cache:${sectionId}`;
  const read = async () => {
    const saved = await getSetting<{ hash: string; expires: number; parts: unknown }>(key);
    const parsed = outlineSchema.safeParse({ parts: saved?.parts });
    return saved?.hash === hash && saved.expires > Date.now() && parsed.success ? parsed.data.parts : null;
  };
  const saved = await read();
  if (saved) return { parts: saved, cached: true };
  return pendingOutline(`${key}:${hash}`, async () => {
    const existing = await read();
    if (existing) return { parts: existing, cached: true };
    const outline = await chatJson(outlineSchema, {
      purpose: "section_outline", projectId, messages: om.messages,
      temperature: 0.5, maxTokens: 8000, instructionIncluded: om.instructionIncluded,
    });
    const parts = outline.value?.parts;
    if (!parts) return { parts: [{ heading: "", points: [], sketchItems: [], chars: Number(vars.targetChars) }], cached: false };
    await setSetting(key, { hash, parts, expires: Date.now() + 24 * 60 * 60_000 }).catch(() => {
      console.warn("[outline-cache] 개요 캐시 저장 실패");
    });
    return { parts, cached: false };
  });
}

/** Prepares only the outline, never a draft or a version of the manuscript. */
export async function prepareSection(sectionId: string, opts: WriteOptions) {
  if (opts.targetPages <= 5) return { ready: false };
  const { projectId, baseVars } = await writeContext(sectionId, opts, new WriteClock());
  const result = await preparedOutline(sectionId, projectId, baseVars);
  return { ready: true, cached: result.cached };
}

/** 새 파트를 시작할 수 있는 마지막 시점 — AI 호출 예산(요청 시작 후 240초, client.ts) 안에 파트 하나(보통 1분 안팎)를 끝낼 수 있게 */
const PART_START_BUDGET_MS = 150_000;

/** 추론 토큰을 사용하는 모델도 본문을 마칠 수 있도록 출력 여유를 둔다. */
const writeTokens = (chars: number) => Math.min(Math.round(chars * 2.2 + 6000), 32000);

async function* pipe(gen: AsyncGenerator<string, { truncated?: boolean } | undefined>, onText: (t: string) => void): AsyncGenerator<WriteEvent> {
  let r = await gen.next();
  while (!r.done) {
    onText(r.value);
    yield { t: "delta", v: r.value };
    r = await gen.next();
  }
  if (r.value?.truncated) yield { t: "status", v: "truncated" };
}

async function writeContext(sectionId: string, opts: WriteOptions, clock: WriteClock) {
  const loadStarted = Date.now();
  const book = await sectionInBook(sectionId);
  const projectId = book.project.id;

  const flat = flatSections(book);
  const idx = flat.findIndex((f) => f.section.id === sectionId);
  const { chapter, section } = flat[idx];
  const ci = book.chapters.findIndex((c) => c.id === chapter.id);
  const si = chapter.sections.findIndex((s) => s.id === sectionId);
  const prev = flat[idx - 1];
  const next = flat[idx + 1];

  clock.loadMs = Date.now() - loadStarted;
  const summaryStarted = Date.now();
  const prevSummaries = await previousSummaries(book, ci, si, opts.signal);
  clock.summaryMs = Date.now() - summaryStarted;

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
    tocOutline: tocOutline(book),
    lastInChapter: si === chapter.sections.length - 1,
    extraInstruction: opts.extraInstruction,
    mode_continue: opts.mode === "continue",
    existingContent: opts.mode === "continue" ? docToMarkdown(existing).md.slice(-6000) : "",
  };
  return { projectId, baseVars, targetChars };
}

export async function* writeSection(sectionId: string, opts: WriteOptions): AsyncGenerator<WriteEvent> {
  const started = Date.now();
  const clock = new WriteClock();
  let result = "aborted";
  try {
    yield { t: "status", v: "앞 내용 정리 중…" };
    const { projectId, baseVars, targetChars } = await writeContext(sectionId, opts, clock);
    opts.signal?.throwIfAborted();
    let total = 0;
    const count = (t: string) => { clock.text(); total += t.length; };
    const track = async function* (events: AsyncGenerator<WriteEvent>) {
      for await (const event of events) {
        if (event.t === "status" && ["truncated", "partial"].includes(event.v)) result = event.v;
        yield event;
      }
    };

    if (opts.targetPages <= 5) {
      yield { t: "status", v: "구상 중… 문체와 앞뒤 흐름을 살펴보고 있습니다" };
      const { messages, instructionIncluded } = await buildMessages("section-write", baseVars);
      clock.startGeneration();
      yield* track(pipe(
        chatStream({ purpose: "section_write", projectId, messages, temperature: 0.7, maxTokens: writeTokens(targetChars), signal: opts.signal, instructionIncluded }),
        count,
      ));
    } else {
      // 긴 절: 개요 → 파트별 생성
      yield { t: "status", v: "긴 절의 집필 개요 준비 중…" };
      const outlineStarted = Date.now();
      // 이어 쓰기면 처음 요청의 개요를 그대로 쓴다 (같은 개요·같은 파트 프롬프트 → 한 번에 쓸 때와 같은 결과)
      const outline = opts.resume ? { parts: opts.resume.parts, cached: true } : await preparedOutline(sectionId, projectId, baseVars);
      clock.outlineMs = Date.now() - outlineStarted;
      clock.outlineCached = outline.cached;
      const parts = outline.parts;
      const from = opts.resume ? Math.min(opts.resume.fromPart, parts.length) : 0;
      let written = opts.resume?.written ?? "";
      for (let p = from; p < parts.length; p++) {
        if (opts.signal?.aborted) break;
        if (p > from && Date.now() - started > PART_START_BUDGET_MS) {
          // 한 번의 요청으로 쓸 수 있는 시간을 넘기기 전에 멈춘다 — 브라우저가 같은 개요로 다음 요청을 이어 보낸다(resume)
          yield { t: "resume", fromPart: p, parts };
          yield { t: "status", v: "partial" };
          result = "partial";
          break;
        }
        const part = parts[p];
        yield { t: "status", v: `집필 중… (${p + 1}/${parts.length}) ${part.heading}` };
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
        clock.startGeneration();
        yield* track(pipe(
          chatStream({ purpose: "section_write_part", projectId, messages, temperature: 0.7, maxTokens: writeTokens(part.chars), signal: opts.signal, instructionIncluded }),
          (t) => {
            count(t);
            written += t;
          },
        ));
      }
    }
    if (opts.signal?.aborted) result = "aborted";
    else if (result === "aborted") result = "ok";
    yield { t: "timing", timing: clock.snapshot() };
    yield { t: "done", chars: total };
  } catch (error) {
    result = opts.signal?.aborted ? "aborted" : "error";
    throw error;
  } finally {
    console.info("[write-timing]", JSON.stringify({ sectionId, result, ...clock.snapshot() }));
  }
}

/* ---------------- 분량 조정 ---------------- */

export async function* adjustLength(sectionId: string, targetChars: number, signal?: AbortSignal): AsyncGenerator<WriteEvent> {
  const { sec, project } = await sectionLite(sectionId);
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
  yield* pipe(
    chatStream({
      purpose: "length_adjust",
      projectId: project.id,
      messages,
      temperature: 0.5,
      maxTokens: writeTokens(Math.max(targetChars, current)),
      signal,
      instructionIncluded,
    }),
    (t) => (total += t.length),
  );
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

/** before가 해당 문단에 정확히 한 번 나와야 적용 가능 */
function splitValid<C extends { paragraph: number; before: string; after: string }>(blocks: string[], list: C[]) {
  const valid: C[] = [];
  const failed: C[] = [];
  for (const c of list) {
    const text = blocks[c.paragraph - 1];
    if (!text || !c.before || c.before === c.after) {
      failed.push(c);
      continue;
    }
    const first = text.indexOf(c.before);
    if (first < 0 || text.indexOf(c.before, first + 1) >= 0) failed.push(c);
    else valid.push(c);
  }
  return { valid, failed };
}

export async function proofread(sectionId: string, contentJson: string, level: "proof" | "light") {
  const { project } = await sectionLite(sectionId);
  const blocks = textblocks(parseDoc(contentJson)).map((b) => b.text);
  const glossary = glossaryText(project.glossary);
  const sig = signaturePhrases(project.styleProfile);

  // 약 2,000자 단위 문단 묶음, 동시에 3개
  const results = await mapLimit(chunkBlocks(blocks, 2000), 3, async (idxs) => {
    const { messages, instructionIncluded } = await buildMessages("proofread", {
      glossary,
      level_light_edit: level === "light",
      signaturePhrases: sig,
      numberedParagraphs: idxs.map((i) => `[${i + 1}] ${blocks[i]}`).join("\n"),
    });
    const r = await chatJson(proofSchema, { purpose: "proofread", projectId: project.id, messages, temperature: 0.1, maxTokens: 16000, instructionIncluded });
    return (r.value?.changes ?? []) as ProofChange[];
  });
  const { valid, failed } = splitValid(blocks, results.flat());
  return { changes: valid, failed };
}

/* ---------------- 선택 영역 부분 수정 ---------------- */

export async function rewriteSelection(
  sectionId: string,
  input: { action: string; before: string; selection: string; after: string; toneTarget?: string },
) {
  const { project } = await sectionLite(sectionId);
  const ratio = input.action === "expand" ? 1.5 : input.action === "shorten" ? 0.6 : 1;
  const { messages, instructionIncluded } = await buildMessages("rewrite-selection", {
    styleProfile: styleProfileText(project.styleProfile),
    glossary: glossaryText(project.glossary),
    ratio,
    toneTarget: input.toneTarget ?? "",
    action: input.action,
    before: input.before.slice(-800),
    selection: input.selection,
    after: input.after.slice(0, 800),
  });
  const r = await chat({
    purpose: "rewrite_" + input.action,
    projectId: project.id,
    messages,
    temperature: 0.6,
    maxTokens: Math.min(Math.round(input.selection.length * 3 + 6000), 24000),
    instructionIncluded,
  });
  return r.text.trim();
}

/* ---------------- 각주 ---------------- */

/** 작가가 고른 단어 하나에 붙일 각주 */
export async function writeFootnote(sectionId: string, input: { term: string; context: string; current?: string }) {
  const { project } = await sectionLite(sectionId);
  const { messages } = await buildMessages("footnote", {
    title: project.title,
    audience: project.audience,
    glossary: glossaryText(project.glossary),
    term: input.term.slice(0, 200),
    context: input.context.slice(0, 1200),
    current: input.current?.slice(0, 600) ?? "",
  });
  const r = await chat({ purpose: "footnote", projectId: project.id, messages, temperature: 0.3, maxTokens: 4000 });
  return r.text
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/^\s*(각주|주)\s*[:：]\s*/, "")
    .slice(0, 600);
}

export type AutoFootnote = { paragraph: number; term: string; note: string };

const autoFootnoteSchema = z.object({
  footnotes: z.array(z.object({ paragraph: z.coerce.number(), term: z.string(), note: z.string() })).default([]),
});

/** 절 전체에서 각주가 필요한 중요 키워드를 골라 각주를 쓴다. term이 해당 문단에 실제로 있는 것만 돌려준다. */
export async function autoFootnotes(sectionId: string, contentJson: string): Promise<AutoFootnote[]> {
  const { project } = await sectionLite(sectionId);
  const doc = parseDoc(contentJson);
  const blocks = textblocks(doc).map((b) => b.text);
  const existing = findFootnotes(doc)
    .map((f) => String(f.attrs?.term ?? ""))
    .filter(Boolean);
  const glossary = glossaryText(project.glossary);

  const results = await mapLimit(chunkBlocks(blocks, 5000), 3, async (idxs) => {
    const size = idxs.reduce((a, i) => a + blocks[i].length, 0);
    const { messages } = await buildMessages("footnote-auto", {
      title: project.title,
      audience: project.audience,
      glossary,
      existing: existing.join(", "),
      max: Math.max(1, Math.round(size / 1500)),
      numberedParagraphs: idxs.map((i) => `[${i + 1}] ${blocks[i]}`).join("\n"),
    });
    const r = await chatJson(autoFootnoteSchema, { purpose: "footnote_auto", projectId: project.id, messages, temperature: 0.2, maxTokens: 12000 });
    return r.value?.footnotes ?? [];
  });
  const seen = new Set(existing);
  return results.flat().filter((f) => {
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
  const r = await chatJson(z.record(z.string(), z.unknown()), { purpose: "style_analyze", projectId, messages, temperature: 0.3, maxTokens: 16000 });
  if (!r.value) throw new Error("문체 분석 응답을 해석하지 못했습니다.");
  return r.value;
}

/* ---------------- 장 단위 퇴고 ---------------- */

export type ChapterChange = {
  sectionId: string;
  sectionLabel: string;
  sectionTitle: string;
  paragraph: number;
  before: string;
  after: string;
  type: string;
  reason: string;
};

const reviseSchema = z.object({
  overview: z.string().default(""),
  changes: z
    .array(z.object({ id: z.string(), before: z.string(), after: z.string().default(""), type: z.string().default(""), reason: z.string().default("") }))
    .default([]),
});

/** 장의 절들을 한꺼번에 읽고 절 사이 중복·연결·흐름을 고치는 수정안 (적용은 작가가 고른 것만) */
export async function reviseChapter(chapterId: string, focus = "") {
  const ch = await prisma.chapter.findUnique({ where: { id: chapterId }, select: { projectId: true } });
  if (!ch) throw new Error("장을 찾을 수 없습니다.");
  const book = await loadBook(ch.projectId);
  const chapter = book?.chapters.find((c) => c.id === chapterId);
  if (!book || !chapter) throw new Error("장을 찾을 수 없습니다.");
  const blocksOf = chapter.sections.map((s) => textblocks(parseDoc(s.content)).map((b) => b.text));
  const total = blocksOf.flat().join("").length;
  if (total < 300) throw new Error("퇴고할 본문이 거의 없습니다. 절을 먼저 집필하세요.");
  if (total > 80000) throw new Error("장이 너무 깁니다(8만 자 초과). 절 단위 교정·교열을 쓰세요.");
  const numbered = chapter.sections
    .map((s, si) => {
      const lines = blocksOf[si].map((t, pi) => (t.trim() ? `[S${si + 1}-${pi + 1}] ${t}` : "")).filter(Boolean);
      return `### S${si + 1}. ${s.label} ${s.title}\n${lines.join("\n") || "(비어 있음)"}`;
    })
    .join("\n\n");
  const { messages, instructionIncluded } = await buildMessages("chapter-revise", {
    title: book.project.title,
    audience: book.project.audience,
    keyMessage: book.project.keyMessage,
    styleProfile: styleProfileText(book.project.styleProfile),
    glossary: glossaryText(book.project.glossary),
    maxChanges: Math.min(40, Math.max(8, Math.round(total / 1500))),
    chapterNo: chapterName(chapter),
    chapterTitle: chapter.title,
    chapterPromise: chapter.promise,
    focus: focus.slice(0, 500),
    numberedChapter: numbered,
  });
  const r = await chatJson(reviseSchema, { purpose: "chapter_revise", projectId: book.project.id, messages, temperature: 0.3, maxTokens: 24000, instructionIncluded });
  if (!r.value) throw new Error("퇴고 응답을 해석하지 못했습니다. 다시 시도하세요.");
  const valid: ChapterChange[] = [];
  const failed: ChapterChange[] = [];
  for (const c of r.value.changes) {
    const m = c.id.match(/S(\d+)\s*-\s*(\d+)/);
    const s = m ? chapter.sections[Number(m[1]) - 1] : undefined;
    const row: ChapterChange = {
      sectionId: s?.id ?? "",
      sectionLabel: s?.label ?? "",
      sectionTitle: s?.title ?? "",
      paragraph: m ? Number(m[2]) : 0,
      before: c.before,
      after: c.after,
      type: c.type,
      reason: c.reason,
    };
    if (!s) {
      failed.push(row);
      continue;
    }
    const check = splitValid(blocksOf[Number(m![1]) - 1], [row]);
    (check.valid.length ? valid : failed).push(row);
  }
  return { overview: r.value.overview, changes: valid, failed };
}

/* ---------------- 작가 수정에서 문체 배우기 ---------------- */

/** 절마다 가장 최근 AI 초안 원본(ai_output 버전)과 지금 본문을 비교한다 */
export async function projectEditStats(projectId: string) {
  const sections = await prisma.section.findMany({
    where: { chapter: { projectId } },
    select: { id: true, title: true, content: true, chapter: { select: { order: true, kind: true } }, order: true },
  });
  const drafts = await prisma.version.findMany({
    where: { reason: "ai_output", sectionId: { in: sections.map((s) => s.id) } },
    orderBy: { createdAt: "desc" },
    select: { sectionId: true, content: true, createdAt: true },
  });
  const latest = new Map<string, (typeof drafts)[number]>();
  for (const d of drafts) if (!latest.has(d.sectionId)) latest.set(d.sectionId, d);
  const rows: { sectionId: string; title: string; rate: number; aiChars: number; draftedAt: Date; pairs: EditPair[] }[] = [];
  for (const s of sections) {
    const d = latest.get(s.id);
    if (!d) continue;
    const ai = docPlainText(parseDoc(d.content));
    const now = docPlainText(parseDoc(s.content));
    if (!ai.trim()) continue;
    const st = editStats(ai, now);
    rows.push({ sectionId: s.id, title: s.title, rate: st.rate, aiChars: ai.length, draftedAt: d.createdAt, pairs: st.pairs });
  }
  const weight = rows.reduce((a, r) => a + r.aiChars, 0);
  const overall = weight ? Math.round((rows.reduce((a, r) => a + r.rate * r.aiChars, 0) / weight) * 10) / 10 : null;
  return { overall, rows };
}

const learnSchema = z.object({
  observations: z.array(z.string()).default([]),
  avoid: z.array(z.string()).default([]),
  prefer: z.array(z.string()).default([]),
  signaturePhrases: z.array(z.string()).default([]),
  sampleExcerpts: z.array(z.string()).default([]),
});
export type StyleLearning = z.infer<typeof learnSchema>;

/** 작가가 많이 고친 문장 짝을 모아 문체 프로필에 더할 규칙을 제안한다 (반영은 작가가 확인한 뒤) */
export async function learnFromEdits(projectId: string): Promise<StyleLearning & { pairs: number; editRate: number | null }> {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { styleProfile: true } });
  if (!project) throw new Error("프로젝트를 찾을 수 없습니다.");
  const stats = await projectEditStats(projectId);
  const pairs = pickLearningPairs(stats.rows.filter((r) => r.rate >= 5).flatMap((r) => r.pairs));
  if (pairs.length < 3) throw new Error("배울 만한 수정이 아직 적습니다. AI 초안을 직접 더 고친 뒤 다시 시도하세요.");
  const { messages } = await buildMessages("style-learn", {
    styleProfile: styleProfileText(project.styleProfile) || "(아직 없음)",
    editRate: stats.overall ?? 0,
    pairs: pairs.map((p, i) => `(${i + 1}) AI: ${p.ai}\n    작가: ${p.author}`).join("\n\n"),
  });
  const r = await chatJson(learnSchema, { purpose: "style_learn", projectId, messages, temperature: 0.3, maxTokens: 12000 });
  if (!r.value) throw new Error("문체 학습 응답을 해석하지 못했습니다.");
  return { ...r.value, pairs: pairs.length, editRate: stats.overall };
}
