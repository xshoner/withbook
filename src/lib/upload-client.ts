"use client";

import { api } from "./client";
import { browserSupabase } from "./supabase/browser";

const DIRECT_LIMIT = 3.5 * 1024 * 1024; // Vercel 요청 본문 4.5MB 제한보다 작게

/**
 * FormData에 파일을 붙인다. 작은 파일은 그대로, 큰 파일은 Supabase Storage에 먼저 직접 올리고 경로만 붙인다.
 * 서버는 lib/uploads.ts의 readUploads로 두 경우를 같이 읽는다.
 */
export async function attachFile(fd: FormData, field: string, file: File) {
  if (file.size <= DIRECT_LIMIT) {
    fd.append(field, file);
    return;
  }
  const s = await api<{ local?: boolean; path?: string; token?: string }>("/api/uploads", { method: "POST", json: { name: file.name, size: file.size } });
  if (s.local || !s.path || !s.token) {
    fd.append(field, file);
    return;
  }
  const { error } = await browserSupabase().storage.from("incoming").uploadToSignedUrl(s.path, s.token, file, { contentType: file.type || "application/octet-stream" });
  if (error) throw new Error(`파일 업로드 실패: ${error.message}`);
  fd.append(`${field}Path`, s.path);
  fd.append(`${field}Name`, file.name);
}
