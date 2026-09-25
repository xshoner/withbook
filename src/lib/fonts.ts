import "server-only";
import fs from "node:fs";
import path from "node:path";
import { listObjects } from "./storage";
import { storageConfigured, supabaseUrl } from "./supabase/admin";

/** KoPub 글꼴 — 로컬은 public/fonts, 웹 배포는 Supabase Storage의 공개 fonts 버킷(저장소 git에는 올리지 않는다) */
export const FONT_FILES = ["KoPubBatangLight.ttf", "KoPubBatangBold.ttf", "KoPubDotumMedium.ttf"] as const;
/** 화면·조판이 먼저 받는 압축 글꼴(WOFF2, 약 1/3 크기). 없으면 CSS가 TTF로 넘어간다 */
export const SERVED_FONTS = [...FONT_FILES, ...FONT_FILES.map((f) => f.replace(/\.ttf$/, ".woff2"))];

export const localFontPath = (name: string) => path.resolve(/* turbopackIgnore: true */ process.cwd(), "public", "fonts", name);

export function publicFontUrl(name: string) {
  return `${supabaseUrl()}/storage/v1/object/public/fonts/${encodeURIComponent(name)}`;
}

let remote: { at: number; names: Set<string> } | null = null;

export async function fontAvailable(name: string) {
  if (fs.existsSync(localFontPath(name))) return true;
  if (!storageConfigured()) return false;
  if (!remote || Date.now() - remote.at > 60_000) {
    const list = await listObjects("fonts").catch(() => []);
    remote = { at: Date.now(), names: new Set(list.map((f) => f.name)) };
  }
  return remote.names.has(name);
}
