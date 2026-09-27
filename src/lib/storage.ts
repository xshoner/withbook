import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { supabaseAdmin, storageConfigured } from "./supabase/admin";
import { webMode } from "./security";

/** 로컬 데이터 폴더 (로컬 저장소 모드의 data/storage 등) */
export const dataDir = () => path.resolve(/* turbopackIgnore: true */ process.env.DATA_DIR || path.join(process.cwd(), "data"));

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
  // 예전(로컬) 이미지 경로 호환: 절대 경로면 디스크에서 읽는다 — 로컬 모드에서만 (웹 배포는 서버 파일을 읽지 않는다)
  if (path.isAbsolute(key)) {
    if (storageConfigured() || webMode()) return null;
    return fs.readFile(key).catch(() => null);
  }
  if (storageConfigured()) {
    const { data, error } = await supabaseAdmin().storage.from(bucket).download(safeKey(key));
    if (error || !data) return null;
    return Buffer.from(await data.arrayBuffer());
  }
  return fs.readFile(localPath(bucket, key)).catch(() => null);
}

/** 저장소 안 복사 — 웹은 Supabase copy(서버 간 복사, 내려받지 않음), 로컬·예전 절대 경로는 읽어서 쓴다. 원본이 없으면 false */
export async function copyObject(bucket: Bucket, from: string, to: string, contentType = "application/octet-stream"): Promise<boolean> {
  if (storageConfigured() && !path.isAbsolute(from)) {
    const { error } = await supabaseAdmin().storage.from(bucket).copy(safeKey(from), safeKey(to));
    if (!error) return true;
    if (/not.?found/i.test(error.message)) return false;
    throw new Error(`파일 복사 실패: ${error.message}`);
  }
  if (!path.isAbsolute(from)) {
    const dest = localPath(bucket, to);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    return fs.copyFile(localPath(bucket, from), dest).then(() => true, (e) => {
      if (e?.code === "ENOENT") return false;
      throw e;
    });
  }
  const buf = await getObject(bucket, from);
  if (!buf) return false;
  await putObject(bucket, to, buf, contentType);
  return true;
}

/** 동시 실행 수를 제한한 map (저장소 요청을 한꺼번에 몰아 보내지 않도록) — 결과 순서는 입력 순서 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return out;
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

/** 이미지 표시용 서명 URL (기본 1시간) — 웹만, 로컬은 null */
export async function signedViewUrl(bucket: Bucket, key: string, expiresIn = 3600): Promise<string | null> {
  if (!storageConfigured() || path.isAbsolute(key)) return null;
  const { data, error } = await supabaseAdmin().storage.from(bucket).createSignedUrl(safeKey(key), expiresIn);
  if (error || !data) return null;
  return data.signedUrl;
}

/** 브라우저가 서버를 거치지 않고 직접 올릴 서명 업로드 주소 (Vercel 요청 크기 4.5MB 제한 회피) */
export async function signedUploadUrl(key: string) {
  const { data, error } = await supabaseAdmin().storage.from("incoming").createSignedUploadUrl(safeKey(key));
  if (error || !data) throw new Error(`업로드 주소를 만들지 못했습니다: ${error?.message}`);
  return { path: data.path, token: data.token };
}

/**
 * 오래된 파일 지우기 (일일 정리용) — 버킷 안을 폴더까지 훑어 olderThanMs보다 오래된 파일을 지운다. 지운 개수 반환.
 * 웹: Supabase 목록의 created_at 기준(폴더는 id 없음), 로컬: 파일 수정 시각 기준. 한 번에 최대 5,000개까지만 본다.
 */
export async function purgeOldObjects(bucket: Bucket, olderThanMs: number, prefix = ""): Promise<number> {
  const cutoff = Date.now() - olderThanMs;
  const old: string[] = [];
  const LIMIT = 5000;
  if (storageConfigured()) {
    const store = supabaseAdmin().storage.from(bucket);
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 4 || old.length >= LIMIT) return;
      const { data, error } = await store.list(dir, { limit: 1000 });
      if (error) throw new Error(`파일 목록 실패: ${error.message}`);
      for (const f of data ?? []) {
        const key = dir ? `${dir}/${f.name}` : f.name;
        if (!f.id) await walk(key, depth + 1);
        else if (Date.parse(f.created_at ?? f.updated_at ?? "") < cutoff) old.push(key);
      }
    };
    await walk(prefix, 0);
    for (let i = 0; i < old.length; i += 100) await store.remove(old.slice(i, i + 100));
    return old.length;
  }
  const root = path.join(dataDir(), "storage", bucket);
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4 || old.length >= LIMIT) return;
    const ents = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if ((await fs.stat(p)).mtimeMs < cutoff) old.push(p);
    }
  };
  await walk(prefix ? path.join(root, safeKey(prefix)) : root, 0);
  await Promise.all(old.map((p) => fs.rm(p, { force: true })));
  return old.length;
}
