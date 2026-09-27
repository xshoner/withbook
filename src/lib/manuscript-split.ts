/**
 * 기존 원고 가져오기 — 뽑아낸 줄을 제목 줄로 장·절로 나눈다.
 * 제목 줄 알아보기: 워드 제목 스타일(h1~h3)·마크다운 #, "제1장"·"1장"·"Chapter 1", "제1부", "프롤로그"류,
 * "1.1"(절), "1."(번호 제목, 1부터 차례로 늘어나는 것만). 어느 형식을 장·절로 쓸지는 자동으로 고르고 작가가 바꿀 수 있다.
 * 브라우저·서버·테스트 공용 (다른 앱 모듈을 불러오지 않는다).
 */

export type SrcLine = { text: string; level?: number };
export type HeadKind = "h1" | "h2" | "h3" | "jang" | "part" | "dec" | "num";
export type Pick = HeadKind | "auto" | "none";
export type SplitOptions = { chapter?: Pick; section?: Pick; joinLines?: boolean };
export type SplitSection = { title: string; md: string; chars: number };
export type SplitChapter = { title: string; kind: "front" | "body" | "back"; sections: SplitSection[] };
export type SplitResult = {
  chapters: SplitChapter[];
  detected: { chapter: HeadKind | "none"; section: HeadKind | "none" };
  candidates: { kind: HeadKind; label: string; count: number }[];
  warnings: string[];
  totalChars: number;
  titleGuess: string;
};

export const HEAD_LABEL: Record<HeadKind | "none", string> = {
  h1: "제목 1(워드 스타일·#)",
  h2: "제목 2(워드 스타일·##)",
  h3: "제목 3(워드 스타일·###)",
  jang: "“제1장·1장·Chapter 1”",
  part: "“제1부·Part 1”",
  dec: "“1.1 제목”",
  num: "“1. 제목”(차례 번호)",
  none: "나누지 않음",
};

export const MAX_CHAPTERS = 200;
export const MAX_SECTIONS = 1000;
const TITLE_MAX = 60;

const SPECIAL_FRONT = /^(프롤로그|prologue|들어가며|들어가는\s*글|머리말|머릿말|서문|여는\s*글|시작하며|작가의\s*말|저자의\s*말|추천사|추천의\s*글)$/i;
const SPECIAL_BACK = /^(에필로그|epilogue|나가며|나오며|나가는\s*글|맺음말|맺는\s*글|닫는\s*글|마치며|부록|감사의\s*글|참고\s*문헌|참고\s*자료|주석)$/i;
const SENTENCE_END = /(다|요|죠|까|네|라|자)[.!?…]["”’)]*$|[.!?…]["”’)]*$/;

type Head = { kind: HeadKind | "special"; num?: number; rest: string; special?: "front" | "back" };

const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12 };
const toNum = (s: string) => (/^\d+$/.test(s) ? Number(s) : ROMAN[s.toLowerCase()] ?? NaN);

/** 한 줄이 제목 줄이면 종류와 번호·나머지 글 */
export function classifyLine(line: SrcLine): Head | null {
  const text = line.text.trim();
  if (!text) return null;
  if (line.level && line.level >= 1) return { kind: (`h${Math.min(3, line.level)}` as HeadKind), rest: text };
  const md = text.match(/^(#{1,6})\s+(.+)$/);
  if (md) return { kind: (`h${Math.min(3, md[1].length)}` as HeadKind), rest: md[2].trim() };
  if (text.length > TITLE_MAX) return null;
  const sp = text.replace(/\s*[:：\-–—].*$/, "").replace(/[.\s]+$/, "");
  if (SPECIAL_FRONT.test(sp)) return { kind: "special", special: "front", rest: text };
  if (SPECIAL_BACK.test(sp)) return { kind: "special", special: "back", rest: text };
  let m = text.match(/^제\s*(\d+)\s*장(?![가-힣])\s*[.:·\-–—]?\s*(.*)$/) ?? text.match(/^(\d+)\s*장(?![가-힣])\s*[.:·\-–—]?\s*(.*)$/);
  if (m) return { kind: "jang", num: Number(m[1]), rest: m[2].trim() };
  m = text.match(/^chapter\s+(\d+|[ivx]+)\b\s*[.:\-–—]?\s*(.*)$/i);
  if (m) return { kind: "jang", num: toNum(m[1]), rest: m[2].trim() };
  m = text.match(/^제?\s*(\d+)\s*부(?![가-힣])\s*[.:·\-–—]?\s*(.*)$/) ?? text.match(/^part\s+(\d+|[ivx]+)\b\s*[.:\-–—]?\s*(.*)$/i);
  if (m) return { kind: "part", num: toNum(m[1]), rest: m[2].trim() };
  if (SENTENCE_END.test(text) && text.length > 12) return null; // 문장으로 끝나는 줄은 번호 목록이지 제목이 아니다
  m = text.match(/^(\d+)[.\-](\d+)\.?\s+(\S.*)$/);
  if (m) return { kind: "dec", num: Number(m[2]), rest: m[3].trim() };
  m = text.match(/^(\d+)[.)]\s+(\S.*)$/);
  if (m && text.length <= 40) return { kind: "num", num: Number(m[1]), rest: m[2].trim() };
  return null;
}

/** 차례대로 1, 2, 3…으로 늘어나는 번호 줄만 남긴다 (본문 속 번호 목록을 제목으로 오인하지 않게) — 새 범위에서는 1부터 */
function sequential(idx: number[], heads: (Head | null)[], resetAt: Set<number> = new Set()) {
  const resets = [...resetAt].sort((x, y) => x - y);
  const out = new Set<number>();
  let last = 0;
  let r = 0;
  for (const i of idx) {
    while (r < resets.length && resets[r] < i) {
      last = 0;
      r++;
    }
    const n = heads[i]?.num ?? NaN;
    if (n === last + 1) {
      out.add(i);
      last = n;
    }
  }
  return out;
}

/** PDF 줄 정리 — 쪽 번호만 있는 줄, 여러 쪽에 되풀이되는 머리글 줄을 뺀다 */
function dropNoise(lines: SrcLine[]): SrcLine[] {
  const freq = new Map<string, number>();
  for (const l of lines) {
    const t = l.text.trim();
    if (t && t.length <= 40) freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  return lines.filter((l) => {
    const t = l.text.trim();
    if (/^[-–—\s]*\d{1,4}[-–—\s]*$/.test(t)) return false;
    if (t && (freq.get(t) ?? 0) >= 5 && !classifyLine(l)) return false;
    return true;
  });
}

/** 본문 줄 → 제한형 마크다운(한 줄 = 한 문단). joinLines면 문장이 끝나지 않은 줄을 다음 줄과 잇는다(PDF 줄바꿈) */
function toMarkdown(lines: SrcLine[], joinLines: boolean): string {
  const out: string[] = [];
  let buf = "";
  const flush = () => {
    if (buf.trim()) out.push(buf.trim());
    buf = "";
  };
  for (const l of lines) {
    const t = l.text.trim();
    if (!t) {
      flush();
      continue;
    }
    const h = l.level ? t : t.match(/^#{1,6}\s+(.+)$/)?.[1];
    if (h) {
      flush();
      out.push(`## ${h.replace(/^#+\s*/, "")}`);
      continue;
    }
    if (!joinLines) {
      out.push(t);
      continue;
    }
    buf = buf ? `${buf} ${t}` : t;
    if (/[.!?…"”’)]$/.test(t)) flush();
  }
  flush();
  return out.join("\n");
}

const plainLen = (md: string) => md.replace(/^## /gm, "").replace(/\n/g, "").length;

function titleOf(h: Head, lines: SrcLine[], i: number, used: Set<number>): string {
  if (h.kind === "special") return h.rest.slice(0, TITLE_MAX);
  if (h.rest) return h.rest.replace(/^[.:·\-–—\s]+/, "").slice(0, TITLE_MAX);
  // "제1장"만 있는 줄 — 다음 짧은 줄을 제목으로
  for (let j = i + 1; j < lines.length && j <= i + 3; j++) {
    const t = lines[j].text.trim();
    if (!t) continue;
    if (t.length <= 40 && !SENTENCE_END.test(t) && !classifyLine(lines[j])) {
      used.add(j);
      return t;
    }
    break;
  }
  return h.kind === "jang" && h.num ? `${h.num}장` : "";
}

/** 장·절로 나누기 */
export function splitManuscript(input: SrcLine[], opts: SplitOptions = {}): SplitResult {
  const warnings: string[] = [];
  const lines = opts.joinLines ? dropNoise(input) : input;
  const heads = lines.map(classifyLine);
  const idxOf = (k: HeadKind) => heads.flatMap((h, i) => (h?.kind === k ? [i] : []));
  const count = (k: HeadKind) => (k === "num" ? sequential(idxOf("num"), heads).size : idxOf(k).length);
  const kinds: HeadKind[] = ["h1", "h2", "h3", "jang", "part", "dec", "num"];
  const candidates = kinds.map((kind) => ({ kind, label: HEAD_LABEL[kind], count: count(kind) })).filter((c) => c.count > 0);
  const specials = heads.flatMap((h, i) => (h?.kind === "special" ? [i] : []));

  let titleGuess = "";
  // 장 형식 고르기
  let chapter: HeadKind | "none" = "none";
  if (opts.chapter && opts.chapter !== "auto") chapter = opts.chapter;
  else if (count("h1") === 1 && count("h2") >= 2) {
    chapter = "h2"; // 제목 1이 하나뿐이면 책 제목으로 본다
    titleGuess = heads[idxOf("h1")[0]]!.rest;
  } else if (count("h1") >= 1) chapter = "h1";
  else if (count("jang") >= 2) chapter = "jang";
  else if (count("h2") >= 2) chapter = "h2";
  else if (count("part") >= 2) chapter = "part";
  else if (count("num") >= 2) chapter = "num";
  else if (count("dec") >= 2) chapter = "dec";

  const chapterIdx = new Set<number>(chapter === "none" ? [] : chapter === "num" ? sequential(idxOf("num"), heads) : idxOf(chapter));
  if (chapter !== "none") for (const i of specials) chapterIdx.add(i);

  // 절 형식 고르기 (장 안에서)
  const inChapters = (k: HeadKind) => idxOf(k).filter((i) => !chapterIdx.has(i));
  let section: HeadKind | "none" = "none";
  if (opts.section && opts.section !== "auto") section = opts.section === chapter ? "none" : opts.section;
  else {
    const order: HeadKind[] =
      chapter === "h1" ? ["h2", "h3", "dec", "num"] : chapter === "h2" ? ["h3", "dec", "num"] : chapter === "h3" ? ["dec", "num"] : chapter === "num" ? ["dec", "h1", "h2", "h3"] : ["h1", "h2", "h3", "dec", "num"];
    for (const k of order) {
      if (k === chapter) continue;
      const n = k === "num" ? sequential(inChapters("num"), heads, chapterIdx).size : inChapters(k).length;
      if (n >= (k.startsWith("h") ? 1 : 2)) {
        section = k;
        break;
      }
    }
  }
  const sectionIdx = new Set<number>(section === "none" ? [] : section === "num" ? sequential(inChapters("num"), heads, chapterIdx) : inChapters(section));

  // 책 제목 줄·부 제목 줄(장 형식이 아닐 때)은 본문에서 뺀다
  const skip = new Set<number>();
  if (titleGuess) skip.add(idxOf("h1")[0]);
  if (chapter !== "part" && section !== "part" && count("part")) {
    for (const i of idxOf("part")) skip.add(i);
    warnings.push(`부(部) 구분 ${count("part")}개는 장으로 만들지 않았습니다. 필요하면 장 제목에 붙이세요.`);
  }

  type Draft = { title: string; special?: "front" | "back"; sections: { title: string; lines: SrcLine[] }[] };
  const chapters: Draft[] = [];
  const preface: SrcLine[] = [];
  const used = new Set<number>();
  let cur: Draft | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (skip.has(i) || used.has(i)) continue;
    const h = heads[i];
    if (chapterIdx.has(i) && h) {
      cur = { title: titleOf(h, lines, i, used), special: h.kind === "special" ? h.special : undefined, sections: [] };
      chapters.push(cur);
      continue;
    }
    if (sectionIdx.has(i) && h) {
      if (!cur) {
        cur = { title: "본문", sections: [] };
        chapters.push(cur);
      }
      cur.sections.push({ title: titleOf(h, lines, i, used), lines: [] });
      continue;
    }
    if (!cur) {
      preface.push(lines[i]);
      continue;
    }
    if (!cur.sections.length) cur.sections.push({ title: "", lines: [] });
    cur.sections[cur.sections.length - 1].lines.push(lines[i]);
  }

  const join = !!opts.joinLines;
  const prefaceMd = toMarkdown(preface, join);
  if (!chapters.length) {
    chapters.push({ title: "본문", sections: [{ title: "", lines: preface }] });
    if (plainLen(prefaceMd)) warnings.push("장·절 제목 줄을 찾지 못해 원고 전체를 절 하나로 가져옵니다. 아래에서 나누는 기준을 바꿔 보세요.");
  } else if (plainLen(prefaceMd) > 200) {
    chapters.unshift({ title: "앞부분", special: "front", sections: [{ title: "", lines: preface }] });
    warnings.push("첫 장 제목 앞의 글은 ‘앞부분’ 장으로 가져옵니다. 필요 없으면 가져온 뒤 지우세요.");
  } else if (plainLen(prefaceMd)) {
    const first = preface.map((l) => l.text.trim()).find(Boolean) ?? "";
    if (!titleGuess && first.length <= 60) titleGuess = first;
    warnings.push(`첫 장 앞의 짧은 글(제목·저자 줄 등)은 가져오지 않습니다: “${prefaceMd.replace(/\n/g, " / ").slice(0, 80)}”`);
  }

  // 앞붙이·뒷붙이: 첫 본문 장 앞의 프롤로그류 → 앞붙이, 마지막 본문 장 뒤의 에필로그류 → 뒷붙이
  const firstBody = chapters.findIndex((c) => !c.special);
  const lastBody = chapters.length - 1 - [...chapters].reverse().findIndex((c) => !c.special);
  const out: SplitChapter[] = chapters.map((c, ci) => {
    const kind: SplitChapter["kind"] = firstBody < 0 ? "body" : c.special && ci < firstBody ? "front" : c.special && ci > lastBody ? "back" : "body";
    const sections = c.sections
      .map((s) => {
        const md = toMarkdown(s.lines, join);
        return { title: s.title, md, chars: plainLen(md) };
      })
      .filter((s, si, all) => s.chars > 0 || s.title || all.length === 1)
      .map((s) => ({ ...s, title: s.title || c.title || "본문" }));
    return { title: c.title || "제목 없는 장", kind, sections: sections.length ? sections : [{ title: c.title || "본문", md: "", chars: 0 }] };
  });

  const totalSections = out.reduce((a, c) => a + c.sections.length, 0);
  if (out.length > MAX_CHAPTERS) warnings.push(`장이 ${out.length}개로 너무 많습니다(최대 ${MAX_CHAPTERS}개). 나누는 기준을 바꾸세요.`);
  if (totalSections > MAX_SECTIONS) warnings.push(`절이 ${totalSections}개로 너무 많습니다(최대 ${MAX_SECTIONS}개). 나누는 기준을 바꾸세요.`);
  const big = out.flatMap((c) => c.sections).filter((s) => s.chars > 40000).length;
  if (big) warnings.push(`4만 자가 넘는 절이 ${big}개 있습니다. 편집이 느려질 수 있어 절을 더 나누기를 권합니다.`);
  const totalChars = out.reduce((a, c) => a + c.sections.reduce((b, s) => b + s.chars, 0), 0);
  return { chapters: out, detected: { chapter, section }, candidates, warnings, totalChars, titleGuess: titleGuess.slice(0, 100) };
}

/** mammoth HTML → 줄 (제목 스타일은 level로) */
export function htmlToLines(html: string): SrcLine[] {
  const out: SrcLine[] = [];
  const re = /<(h[1-6]|p|li|td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const tag = m[1].toLowerCase();
    const text = decodeEntities(m[2].replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, ""))
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    if (tag.startsWith("h")) out.push({ text, level: Number(tag[1]) });
    else out.push({ text: tag === "li" ? `- ${text}` : text });
  }
  return out;
}

function decodeEntities(s: string) {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

/** 평문 → 줄 */
export function textToLines(text: string): SrcLine[] {
  return text
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((t) => ({ text: t.replace(/[\t ]+/g, " ").trimEnd() }));
}

/** 절 목표 쪽수 (0.5쪽 단위) */
export const pagesFor = (chars: number, charsPerPage = 700) => Math.max(0.5, Math.round((chars / (charsPerPage || 700)) * 2) / 2);
