import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { prisma } from "../db";
import { fillContent, flatSections, loadBookOutline, type BookOutline } from "../book";
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
import { loadSectionReferences } from "../section-refs-store";
import { readMemoryText } from "../book-memory-store";
import { editedOutlineKey, outlineCacheKey, outlineInputHash, type EditedOutline, type OutlinePart } from "./outline-text";
import { getRequestContext } from "../request-context";
import { OUTLINE_DEADLINE_MS, SUMMARY_DEADLINE_MS, fallbackParts, isDeadlineError, partStart, timeLeft, withinTime } from "./write-budget";
import { cleanTocTitles, tocDesignText, withDetailPending, type TocChapter, type TocReportJson } from "./toc-steps";

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

export function glossaryText(glossary: GlossaryRow[]) {
  return glossary.map((g) => `- ${g.term} → ${g.preferred}${g.note ? ` (${g.note})` : ""}`).join("\n");
}

export function chapterName(c: { label: string; kind: string }) {
  return c.label || (c.kind === "front" ? "앞붙이" : "뒷붙이");
}

/** 전체 목차 — 절마다 같은 글이어야 system 프롬프트가 캐시된다(현재 절 표시는 user 메시지에) */
function tocOutline(book: BookOutline) {
  return book.chapters
    .map((c) => {
      const head = `${c.label ? c.label + " " : ""}${c.title}${c.promise ? ` — ${c.promise}` : ""}`;
      const secs = c.sections.map((s) => `   ${s.label ? s.label + " " : "- "}${s.title}${s.gist ? `: ${s.gist}` : ""}`).join("\n");
      return head + (secs ? "\n" + secs : "");
    })
    .join("\n");
}

function bookVars(book: BookOutline) {
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
    bookMemory: p.bookMemory,
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

/**
 * 절과 책 구조 (집필처럼 목차·앞뒤 절이 필요한 작업) — 절 본문은 빼고 읽는다.
 * 본문은 쓰는 곳에서 fillContent()로 필요한 절(현재 절·앞 절·요약을 확인할 절)만 읽는다.
 */
async function sectionInBook(sectionId: string) {
  const sec = await prisma.section.findUnique({ where: { id: sectionId }, select: { chapter: { select: { projectId: true } } } });
  if (!sec) throw new Error("절을 찾을 수 없습니다.");
  const book = await loadBookOutline(sec.chapter.projectId);
  if (!book) throw new Error("책을 찾을 수 없습니다.");
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
  return { sec, project: { ...sec.chapter.project, bookMemory: await readMemoryText(sec.chapter.projectId) } };
}

/* ---------------- 목차 설계 ---------------- */

const tocChapterSchema = z.object({
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
});

const tocSchema = z.object({
  concept: z.string(),
  flow: z.string().default(""),
  chapters: z.array(tocChapterSchema).min(1),
  readerHooks: z.array(z.string()).default([]),
  differentiation: z.array(z.string()).default([]),
  estimatedPages: z.coerce.number().default(0),
  frontMatter: z.array(z.string()).default([]),
  backMatter: z.array(z.string()).default([]),
});
export type TocDesign = z.infer<typeof tocSchema>;

/** 장 하나만 돌려받는 응답 (세부 설계·[이 장만 다시]) — 나머지 항목은 보지 않는다 */
const tocOneChapterSchema = z.object({ chapters: z.array(tocChapterSchema).min(1) });

/*
 * 목차 설계는 요청 여러 개로 나눈다 (toc-steps.ts) — 예전처럼 한 번에(출력 24,000토큰) 만들면 장·절이 많은 책은
 * 서버 시간 한도(약 4분)에 걸렸다. 골격 한 번 + 장마다 세부 한 번이며 각각 출력이 작아 한 요청 안에 끝난다.
 */
const TOC_SKELETON_TOKENS = 12000;
const TOC_CHAPTER_TOKENS = 10000;

async function tocBookVars(projectId: string) {
  const book = await loadBookOutline(projectId);
  if (!book) throw new Error("책을 찾을 수 없습니다.");
  return { book, vars: bookVars(book) };
}

/** 1단계: 목차 골격 (설계 근거·절 요지·흥미 포인트 없이) — 저장할 보고서에는 모든 장이 세부 설계 대기로 표시된다 */
export async function designTocSkeleton(
  projectId: string,
  opts: { regenerate?: boolean; previousConcept?: string } = {},
): Promise<{ design?: TocDesign & { detailPending: number[] }; raw: string; error?: string }> {
  const { vars } = await tocBookVars(projectId);
  const { messages } = await buildMessages("toc-design", { ...vars, skeleton: true, regenerate: opts.regenerate, previousConcept: opts.previousConcept });
  const { value: design, raw } = await chatJson(tocSchema, { purpose: "toc_design", projectId, messages, temperature: 0.8, maxTokens: TOC_SKELETON_TOKENS });
  if (!design) return { raw, error: "목차 응답을 해석하지 못했습니다. 원문을 확인하세요." };
  cleanTocTitles(design.chapters);
  return { design: withDetailPending(design), raw };
}

/**
 * 장 하나 — mode "detail": 골격(report)의 그 장에 설계 근거와 절 요지·흥미 포인트를 채운다(제목·분량은 그대로).
 * mode "redesign": [이 장만 다시] — 그 장을 새로 설계한다. 나머지 목차는 보고서(report)에서, 없으면 책의 지금 목차에서 읽는다.
 */
export async function designTocChapter(
  projectId: string,
  opts: { chapterIndex: number; mode: "detail" | "redesign"; report?: Pick<TocReportJson, "chapters"> | null },
): Promise<{ chapter?: TocChapter; raw: string; error?: string }> {
  const { book, vars } = await tocBookVars(projectId);
  const { messages } = await buildMessages("toc-design", {
    ...vars,
    detailOnly: opts.mode === "detail",
    chapterOnly: opts.mode === "redesign",
    chapterIndex: opts.chapterIndex,
    currentToc: opts.report ? tocDesignText(opts.report) : tocOutline(book),
  });
  const { value, raw } = await chatJson(tocOneChapterSchema, { purpose: "toc_design", projectId, messages, temperature: opts.mode === "detail" ? 0.6 : 0.8, maxTokens: TOC_CHAPTER_TOKENS });
  const chapter = value?.chapters[0];
  if (!chapter) return { raw, error: `${opts.chapterIndex}장 설계 응답을 해석하지 못했습니다. 다시 시도하세요.` };
  cleanTocTitles([chapter]);
  return { chapter, raw };
}

/* ---------------- 요약 (앞 내용 연결용) ---------------- */

/** content가 undefined면 아직 읽지 않은 본문 — 요약이 필요할 때 읽는다 */
type SummaryTarget = { id: string; label: string; title: string; content?: string; summary: string | null; summaryHash: string | null };
const pendingSectionSummary = singleFlight<string>();

async function ensureSectionSummary(projectId: string, c: { label: string; kind: string }, s: SummaryTarget): Promise<string> {
  await fillContent([s]);
  const content = s.content ?? "";
  const text = docPlainText(parseDoc(content));
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
    await prisma.section.updateMany({ where: { id: s.id, content }, data: { summary, summaryHash: h } });
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
type ChapterTarget = { id: string; label: string; kind: string; title: string; summary: string | null; summaryHash: string | null; sections: SummaryTarget[] };
export async function ensureChapterSummary(projectId: string, c: ChapterTarget): Promise<string> {
  await fillContent(c.sections); // 장의 절 본문을 한 번에 읽는다(요약이 최신인지 확인용)
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
      where: { id: c.id, AND: c.sections.map((s) => ({ sections: { some: { id: s.id, content: s.content ?? "" } } })) },
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
 * deadline(epoch ms)까지만 기다린다 — 그때까지 준비되지 않은 요약은 빼고 쓴다(요약은 계속 만들어져 다음 집필에 쓰인다).
 * 요약 하나가 실패해도(AI 서버 혼잡 등) 집필 전체를 실패시키지 않고 그 요약만 뺀다.
 */
async function previousSummaries(book: BookOutline, chapterIdx: number, sectionIdx: number, signal?: AbortSignal, deadline?: number) {
  const cur = book.chapters[chapterIdx];
  const optional = (label: string, run: () => Promise<string>) => async () => {
    try {
      return await run();
    } catch (e) {
      if (signal?.aborted) throw e;
      console.warn(`[write] 앞 내용 요약을 건너뜀 (${label}):`, e instanceof Error ? e.message : e);
      return "";
    }
  };
  const items = [
    ...cur.sections.slice(0, sectionIdx).reverse().map((s) => optional(s.id, async () => {
      const summary = await ensureSectionSummary(book.project.id, cur, s);
      return summary ? `[${s.label || ""} ${s.title}] ${summary}` : "";
    })),
    ...book.chapters.slice(0, chapterIdx).reverse().map((c) => optional(c.id, async () => {
      const summary = await ensureChapterSummary(book.project.id, c);
      return summary ? `[${chapterName(c)} ${c.title}] ${summary}` : "";
    })),
  ];
  return collectRecentContext(items, 2500, signal, deadline);
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
/**
 * 긴 절 개요 — 같은 프롬프트·모델 설정으로 만든 개요가 24시간 안에 있으면 다시 쓴다(ai:outline-cache:{절 id}).
 * force: 캐시를 보지 않고 새로 만든다(작가가 [개요 다시 만들기]를 누른 경우). inputHash: 무엇을 보고 만들었는지(오래된 개요 표시용)
 */
async function preparedOutline(sectionId: string, projectId: string, vars: Record<string, unknown>, opts: { force?: boolean; inputHash?: string } = {}) {
  const om = await buildMessages("section-outline", vars);
  const { provider, baseUrl, model, reasoningEffort, maxOutputTokens } = await loadAiSettings("outline");
  // Include all rendered inputs and generation settings, but no credentials.
  const hash = createHash("sha256").update(JSON.stringify({ messages: om.messages, provider, baseUrl, model, reasoningEffort, maxOutputTokens })).digest("hex");
  const key = outlineCacheKey(sectionId);
  const read = async () => {
    const saved = await getSetting<{ hash: string; expires: number; parts: unknown }>(key);
    const parsed = outlineSchema.safeParse({ parts: saved?.parts });
    return saved?.hash === hash && saved.expires > Date.now() && parsed.success ? parsed.data.parts : null;
  };
  if (!opts.force) {
    const saved = await read();
    if (saved) return { parts: saved, cached: true };
  }
  return pendingOutline(`${key}:${hash}${opts.force ? ":force" : ""}`, async () => {
    if (!opts.force) {
      const existing = await read();
      if (existing) return { parts: existing, cached: true };
    }
    const outline = await chatJson(outlineSchema, {
      purpose: "section_outline", projectId, messages: om.messages,
      temperature: 0.5, maxTokens: 8000, instructionIncluded: om.instructionIncluded,
    });
    const parts = outline.value?.parts;
    if (!parts) return { parts: fallbackParts(Number(vars.targetChars), String(vars.sketch ?? "")), cached: false };
    await setSetting(key, { hash, parts, expires: Date.now() + 24 * 60 * 60_000, ...(opts.inputHash ? { inputHash: opts.inputHash } : {}) }).catch(() => {
      console.warn("[outline-cache] 개요 캐시 저장 실패");
    });
    return { parts, cached: false };
  });
}

/** 작가가 고친 개요 — 있으면 새로 쓰기·새 버전 집필이 이 개요를 그대로 쓴다(개요를 만들지도, 캐시로 덮어쓰지도 않는다) */
export async function loadEditedOutline(sectionId: string): Promise<EditedOutline | null> {
  const v = await getSetting<EditedOutline>(editedOutlineKey(sectionId), { fresh: true });
  const parsed = outlineSchema.safeParse({ parts: v?.parts });
  return v && parsed.success ? { ...v, parts: parsed.data.parts } : null;
}

/** Prepares only the outline, never a draft or a version of the manuscript. */
export async function prepareSection(sectionId: string, opts: WriteOptions) {
  if (opts.targetPages <= 5) return { ready: false };
  if (opts.mode !== "continue" && (await loadEditedOutline(sectionId))) return { ready: true, cached: true };
  const { projectId, baseVars, inputHash } = await writeContext(sectionId, opts, new WriteClock());
  const result = await preparedOutline(sectionId, projectId, baseVars, { inputHash });
  return { ready: true, cached: result.cached };
}

/**
 * 지금 개요를 새로 만든다 (POST /api/sections/[id]/outline) — 캐시를 보지 않는다.
 * sketch: 아직 저장하지 않은 스케치로 만들 때. targetPages가 없으면 절에 저장된 목표 쪽수
 */
export async function generateOutline(sectionId: string, input: { sketch?: string; targetPages?: number; signal?: AbortSignal } = {}): Promise<{ parts: OutlinePart[]; inputHash: string }> {
  let targetPages = Number(input.targetPages);
  if (!Number.isFinite(targetPages) || targetPages <= 0) {
    const sec = await prisma.section.findUnique({ where: { id: sectionId }, select: { targetPages: true } });
    targetPages = sec?.targetPages || 3;
  }
  const opts: WriteOptions = { targetPages, mode: "overwrite", signal: input.signal };
  const { projectId, baseVars, inputHash } = await writeContext(sectionId, opts, new WriteClock(), { sketch: input.sketch });
  const r = await preparedOutline(sectionId, projectId, baseVars, { force: true, inputHash });
  return { parts: r.parts, inputHash };
}

/** 요청 시작 시각 — AI 호출 예산(240초, client.ts)과 같은 기준으로 잰다. 파트 시작 한도 등은 write-budget.ts */
const requestStartedAt = () => getRequestContext()?.startedAt ?? Date.now();

/** 본문을 하나도 받지 못하고 시간 한도에 걸렸을 때 — 준비한 요약·개요는 저장돼 있어 다시 시도하면 곧바로 본문부터 쓴다 */
const WRITE_DEADLINE_MSG =
  "AI 서버 응답이 늦어 이번 요청의 실행 시간(약 4분) 안에 본문을 시작하지 못했습니다. 앞 내용 요약과 개요는 저장돼 있어 다시 시도하면 바로 본문부터 씁니다. 잠시 후 [집필하기]를 다시 눌러 주세요.";

/** 추론 토큰을 사용하는 모델도 본문을 마칠 수 있도록 출력 여유를 둔다. */
const writeTokens = (chars: number) => Math.min(Math.round(chars * 2.2 + 6000), 32000);

/** prefix: 첫 본문 조각 앞에 붙일 글(파트 소제목) — 본문이 오지 않으면(시간 한도로 resume) 내보내지 않아 같은 소제목이 두 번 들어가지 않는다 */
async function* pipe(
  gen: AsyncGenerator<string, { truncated?: boolean } | undefined>,
  onText: (t: string) => void,
  prefix?: { text: string; onEmit: (t: string) => void },
): AsyncGenerator<WriteEvent> {
  let r = await gen.next();
  while (!r.done) {
    if (prefix?.text) {
      prefix.onEmit(prefix.text);
      yield { t: "delta", v: prefix.text };
      prefix = undefined;
    }
    onText(r.value);
    yield { t: "delta", v: r.value };
    r = await gen.next();
  }
  if (r.value?.truncated) yield { t: "status", v: "truncated" };
}

async function writeContext(sectionId: string, opts: WriteOptions, clock: WriteClock, override: { sketch?: string } = {}) {
  const loadStarted = Date.now();
  const summaryDeadline = requestStartedAt() + SUMMARY_DEADLINE_MS;
  const book = await sectionInBook(sectionId);
  const projectId = book.project.id;

  const flat = flatSections(book);
  const idx = flat.findIndex((f) => f.section.id === sectionId);
  const { chapter, section } = flat[idx];
  const ci = book.chapters.findIndex((c) => c.id === chapter.id);
  const si = chapter.sections.findIndex((s) => s.id === sectionId);
  const prev = flat[idx - 1];
  const next = flat[idx + 1];
  // 본문은 이 절과 앞 절만 읽는다 (앞 내용 요약에 필요한 절은 previousSummaries가 가까운 순으로 읽는다)
  await fillContent(prev ? [section, prev.section] : [section]);
  const refs = await loadSectionReferences(sectionId);
  const sketch = typeof override.sketch === "string" ? override.sketch : section.sketch;

  clock.loadMs = Date.now() - loadStarted;
  const summaryStarted = Date.now();
  const prevSummaries = await previousSummaries(book, ci, si, opts.signal, summaryDeadline);
  clock.summaryMs = Date.now() - summaryStarted;

  const cpp = book.project.charsPerPage || 700;
  const targetChars = Math.round(opts.targetPages * cpp);
  const existing = parseDoc(section.content ?? "");
  const baseVars = {
    ...bookVars(book),
    chapterNo: chapterName(chapter),
    chapterTitle: chapter.title,
    sectionNo: section.label || "",
    sectionTitle: section.title,
    sectionGist: section.gist,
    previousSummaries: prevSummaries,
    previousTail: prev ? tailOf(prev.section.content ?? "") || "(앞 절 미작성)" : "(책의 첫 절)",
    nextGist: next ? `${next.section.title}: ${next.section.gist}` : "(마지막 절)",
    sketch,
    sectionReferences: refs.block,
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
  const inputHash = outlineInputHash({ sketch, targetPages: opts.targetPages, title: section.title, gist: section.gist, refIds: refs.ids });
  return { projectId, baseVars, targetChars, inputHash };
}

/**
 * 긴 절 개요 — OUTLINE_DEADLINE_MS(요청 시작 기준)까지만 기다린다. 늦거나 시간 한도에 걸리면 분량만 나눈 기본 개요로 쓴다.
 * 늦은 개요 호출은 그대로 두어 끝나면 캐시에 남는다(다음 집필·[개요 다시 만들기]가 쓴다).
 */
async function outlineInTime(sectionId: string, projectId: string, vars: Record<string, unknown>, inputHash: string, started: number) {
  const fallback = () => ({ parts: fallbackParts(Number(vars.targetChars), String(vars.sketch ?? "")), cached: false });
  try {
    const r = await withinTime(preparedOutline(sectionId, projectId, vars, { inputHash }), timeLeft(started, OUTLINE_DEADLINE_MS));
    if (r.done) return r.value;
    console.warn(`[write] 개요가 늦어 기본 나눔으로 씀 (${sectionId})`);
    return fallback();
  } catch (e) {
    if (!isDeadlineError(e)) throw e;
    console.warn(`[write] 개요가 시간 한도에 걸려 기본 나눔으로 씀 (${sectionId})`);
    return fallback();
  }
}

export async function* writeSection(sectionId: string, opts: WriteOptions): AsyncGenerator<WriteEvent> {
  const started = requestStartedAt();
  const clock = new WriteClock();
  let result = "aborted";
  try {
    yield { t: "status", v: "앞 내용 정리 중…" };
    const { projectId, baseVars, targetChars, inputHash } = await writeContext(sectionId, opts, clock);
    opts.signal?.throwIfAborted();
    // 작가가 고친 개요 — 새로 쓰기·새 버전이면 분량과 상관없이 그 개요대로 파트를 나눠 쓴다(이어쓰기는 기존 본문 뒤라 쓰지 않는다)
    const edited = opts.mode !== "continue" && !opts.resume ? await loadEditedOutline(sectionId) : null;
    let total = 0;
    const count = (t: string) => { clock.text(); total += t.length; };
    const track = async function* (events: AsyncGenerator<WriteEvent>) {
      for await (const event of events) {
        if (event.t === "status" && ["truncated", "partial"].includes(event.v)) result = event.v;
        yield event;
      }
    };

    if (opts.targetPages <= 5 && !edited) {
      yield { t: "status", v: "구상 중… 문체와 앞뒤 흐름을 살펴보고 있습니다" };
      const { messages, instructionIncluded } = await buildMessages("section-write", baseVars);
      clock.startGeneration();
      yield* track(pipe(
        chatStream({ purpose: "section_write", projectId, messages, temperature: 0.7, maxTokens: writeTokens(targetChars), signal: opts.signal, instructionIncluded }),
        count,
      ));
    } else {
      // 긴 절: 개요 → 파트별 생성
      yield { t: "status", v: edited ? "작가가 고친 개요로 집필 준비 중…" : "긴 절의 집필 개요 준비 중…" };
      const outlineStarted = Date.now();
      // 이어 쓰기면 처음 요청의 개요를 그대로 쓴다 (같은 개요·같은 파트 프롬프트 → 한 번에 쓸 때와 같은 결과)
      const outline = opts.resume
        ? { parts: opts.resume.parts, cached: true }
        : edited
          ? { parts: edited.parts, cached: true }
          : await outlineInTime(sectionId, projectId, baseVars, inputHash, started);
      clock.outlineMs = Date.now() - outlineStarted;
      clock.outlineCached = outline.cached;
      const parts = outline.parts;
      const from = opts.resume ? Math.min(opts.resume.fromPart, parts.length) : 0;
      let written = opts.resume?.written ?? "";
      for (let p = from; p < parts.length; p++) {
        if (opts.signal?.aborted) break;
        if (partStart(Date.now() - started, p, from) === "resume") {
          // 한 번의 요청으로 쓸 수 있는 시간을 넘기기 전에 멈춘다 — 브라우저가 같은 개요로 다음 요청을 이어 보낸다(resume)
          // 준비(요약·개요)가 길어 첫 파트도 시작하지 못했으면 이 요청의 첫 파트부터 넘긴다 — 새 요청은 준비 없이 곧바로 쓴다
          yield { t: "resume", fromPart: p, parts };
          yield { t: "status", v: "partial" };
          result = "partial";
          break;
        }
        const part = parts[p];
        yield { t: "status", v: `집필 중… (${p + 1}/${parts.length}) ${part.heading}` };
        // 소제목은 본문 첫 조각과 함께 내보낸다 (본문 없이 시간 한도에 걸려 다음 요청이 이 파트를 다시 쓸 때 소제목이 겹치지 않게)
        const heading = part.heading ? `${written ? "\n\n" : ""}## ${part.heading}\n\n` : "";
        const lastPara = written.trim().split(/\n+/).filter((l) => l.trim() && !l.startsWith("## ")).slice(-1)[0] ?? "";
        const partInfo = [
          `[이번 파트] ${part.heading || "(소제목 없음)"} / 다룰 내용: ${part.points.join("; ") || "(개요 없음)"} / 배정된 스케치: ${part.sketchItems.join("; ") || "(없음)"} / 분량 약 ${part.chars}자`,
          p > 0 ? `앞 파트 마지막 문단: ${lastPara}\n절 도입부를 다시 쓰지 말고 앞 파트에서 자연스럽게 이어 쓴다.` : "이 파트는 절의 도입부다.",
          p === parts.length - 1 ? "이 파트에서 절을 마무리한다." : "이 파트에서 절을 마무리하지 않는다.",
          "소제목은 앱이 붙이므로 출력하지 않는다.",
        ].join("\n");
        const { messages, instructionIncluded } = await buildMessages("section-write", { ...baseVars, partInfo });
        clock.startGeneration();
        try {
          yield* track(pipe(
            chatStream({ purpose: "section_write_part", projectId, messages, temperature: 0.7, maxTokens: writeTokens(part.chars), signal: opts.signal, instructionIncluded }),
            (t) => {
              count(t);
              written += t;
            },
            { text: heading, onEmit: (h) => (written += h) },
          ));
        } catch (e) {
          // 앞 파트를 쓴 뒤 이 파트가 본문 없이 시간 한도에 걸렸다 — 쓴 데까지 두고 새 요청에서 이 파트부터 쓴다
          if (!isDeadlineError(e) || p === from || opts.signal?.aborted) throw e;
          yield { t: "resume", fromPart: p, parts };
          yield { t: "status", v: "partial" };
          result = "partial";
          break;
        }
      }
    }
    if (opts.signal?.aborted) result = "aborted";
    else if (result === "aborted") result = "ok";
    yield { t: "timing", timing: clock.snapshot() };
    yield { t: "done", chars: total };
  } catch (error) {
    result = opts.signal?.aborted ? "aborted" : "error";
    if (!opts.signal?.aborted && isDeadlineError(error)) throw Object.assign(new Error(WRITE_DEADLINE_MSG), { expose: true, status: 504, httpStatus: 504 });
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

/** 교정 한 번에 보내는 본문 분량(자, 문단 경계 기준) */
export const PROOF_BATCH_CHARS = 5000;

/** range: 이 문단 범위(1부터, 양끝 포함)만 교정 — 긴 절을 요청 여러 개로 나눠 서버 시간 한도 안에 끝내려고. 문단 번호는 절 전체 기준 그대로 */
export async function proofread(sectionId: string, contentJson: string, level: "proof" | "light", range?: { from: number; to: number }) {
  const { project } = await sectionLite(sectionId);
  const blocks = textblocks(parseDoc(contentJson)).map((b) => b.text);
  const glossary = glossaryText(project.glossary);
  const sig = signaturePhrases(project.styleProfile);
  const inRange = (i: number) => !range || (i + 1 >= range.from && i + 1 <= range.to);

  // 문단 경계로 약 5,000자씩 묶어 보낸다 — 묶음마다 system 프롬프트(작가 서술 규칙 instruction.md 포함)가 다시 가므로
  // 묶음을 크게 해 보내는 횟수를 줄인다. 출력 한도(16,000토큰)는 5,000자 묶음의 수정안을 담기에 넉넉하다. 동시에 3개
  const results = await mapLimit(chunkBlocks(blocks.map((t, i) => (inRange(i) ? t : "")), PROOF_BATCH_CHARS), 3, async (idxs) => {
    const { messages, instructionIncluded } = await buildMessages("proofread", {
      glossary,
      bookMemory: project.bookMemory,
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
  input: { action: string; before: string; selection: string; after: string; toneTarget?: string; instruction?: string },
) {
  const { project } = await sectionLite(sectionId);
  const ratio = input.action === "expand" ? 1.5 : input.action === "shorten" ? 0.6 : 1;
  const { messages, instructionIncluded } = await buildMessages("rewrite-selection", {
    styleProfile: styleProfileText(project.styleProfile),
    glossary: glossaryText(project.glossary),
    bookMemory: project.bookMemory,
    ratio,
    toneTarget: input.toneTarget ?? "",
    action: input.action,
    // 작가가 직접 쓴 지시(custom) — system이 아니라 user 메시지에 넣어 system 프롬프트 캐시를 지킨다
    customInstruction: input.action === "custom" ? (input.instruction ?? "") : "",
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
  const book = await loadBookOutline(ch.projectId);
  const chapter = book?.chapters.find((c) => c.id === chapterId);
  if (!book || !chapter) throw new Error("장을 찾을 수 없습니다.");
  await fillContent(chapter.sections); // 이 장의 절 본문만 읽는다
  const blocksOf = chapter.sections.map((s) => textblocks(parseDoc(s.content ?? "")).map((b) => b.text));
  const total = blocksOf.flat().join("").length;
  if (total < 300) throw Object.assign(new Error("퇴고할 본문이 거의 없습니다. 절을 먼저 집필하세요."), { status: 400 });
  if (total > 80000) throw Object.assign(new Error("장이 너무 깁니다(8만 자 초과). 절 단위 교정·교열을 쓰세요."), { status: 400 });
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
    bookMemory: book.project.bookMemory,
    maxChanges: Math.min(40, Math.max(8, Math.round(total / 1500))),
    chapterNo: chapterName(chapter),
    chapterTitle: chapter.title,
    chapterPromise: chapter.promise,
    focus: focus.slice(0, 500),
    numberedChapter: numbered,
  });
  const r = await chatJson(reviseSchema, { purpose: "chapter_revise", projectId: book.project.id, messages, temperature: 0.3, maxTokens: 24000, instructionIncluded });
  if (!r.value) throw Object.assign(new Error("퇴고 응답을 해석하지 못했습니다. 다시 시도하세요."), { expose: true, httpStatus: 502 });
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
  if (!project) throw new Error("책을 찾을 수 없습니다.");
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
