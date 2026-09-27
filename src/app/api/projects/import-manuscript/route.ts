import path from "node:path";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { fail, getRequestUser, handle, ok } from "@/lib/api";
import { readUpload } from "@/lib/uploads";
import { extractText } from "@/lib/style/reference";
import { charCount, markdownToDoc } from "@/lib/doc/doc";
import { readGlobalStyle } from "@/lib/style/global";
import { DEFAULT_LAYOUT } from "@/lib/layout";
import { htmlToLines, MAX_CHAPTERS, MAX_SECTIONS, pagesFor, splitManuscript, textToLines, type Pick, type SplitResult, type SrcLine } from "@/lib/manuscript-split";

export const maxDuration = 300;

/**
 * 기존 원고 가져오기 (docx·hwpx·pdf·txt·md → 새 책의 장·절). 두 단계:
 *   1) 분석: multipart file(큰 파일은 incoming 업로드 경로 filePath+fileName) → 글을 뽑아 AppSetting
 *      `manuscript-import:{token}`에 하루 보관하고 나눈 구조를 미리 보여 준다.
 *      JSON { token, chapter?, section? } → 나누는 기준을 바꿔 다시 미리 보기(파일을 다시 올리지 않는다)
 *   2) 확정: JSON { token, confirm: true, title, author?, chapter?, section? } → 새 책을 만들고 { id }
 * 미리 보기 응답: { token, fileName, title, detected, candidates, chapters: [{ title, kind, sections: [{ title, chars, preview }] }], totalChars, warnings }
 */

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_TEXT = 3_000_000;
const EXT = new Set([".docx", ".hwpx", ".pdf", ".txt", ".md"]);
const PICKS = new Set<Pick>(["auto", "none", "h1", "h2", "h3", "jang", "part", "dec", "num"]);
const key = (token: string) => `manuscript-import:${token}`;

type Stored = { name: string; lines: SrcLine[]; joinLines: boolean; userId: string; createdAt: string };

const pickOf = (v: unknown): Pick => (typeof v === "string" && PICKS.has(v as Pick) ? (v as Pick) : "auto");

async function linesFrom(name: string, buf: Buffer): Promise<{ lines: SrcLine[]; joinLines: boolean }> {
  const ext = path.extname(name).toLowerCase();
  if (ext === ".docx") {
    const mammoth = await import("mammoth");
    const r = await mammoth.convertToHtml({ buffer: buf });
    return { lines: htmlToLines(r.value), joinLines: false };
  }
  const text = await extractText(name, buf, { keepAll: true });
  return { lines: textToLines(text), joinLines: ext === ".pdf" };
}

function preview(token: string, stored: Stored, r: SplitResult) {
  const base = stored.name.replace(/\.[^.]+$/, "");
  return {
    token,
    fileName: stored.name,
    title: r.titleGuess || base,
    detected: r.detected,
    candidates: r.candidates,
    chapters: r.chapters.map((c) => ({
      title: c.title,
      kind: c.kind,
      sections: c.sections.map((s) => ({ title: s.title, chars: s.chars, preview: s.md.replace(/^## /gm, "").replace(/\n/g, " ").slice(0, 90) })),
    })),
    totalChars: r.totalChars,
    warnings: r.warnings,
  };
}

async function loadStored(token: unknown): Promise<Stored> {
  if (typeof token !== "string" || !/^[a-f0-9-]{36}$/.test(token)) throw Object.assign(new Error("가져오기 정보가 올바르지 않습니다. 파일을 다시 올려주세요."), { status: 400 });
  const row = await prisma.appSetting.findUnique({ where: { key: key(token) } });
  if (!row) throw Object.assign(new Error("가져오기 정보가 만료되었습니다(하루 보관). 파일을 다시 올려주세요."), { status: 404 });
  const v = JSON.parse(row.value) as Stored;
  const me = getRequestUser()?.id ?? "";
  if (v.userId && me && v.userId !== me) throw Object.assign(new Error("가져오기 정보를 찾을 수 없습니다."), { status: 404 });
  return v;
}

export const POST = handle(async (req: Request) => {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = await readUpload(form, "file", MAX_BYTES).catch((e) => {
      if (e?.status === 413) throw Object.assign(new Error("원고 파일은 50MB 이하로 올려주세요."), { status: 413 });
      throw e;
    });
    if (!file) return fail("원고 파일이 없습니다.");
    if (!EXT.has(path.extname(file.name).toLowerCase())) return fail("docx·hwpx·pdf·txt·md 파일만 가져올 수 있습니다.");
    let got: { lines: SrcLine[]; joinLines: boolean };
    try {
      got = await linesFrom(file.name, file.buffer);
    } catch (e: any) {
      console.warn("[import-manuscript] 글 뽑기 실패", file.name, e?.message);
      return fail("파일에서 글을 읽지 못했습니다. 파일이 손상되었거나 암호가 걸려 있는지 확인하세요.");
    }
    const total = got.lines.reduce((a, l) => a + l.text.length, 0);
    if (!got.lines.some((l) => l.text.trim())) return fail("파일에서 글을 찾지 못했습니다. 스캔한 PDF라면 글자를 인식할 수 없습니다.");
    if (total > MAX_TEXT) return fail(`원고가 너무 깁니다(${total.toLocaleString()}자). ${MAX_TEXT.toLocaleString()}자 이하로 나눠서 가져오세요.`, 413);
    const token = randomUUID();
    const stored: Stored = { name: path.basename(file.name).slice(0, 200), lines: got.lines, joinLines: got.joinLines, userId: getRequestUser()?.id ?? "", createdAt: new Date().toISOString() };
    await prisma.appSetting.create({ data: { key: key(token), value: JSON.stringify(stored) } });
    return ok(preview(token, stored, splitManuscript(stored.lines, { joinLines: stored.joinLines })));
  }

  const b = await req.json();
  const stored = await loadStored(b.token);
  const r = splitManuscript(stored.lines, { joinLines: stored.joinLines, chapter: pickOf(b.chapter), section: pickOf(b.section) });
  if (!b.confirm) return ok(preview(b.token, stored, r));

  // 확정 — 새 책 만들기
  const title = String(b.title ?? "").trim().slice(0, 200);
  if (!title) return fail("책 제목을 입력하세요.");
  const sectionCount = r.chapters.reduce((a, c) => a + c.sections.length, 0);
  if (r.chapters.length > MAX_CHAPTERS || sectionCount > MAX_SECTIONS) return fail("장·절이 너무 많습니다. 나누는 기준을 바꾸세요.");
  const g = await readGlobalStyle();
  const layout = { ...DEFAULT_LAYOUT, colophon: { ...DEFAULT_LAYOUT.colophon } };
  const cpp = 700;
  const project = await prisma.project.create({
    data: {
      title,
      author: String(b.author ?? "").trim().slice(0, 100),
      targetPages: Math.max(50, Math.round(r.totalChars / cpp / 10) * 10 || 200),
      extra: `기존 원고 「${stored.name}」에서 가져옴`,
      styleProfile: g ? JSON.stringify(g.profile) : null,
      layout: JSON.stringify(layout),
    },
  });
  try {
    // 장 순서: 앞붙이 → 본문 → 뒷붙이 (나눈 순서 그대로면 이미 이 순서다)
    let order = 0;
    for (const c of r.chapters) {
      await prisma.chapter.create({
        data: {
          projectId: project.id,
          order: ++order,
          kind: c.kind,
          title: c.title.slice(0, 200),
          sections: {
            create: c.sections.map((s, i) => {
              const doc = markdownToDoc(s.md);
              const chars = charCount(doc);
              return {
                order: i + 1,
                title: s.title.slice(0, 200),
                targetPages: pagesFor(chars, cpp),
                status: chars ? "editing" : "empty",
                content: chars ? JSON.stringify(doc) : "",
                charCount: chars,
              };
            }),
          },
        },
      });
    }
  } catch (e) {
    await prisma.project.delete({ where: { id: project.id } }).catch(() => {});
    throw e;
  }
  await prisma.appSetting.deleteMany({ where: { key: key(b.token) } });
  return ok({ id: project.id, chapters: r.chapters.length, sections: sectionCount });
});
