"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

/** 브라우저용 Supabase 클라이언트 (공개 키) — 로그인 세션은 쿠키에 저장되어 서버·proxy가 함께 읽는다 */
let client: SupabaseClient | null = null;

export function browserSupabase() {
  client ??= createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!);
  return client;
}
