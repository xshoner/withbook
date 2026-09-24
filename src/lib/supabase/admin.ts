import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** 서버 전용 Supabase 클라이언트 (비밀 키) — 저장소·관리자 작업용. 브라우저로 절대 보내지 않는다. */
let client: SupabaseClient | null = null;

export const supabaseUrl = () => process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

export function storageConfigured() {
  return Boolean(supabaseUrl() && process.env.SUPABASE_SECRET_KEY);
}

export function supabaseAdmin() {
  if (!storageConfigured()) throw new Error("Supabase 서버 설정(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY)이 없습니다.");
  client ??= createClient(supabaseUrl(), process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}
