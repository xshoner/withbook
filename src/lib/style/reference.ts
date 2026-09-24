import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { getObject, listObjects, putObject, removeObjects } from "../storage";
import { storageConfigured } from "../supabase/admin";

/**
 * style reference 자료(또는 업로드 파일)에서 텍스트를 뽑아 문체 분석용 코퍼스를 만든다.
 * 웹 배포: Supabase Storage style-reference 버킷(한글 파일명은 base64url 키로 저장) / 로컬: style reference 폴더
 */

export type RefKind = "book" | "sns" | "transcript" | "other";
export type RefDoc = { name: string; kind: RefKind; text: string; chars: number };

const EXT = new Set([".txt", ".md", ".pdf", ".docx", ".hwpx"]);

export function referenceDir() {
  return path.resolve(/* turbopackIgnore: true */ process.cwd(), process.env.STYLE_REFERENCE_DIR ?? "./style reference");
}

const toKey = (name: string) => Buffer.from(name, "utf8").toString("base64url");
const fromKey = (key: string) => {
  try {
    return Buffer.from(key, "base64url").toString("utf8");
  } catch {
    return key;
  }
};
export const referenceExtOk = (name: string) => EXT.has(path.extname(name).toLowerCase());

export async function listReferenceFiles() {
  if (storageConfigured()) {
    const files = (await listObjects("style-reference")).map((f) => ({ name: fromKey(f.name), size: f.size })).filter((f) => referenceExtOk(f.name));
    return { dir: "저장소(style-reference)", files };
  }
  const dir = referenceDir();
  try {
    const names = await fs.readdir(/* turbopackIgnore: true */ dir);
    const files = await Promise.all(
      names
        .filter((n) => EXT.has(path.extname(n).toLowerCase()))
        .map(async (n) => ({ name: n, size: (await fs.stat(path.join(/* turbopackIgnore: true */ dir, n))).size })),
    );
    return { dir, files };
  } catch {
    return { dir, files: [] as { name: string; size: number }[] };
  }
}

export async function extractText(name: string, buf: Buffer): Promise<string> {
  const ext = path.extname(name).toLowerCase();
  if (ext === ".txt" || ext === ".md") return buf.toString("utf8").replace(/^﻿/, "");
  if (ext === ".pdf") {
    const { getDocumentProxy, extractText } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = text as string[];
    // 앞붙이·뒷붙이(표지, 판권, 목차) 영향을 줄이기 위해 앞 6쪽·뒤 4쪽 제외
    const body = pages.length > 20 ? pages.slice(6, -4) : pages;
    return body.join("\n");
  }
  if (ext === ".docx") {
    const mammoth = await import("mammoth");
    const r = await mammoth.extractRawText({ buffer: buf });
    return r.value;
  }
  if (ext === ".hwpx") {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(buf);
    const secs = Object.keys(zip.files)
      .filter((f) => /^Contents\/section\d+\.xml$/.test(f))
      .sort();
    const out: string[] = [];
    for (const f of secs) {
      const xml = await zip.file(f)!.async("string");
      for (const p of xml.split(/<\/hp:p>/)) {
        const t = [...p.matchAll(/<hp:t[^>]*>([^<]*)<\/hp:t>/g)].map((m) => m[1]).join("");
        if (t.trim()) out.push(decodeXml(t));
      }
    }
    return out.join("\n");
  }
  return "";
}

function decodeXml(s: string) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function classify(name: string, text: string): RefKind {
  if (/\.pdf$/i.test(name) || /\.hwpx$/i.test(name) || /\.docx$/i.test(name)) return "book";
  if (/참석자\s*\d+\s+\d{1,2}:\d{2}/.test(text)) return "transcript";
  return "sns";
}

function clean(kind: RefKind, text: string) {
  let t = text.replace(/\r\n?/g, "\n");
  if (kind === "transcript") {
    t = t
      .split("\n")
      .filter((l) => !/^\s*참석자\s*\d+\s+[\d:]+\s*$/.test(l) && !/^\s*\d{4}\.\d{2}\.\d{2}/.test(l))
      .join("\n");
  }
  if (kind === "book") {
    // PDF 줄바꿈 이어 붙이기: 문장이 끝나지 않은 줄은 다음 줄과 합친다
    t = t.replace(/([^.!?"”’\n])\n(?=[^\n])/g, "$1 ");
    t = t.replace(/^\s*\d{1,3}\s*$/gm, ""); // 쪽 번호
  }
  return t.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

async function readReference(name: string) {
  if (storageConfigured()) return getObject("style-reference", toKey(name));
  return fs.readFile(path.join(/* turbopackIgnore: true */ referenceDir(), name)).catch(() => null);
}

/** 문체 학습 자료 추가 (같은 이름이면 바꿔 넣는다) */
export async function addReferenceFile(name: string, buf: Buffer) {
  if (!referenceExtOk(name)) throw Object.assign(new Error(`${name}: txt·md·pdf·docx·hwpx 파일만 넣을 수 있습니다.`), { status: 400 });
  const safe = path.basename(name).slice(0, 180);
  if (storageConfigured()) return putObject("style-reference", toKey(safe), buf);
  const dir = referenceDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(/* turbopackIgnore: true */ dir, safe), buf);
}

export async function removeReferenceFile(name: string) {
  const safe = path.basename(name);
  if (storageConfigured()) return removeObjects("style-reference", [toKey(safe)]);
  await fs.rm(path.join(/* turbopackIgnore: true */ referenceDir(), safe), { force: true });
}

export async function loadReferenceDocs(): Promise<RefDoc[]> {
  const { files } = await listReferenceFiles();
  const docs: RefDoc[] = [];
  for (const f of files) {
    try {
      const buf = await readReference(f.name);
      if (!buf) continue;
      const raw = await extractText(f.name, buf);
      const kind = classify(f.name, raw);
      const text = clean(kind, raw);
      if (text.length > 100) docs.push({ name: f.name, kind, text, chars: text.length });
    } catch (e) {
      console.error("style reference read failed", f.name, e);
    }
  }
  return docs;
}

const KIND_LABEL: Record<RefKind, string> = {
  book: "출간 도서",
  sns: "SNS·짧은 글",
  transcript: "강연 녹취",
  other: "기타",
};

/** 문서 전체에서 고르게 문단을 뽑아 예산 안에서 코퍼스를 만든다 (출간 도서 비중을 크게) */
export function buildCorpus(docs: RefDoc[], totalBudget = 45000) {
  const weight: Record<RefKind, number> = { book: 3, sns: 1.2, transcript: 1, other: 1 };
  const wsum = docs.reduce((s, d) => s + weight[d.kind], 0) || 1;
  const parts: string[] = [];
  for (const d of docs) {
    const budget = Math.round((totalBudget * weight[d.kind]) / wsum);
    const paras = d.text
      .split(/\n+/)
      .map((p) => p.trim())
      .filter((p) => p.length >= (d.kind === "sns" ? 30 : 80));
    const picked: string[] = [];
    if (paras.length) {
      // 연속된 문단 묶음(흐름 파악용)을 여러 지점에서 고르게 뽑는다
      const blockSize = d.kind === "book" ? 4 : 2;
      const avg = paras.reduce((s, p) => s + p.length, 0) / paras.length;
      const blocks = Math.max(1, Math.floor(budget / (avg * blockSize)));
      const step = Math.max(blockSize, Math.floor(paras.length / blocks));
      let len = 0;
      for (let i = 0; i < paras.length && len < budget; i += step) {
        for (let j = i; j < Math.min(i + blockSize, paras.length) && len < budget; j++) {
          picked.push(paras[j]);
          len += paras[j].length;
        }
        picked.push("…");
      }
    }
    parts.push(`### [${KIND_LABEL[d.kind]}] ${d.name}\n${picked.join("\n")}`);
  }
  return parts.join("\n\n");
}
