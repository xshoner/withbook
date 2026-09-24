import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./backup";
import { supabaseAdmin, storageConfigured } from "./supabase/admin";

/**
 * 파일 저장소 — 웹 배포(Supabase 설정 있음)는 Supabase Storage, 로컬은 data/storage 폴더.
 * 버킷: assets(원고 이미지) · style-reference(문체 학습 자료) · exports(내보낸 PDF·HWPX·백업) · incoming(업로드 대기) · fonts(공개 글꼴)
 */
export type Bucket = "assets" | "style-reference" | "exports" | "incoming" | "fonts";

const safeKey = (key: string) => {
  if (!key || key.includes("..") || key.startsWith("/") || /[\\\0]/.test(key)) throw Object.assign(new Error("잘못된 파일 경로입니다."), { status: 400 });
  return key;
};
const localPath = (bucket: Bucket, key: string) => path.join(dataDir(), "storage", bucket, safeKey(key));

export async function putObject(bucket: Bucket, key: string, data: Buffer, contentType = "application/octet-stream") {
  if (storageConfigured()) {
    const { error } = await supabaseAdmin().storage.from(bucket).upload(safeKey(key), data, { contentType, upsert: true });
    if (error) throw new Error(`파일 저장 실패: ${error.message}`);
    return;
  }
  const p = localPath(bucket, key);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, data);
}

export async function getObject(bucket: Bucket, key: string): Promise<Buffer | null> {
  // 예전(로컬) 이미지 경로 호환: 절대 경로면 디스크에서 읽는다
  if (path.isAbsolute(key)) return fs.readFile(key).catch(() => null);
  if (storageConfigured()) {
    const { data, error } = await supabaseAdmin().storage.from(bucket).download(safeKey(key));
    if (error || !data) return null;
    return Buffer.from(await data.arrayBuffer());
  }
  return fs.readFile(localPath(bucket, key)).catch(() => null);
}

export async function removeObjects(bucket: Bucket, keys: string[]) {
  const list = keys.filter((k) => k && !path.isAbsolute(k)).map(safeKey);
  if (!list.length) return;
  if (storageConfigured()) {
    await supabaseAdmin().storage.from(bucket).remove(list);
    return;
  }
  await Promise.all(list.map((k) => fs.rm(localPath(bucket, k), { force: true })));
}

export async function listObjects(bucket: Bucket, prefix = ""): Promise<{ name: string; size: number }[]> {
  if (storageConfigured()) {
    const { data, error } = await supabaseAdmin().storage.from(bucket).list(prefix, { limit: 1000, sortBy: { column: "name", order: "asc" } });
    if (error) throw new Error(`파일 목록 실패: ${error.message}`);
    return (data ?? []).filter((f) => f.id).map((f) => ({ name: f.name, size: Number(f.metadata?.size ?? 0) }));
  }
  const dir = path.join(dataDir(), "storage", bucket, prefix);
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  return Promise.all(names.map(async (n) => ({ name: n, size: (await fs.stat(path.join(dir, n))).size })));
}

/** 내려받기 주소 — 웹은 10분짜리 서명 URL, 로컬은 null (호출자가 직접 응답) */
export async function signedDownloadUrl(bucket: Bucket, key: string, filename: string): Promise<string | null> {
  if (!storageConfigured()) return null;
  const { data, error } = await supabaseAdmin().storage.from(bucket).createSignedUrl(safeKey(key), 600, { download: filename });
  if (error || !data) throw new Error(`내려받기 주소를 만들지 못했습니다: ${error?.message}`);
  return data.signedUrl;
}

/** 브라우저가 서버를 거치지 않고 직접 올릴 서명 업로드 주소 (Vercel 요청 크기 4.5MB 제한 회피) */
export async function signedUploadUrl(key: string) {
  const { data, error } = await supabaseAdmin().storage.from("incoming").createSignedUploadUrl(safeKey(key));
  if (error || !data) throw new Error(`업로드 주소를 만들지 못했습니다: ${error?.message}`);
  return { path: data.path, token: data.token };
}
