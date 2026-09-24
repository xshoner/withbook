"use client";

import { useState } from "react";
import { browserSupabase } from "@/lib/supabase/browser";

/** 이메일·비밀번호 로그인 (Supabase Auth) */
export default function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const { data, error } = await browserSupabase().auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw error;
      const role = (data.user?.app_metadata as { role?: string } | undefined)?.role;
      if (!role || !["superadmin", "editor"].includes(role)) {
        await browserSupabase().auth.signOut();
        throw new Error("이 계정은 사용 권한이 없습니다. 관리자에게 문의하세요.");
      }
      const next = new URLSearchParams(window.location.search).get("next");
      window.location.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : "/projects");
    } catch (e: any) {
      setErr(/Invalid login credentials/i.test(e?.message ?? "") ? "이메일 또는 비밀번호가 맞지 않습니다." : e?.message ?? "로그인하지 못했습니다.");
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="card space-y-4 p-6">
      <div>
        <label className="label" htmlFor="login-email">
          이메일
        </label>
        <input id="login-email" type="email" autoComplete="username" required className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div>
        <label className="label" htmlFor="login-password">
          비밀번호
        </label>
        <input id="login-password" type="password" autoComplete="current-password" required className="input" value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      {err && <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>}
      <button type="submit" className="btn-primary w-full py-2" disabled={busy}>
        {busy ? "로그인 중…" : "로그인"}
      </button>
    </form>
  );
}
