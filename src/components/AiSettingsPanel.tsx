"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client";

type Provider = "gateway" | "openai" | "gemini" | "anthropic" | "custom";
type Pub = {
  provider: Provider;
  keyName: string;
  model: string;
  baseUrl: string;
  endpoint: string;
  authScheme: "x-api-key" | "bearer";
  maxOutputTokens: number;
  source: "file" | "env";
  hasKey: boolean;
  keyFrom: "saved" | "env" | "none";
  keyMasked: string;
  providers: Record<Provider, { label: string; baseUrl: string; keyName: string; model: string; authScheme: "x-api-key" | "bearer" }>;
};
type Form = { provider: Provider; keyName: string; model: string; baseUrl: string; authScheme: "x-api-key" | "bearer"; apiKey: string; maxOutputTokens: number };
type Check = { state: "idle" | "checking" | "ok" | "fail"; ms?: number; msg?: string };

const toForm = (p: Pub): Form => ({ provider: p.provider, keyName: p.keyName, model: p.model, baseUrl: p.baseUrl, authScheme: p.authScheme, apiKey: "", maxOutputTokens: p.maxOutputTokens });

/** AI 연결 설정 — 현재 값을 보여 주고 [수정] → [확인]으로 바꾼 뒤 짧은 호출로 연결을 점검한다 */
export default function AiSettingsPanel() {
  const [cur, setCur] = useState<Pub | null>(null);
  const [f, setF] = useState<Form | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [check, setCheck] = useState<Check>({ state: "idle" });

  const load = async () => {
    const p = await api<Pub>("/api/ai/settings");
    setCur(p);
    setF(toForm(p));
    return p;
  };
  useEffect(() => {
    load().catch((e) => setErr(e.message));
  }, []);

  const ping = async () => {
    setCheck({ state: "checking" });
    try {
      const r = await api<{ ok: boolean; ms: number; reply?: string; error?: string }>("/api/ai/status", { method: "POST" });
      setCheck(r.ok ? { state: "ok", ms: r.ms, msg: r.reply } : { state: "fail", ms: r.ms, msg: r.error });
    } catch (e: any) {
      setCheck({ state: "fail", msg: e.message });
    }
  };

  const confirm = async () => {
    if (!f) return;
    setErr("");
    setSaving(true);
    try {
      const p = await api<Pub>("/api/ai/settings", { method: "PUT", json: f });
      setCur(p);
      setF(toForm(p));
      setEditing(false);
      await ping();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (!cur || !f) return <div className="text-sm text-stone-400">{err || "불러오는 중…"}</div>;
  const set = (patch: Partial<Form>) => setF({ ...f, ...patch });
  const ro = !editing;
  const field = (label: string, input: React.ReactNode, hint?: string) => (
    <div>
      <label className="label">{label}</label>
      {input}
      {hint && <p className="mt-0.5 text-[11px] text-stone-400">{hint}</p>}
    </div>
  );
  const inputCls = `input ${ro ? "cursor-default bg-stone-100 text-stone-700" : ""}`;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3 rounded-lg border border-stone-200 bg-stone-50 px-4 py-3">
        <StatusLight state={check.state} />
        <div className="min-w-0 flex-1 text-sm">
          <div className="font-semibold text-stone-800">
            {check.state === "checking"
              ? "연결 점검 중…"
              : check.state === "ok"
                ? `연결됨 — 응답 ${check.ms}ms`
                : check.state === "fail"
                  ? "연결 실패"
                  : "아직 점검하지 않음"}
          </div>
          <div className="truncate text-xs text-stone-500">
            {check.state === "fail" ? check.msg : check.state === "ok" ? `모델 응답: "${check.msg}"` : `${cur.providers[cur.provider]?.label ?? cur.provider} · ${cur.model}`}
          </div>
        </div>
        <button className="btn" disabled={check.state === "checking" || editing} onClick={ping}>
          연결 점검
        </button>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {field(
          "AI 제공자",
          <select
            className={inputCls}
            disabled={ro}
            value={f.provider}
            onChange={(e) => {
              const p = e.target.value as Provider;
              const d = cur.providers[p];
              set({ provider: p, baseUrl: d.baseUrl || f.baseUrl, keyName: d.keyName, model: d.model || f.model, authScheme: d.authScheme });
            }}
          >
            {(Object.keys(cur.providers) as Provider[]).map((k) => (
              <option key={k} value={k}>
                {cur.providers[k].label}
              </option>
            ))}
          </select>,
          "모두 OpenAI 호환 방식(Chat Completions)으로 호출합니다",
        )}
        {field(
          "호출 모델",
          <input className={inputCls} readOnly={ro} value={f.model} onChange={(e) => set({ model: e.target.value })} placeholder="예: gemini-3.6-flash" />,
          "제공자가 안내하는 모델 이름 그대로",
        )}
        {field(
          "AI 호출 이름 (키 이름)",
          <input className={`${inputCls} font-mono`} readOnly={ro} value={f.keyName} onChange={(e) => set({ keyName: e.target.value.toUpperCase() })} placeholder="예: GEMINI_API_KEY" />,
          "키 값을 비워 두면 .env에서 이 이름의 값을 키로 씁니다 (…_KEY로 끝나야 함)",
        )}
        {field(
          "API 키 값",
          <input
            className={`${inputCls} font-mono`}
            readOnly={ro}
            type={ro ? "text" : "password"}
            autoComplete="off"
            value={ro ? cur.keyMasked || "(없음)" : f.apiKey}
            onChange={(e) => set({ apiKey: e.target.value })}
            placeholder={cur.hasKey ? `지금 키 유지: ${cur.keyMasked} — 바꿀 때만 입력` : "예: ADW3RF…"}
          />,
          cur.keyFrom === "saved" ? "저장된 키 사용 중 (서버의 data 폴더에만 보관, 화면에는 가려서 표시)" : cur.keyFrom === "env" ? `.env의 ${cur.keyName} 사용 중` : "키가 없습니다",
        )}
        {field(
          "기본 주소 (Base URL)",
          <input className={`${inputCls} font-mono text-xs`} readOnly={ro} value={f.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="https://…" />,
          `호출 주소: ${cur.endpoint || "(없음)"}`,
        )}
        {field(
          "인증 방식",
          <select className={inputCls} disabled={ro} value={f.authScheme} onChange={(e) => set({ authScheme: e.target.value as Form["authScheme"] })}>
            <option value="bearer">Authorization: Bearer (OpenAI·Gemini·Anthropic)</option>
            <option value="x-api-key">x-api-key 헤더 (게이트웨이)</option>
          </select>,
        )}
        {field(
          "최대 출력 토큰",
          <input type="number" className={inputCls} readOnly={ro} min={1000} max={200000} step={1000} value={f.maxOutputTokens} onChange={(e) => set({ maxOutputTokens: Number(e.target.value) || 32000 })} />,
          "긴 절 집필에 쓰는 한 번 호출의 상한. 모델 한도보다 크면 낮추세요",
        )}
      </div>

      {err && <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>}
      <div className="flex items-center gap-2">
        {!editing ? (
          <button className="btn-primary" onClick={() => setEditing(true)}>
            수정
          </button>
        ) : (
          <>
            <button className="btn-accent" disabled={saving} onClick={confirm}>
              {saving ? "적용 중…" : "확인"}
            </button>
            <button
              className="btn"
              disabled={saving}
              onClick={() => {
                setF(toForm(cur));
                setEditing(false);
                setErr("");
              }}
            >
              취소
            </button>
            <span className="text-xs text-stone-500">[확인]을 누르면 바로 적용하고 연결을 점검합니다.</span>
          </>
        )}
        <span className="ml-auto text-[11px] text-stone-400">{cur.source === "file" ? "앱에 저장한 설정 사용 중" : ".env 기본값 사용 중"} · 모든 책에 공통</span>
      </div>
    </div>
  );
}

function StatusLight({ state }: { state: Check["state"] }) {
  const color = state === "ok" ? "bg-emerald-500" : state === "fail" ? "bg-red-500" : state === "checking" ? "bg-amber-400" : "bg-stone-300";
  return (
    <span className="relative flex h-4 w-4 shrink-0" title={state}>
      {(state === "ok" || state === "checking") && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${color}`} />}
      <span className={`relative inline-flex h-4 w-4 rounded-full ${color} ${state === "ok" ? "shadow-[0_0_8px_2px_rgba(16,185,129,.6)]" : ""}`} />
    </span>
  );
}
