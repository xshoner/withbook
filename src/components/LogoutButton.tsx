"use client";

import { browserSupabase } from "@/lib/supabase/browser";

/** 로그아웃 — 웹 배포에서만 보인다 */
export default function LogoutButton() {
  if (process.env.NEXT_PUBLIC_APP_ACCESS_MODE !== "web") return null;
  return (
    <button
      className="btn"
      onClick={async () => {
        await browserSupabase().auth.signOut();
        window.location.replace("/");
      }}
    >
      로그아웃
    </button>
  );
}
