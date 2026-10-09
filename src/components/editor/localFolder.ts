"use client";

import { useSyncExternalStore } from "react";
import { del, get, set as idbSet } from "idb-keyval";
import { REF_EXT } from "@/lib/ai/section-refs";
import { buildFolderIndex, FOLDER_MAX_BYTES, FOLDER_MAX_FILES, pickFolderRefs, type FolderIndex } from "@/lib/ai/folder-refs";

/**
 * 내 폴더 자료 — 작가 PC의 폴더를 브라우저가 직접 읽는다. 파일은 서버에 올리지 않고 이 탭의 메모리에만 둔다.
 * 자동 집필이 절마다 가까운 대목만 골라(folder-refs.ts) 집필 요청에 함께 보낸다.
 * Chrome·Edge는 고른 폴더(핸들)를 IndexedDB에 남겨 새로 고친 뒤에도 허락만 받고 다시 읽는다. 그 밖의 브라우저는 폴더를 다시 고른다.
 */

export type FolderInfo = { projectId: string; name: string; files: number; chars: number; skipped: string[] };
type State = { info: FolderInfo | null; reading: string };

let state: State = { info: null, reading: "" };
let index: FolderIndex | null = null;
const subs = new Set<() => void>();
const setState = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
};
export const useLocalFolder = () =>
  useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => {
        subs.delete(f);
      };
    },
    () => state,
    () => state,
  );

const handleKey = (projectId: string) => `local-folder:${projectId}`;

type DirHandle = {
  name: string;
  kind: "directory";
  values(): AsyncIterable<DirHandle | { kind: "file"; name: string; getFile(): Promise<File> }>;
  queryPermission(o: { mode: "read" }): Promise<PermissionState>;
  requestPermission(o: { mode: "read" }): Promise<PermissionState>;
};
const picker = () => (typeof window !== "undefined" ? (window as unknown as { showDirectoryPicker?: (o: object) => Promise<DirHandle> }).showDirectoryPicker : undefined);
/** 폴더 핸들을 쓸 수 있는 브라우저(Chrome·Edge) — 아니면 <input webkitdirectory>로 고른다 */
export const canPickFolder = () => !!picker();

const ext = (name: string) => name.slice(name.lastIndexOf(".")).toLowerCase();
const skipName = (name: string) => name.startsWith(".") || name.startsWith("~$") || name === "node_modules";

async function* walk(dir: DirHandle, path: string): AsyncGenerator<{ path: string; file: () => Promise<File> }> {
  for await (const h of dir.values()) {
    if (skipName(h.name)) continue;
    if (h.kind === "directory") yield* walk(h, `${path}${h.name}/`);
    else if (REF_EXT.includes(ext(h.name))) yield { path: `${path}${h.name}`, file: () => h.getFile() };
  }
}

/** 한글 txt는 UTF-8이 아니면 EUC-KR(CP949)로 읽는다 */
function decode(buf: ArrayBuffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("euc-kr").decode(buf);
  }
}

async function fileText(file: File): Promise<string> {
  const e = ext(file.name);
  const buf = await file.arrayBuffer();
  if (e === ".txt" || e === ".md") return decode(buf);
  if (e === ".pdf") {
    const { getDocumentProxy, extractText } = await import("unpdf");
    const { text } = await extractText(await getDocumentProxy(new Uint8Array(buf)), { mergePages: true });
    return text;
  }
  if (e === ".docx") {
    const mammoth = await import("mammoth");
    return (await mammoth.extractRawText({ arrayBuffer: buf })).value;
  }
  if (e === ".hwpx") {
    // 서버의 style/reference.ts extractText와 같은 방식 (문단 <hp:p> → <hp:t> 글)
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(buf);
    const out: string[] = [];
    for (const f of Object.keys(zip.files).filter((f) => /^Contents\/section\d+\.xml$/.test(f)).sort()) {
      const xml = await zip.file(f)!.async("string");
      for (const p of xml.split(/<\/hp:p>/)) {
        const t = [...p.matchAll(/<hp:t[^>]*>([^<]*)<\/hp:t>/g)].map((m) => m[1]).join("");
        if (t.trim()) out.push(t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&"));
      }
    }
    return out.join("\n");
  }
  return "";
}

async function load(projectId: string, name: string, entries: AsyncIterable<{ path: string; file: () => Promise<File> }> | Iterable<{ path: string; file: () => Promise<File> }>) {
  const files: { name: string; text: string }[] = [];
  const skipped: string[] = [];
  let chars = 0;
  setState({ reading: "파일 찾는 중…" });
  try {
    for await (const en of entries) {
      if (files.length >= FOLDER_MAX_FILES) {
        skipped.push(`${en.path} (파일 ${FOLDER_MAX_FILES}개 초과)`);
        continue;
      }
      setState({ reading: `읽는 중… ${files.length + 1}번째 · ${en.path}` });
      try {
        const f = await en.file();
        if (f.size > FOLDER_MAX_BYTES) {
          skipped.push(`${en.path} (${Math.round(FOLDER_MAX_BYTES / 1024 / 1024)}MB 초과)`);
          continue;
        }
        const text = (await fileText(f)).trim();
        if (!text) {
          skipped.push(`${en.path} (글 없음 — 스캔 PDF?)`);
          continue;
        }
        files.push({ name: en.path, text });
        chars += text.length;
      } catch {
        skipped.push(`${en.path} (읽기 실패)`);
      }
    }
    if (!files.length) throw new Error("폴더에서 읽을 수 있는 자료(txt·md·pdf·docx·hwpx)를 찾지 못했습니다.");
    index = buildFolderIndex(files);
    setState({ info: { projectId, name, files: files.length, chars, skipped } });
  } finally {
    setState({ reading: "" });
  }
}

async function loadHandle(projectId: string, dir: DirHandle) {
  await load(projectId, dir.name, walk(dir, ""));
}

/** 폴더 고르기(Chrome·Edge) — 취소하면 false */
export async function pickLocalFolder(projectId: string): Promise<boolean> {
  let dir: DirHandle;
  try {
    dir = await picker()!({ id: "withbook-refs", mode: "read" });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") return false;
    throw e;
  }
  await loadHandle(projectId, dir);
  await idbSet(handleKey(projectId), dir).catch(() => {});
  return true;
}

/** <input type="file" webkitdirectory>로 고른 파일들 (핸들이 없는 브라우저) */
export async function loadLocalFiles(projectId: string, list: FileList) {
  const all = [...list];
  const rel = (f: File) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
  const name = rel(all[0] ?? new File([], "폴더")).split("/")[0];
  const entries = all
    .filter((f) => REF_EXT.includes(ext(f.name)) && !rel(f).split("/").some(skipName))
    .map((f) => ({ path: rel(f).split("/").slice(1).join("/") || f.name, file: async () => f }));
  await load(projectId, name, entries);
}

/** 지난번에 고른 폴더 이름 (다시 열기 버튼용) */
export async function storedFolderName(projectId: string): Promise<string | null> {
  if (!canPickFolder()) return null;
  return ((await get<DirHandle>(handleKey(projectId)).catch(() => undefined)) ?? null)?.name ?? null;
}

/**
 * 지난번에 고른 폴더를 다시 읽는다 — 읽기 허락이 없으면 묻는다(버튼을 누른 직후에만 물을 수 있다). 못 열면 false
 */
export async function restoreLocalFolder(projectId: string): Promise<boolean> {
  if (localFolderReady(projectId)) return true;
  const dir = canPickFolder() ? await get<DirHandle>(handleKey(projectId)).catch(() => undefined) : undefined;
  if (!dir) return false;
  try {
    if ((await dir.queryPermission({ mode: "read" })) !== "granted" && (await dir.requestPermission({ mode: "read" })) !== "granted") return false;
    await loadHandle(projectId, dir);
    return true;
  } catch {
    return false;
  }
}

export function clearLocalFolder(projectId: string) {
  index = null;
  setState({ info: null });
  void del(handleKey(projectId)).catch(() => {});
}

export const localFolderReady = (projectId: string) => !!index && state.info?.projectId === projectId;

/** 이 절과 가까운 대목 — 폴더를 읽지 않았으면 빈 목록 */
export const localFolderRefs = (projectId: string, query: string) => (index && localFolderReady(projectId) ? pickFolderRefs(index, query) : []);
