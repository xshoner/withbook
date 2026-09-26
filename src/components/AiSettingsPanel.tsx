"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { AI_SCOPES, type AiScope } from "@/lib/ai/routing";

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
  inherited: boolean;
  reasoningEffort: "default" | "low" | "medium" | "high";
  providers: Record<Provider, { label: string; baseUrl: string; keyName: string; model: string; authScheme: "x-api-key" | "bearer" }>;
};
type Form = { provider: Provider; keyName: string; model: string; baseUrl: string; authScheme: "x-api-key" | "bearer"; apiKey: string; maxOutputTokens: number; reasoningEffort: Pub["reasoningEffort"]; clearKey: boolean };
type Check = { state: "idle" | "checking" | "ok" | "fail"; ms?: number; msg?: string };

const toForm = (p: Pub): Form => ({ provider: p.provider, keyName: p.keyName, model: p.model, baseUrl: p.baseUrl, authScheme: p.authScheme, apiKey: "", maxOutputTokens: p.maxOutputTokens, reasoningEffort: p.reasoningEffort, clearKey: false });

/** AI 연결 설정 — 현재 값을 보여 주고 [수정] → [확인]으로 바꾼 뒤 짧은 호출로 연결을 점검한다 */
export default function AiSettingsPanel() {
  const [scope, setScope] = useState<AiScope>("default");
  const [locked, setLocked] = useState(false);
  return <div className="space-y-5">
    <p className="text-sm text-stone-600">용도별로 API 키와 모델을 등록하세요. 별도 설정이 없으면 기본 연결을 사용합니다. 모든 책에 공통으로 적용됩니다.</p>
    <div className="flex flex-wrap gap-2" role="group" aria-label="AI 작업 용도">
      {(Object.keys(AI_SCOPES) as AiScope[]).map((s) => <button key={s} disabled={locked} aria-pressed={scope === s} className={scope === s ? "btn-primary" : "btn"} onClick={() => setScope(s)}>{AI_SCOPES[s].label}</button>)}
    </div>
    <ConnectionPanel key={scope} scope={scope} onLock={setLocked} />
  </div>;
}

function ConnectionPanel({ scope, onLock }: { scope: AiScope; onLock: (locked: boolean) => void }) {
  const [cur, setCur] = useState<Pub | null>(null);
  const [f, setF] = useState<Form | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [check, setCheck] = useState<Check>({ state: "idle" });
  const [copyFrom, setCopyFrom] = useState<AiScope>("default");
  useEffect(() => { onLock(editing || saving || check.state === "checking"); }, [editing, saving, check.state, onLock]);

  const load = async () => {
    const p = await api<Pub>(`/api/ai/settings?scope=${scope}`);
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
      const r = await api<{ ok: boolean; ms: number; reply?: string; error?: string }>(`/api/ai/status?scope=${scope}`, { method: "POST" });
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
      const p = await api<Pub>("/api/ai/settings", { method: "PUT", json: { ...f, scope } });
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

  const changeConnection = async (patch: { useDefault?: boolean; copyFrom?: AiScope }) => {
    setSaving(true);
    setErr("");
    try {
      const p = await api<Pub>("/api/ai/settings", { method: "PUT", json: { scope, ...patch } });
      setCur(p);
      setF(toForm(p));
      setCheck({ state: "idle" });
    } catch (e: any) { setErr(e.message); }
    finally { setSaving(false); }
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
      <div className="rounded-lg border border-stone-200 p-4 space-y-3">
        <div className="font-semibold">{AI_SCOPES[scope].label} <span className="ml-2 text-xs font-normal text-stone-500">{cur.inherited ? "기본 연결 사용 중" : "개별 연결 사용 중"}</span></div>
        <p className="text-sm text-stone-500">{AI_SCOPES[scope].description}</p>
        {!editing && <div className="flex flex-wrap items-center gap-2">
          <button className="btn" disabled={saving || check.state === "checking"} onClick={() => {
            setF({ ...f, ...cur.providers.gemini, provider: "gemini", apiKey: "", clearKey: f.provider !== "gemini" || f.baseUrl !== cur.providers.gemini.baseUrl, reasoningEffort: "low", maxOutputTokens: 32000 });
            setEditing(true); setErr(""); setCheck({ state: "idle" });
          }}>Gemini 3.8 Flash로 설정</button>
          {scope === "factcheck" && <button className="btn" disabled={saving || check.state === "checking"} onClick={() => {
            setF({ ...f, ...cur.providers.openai, provider: "openai", model: "gpt-5.6-terra", apiKey: "", clearKey: f.provider !== "openai" || f.baseUrl !== cur.providers.openai.baseUrl, reasoningEffort: "default", maxOutputTokens: 32000 });
            setEditing(true); setErr(""); setCheck({ state: "idle" });
          }}>GPT-5.6 Terra로 설정</button>}
          {scope !== "default" && !cur.inherited && <button className="btn" disabled={saving || check.state === "checking"} onClick={() => changeConnection({ useDefault: true })}>개별 연결 해제</button>}
        </div>}
        {scope !== "default" && !editing && <div className="flex flex-wrap items-center gap-2">
          <select aria-label="복사할 AI 연결" className="input w-auto" disabled={saving || check.state === "checking"} value={copyFrom} onChange={(e) => setCopyFrom(e.target.value as AiScope)}>
            {(Object.keys(AI_SCOPES) as AiScope[]).filter((s) => s !== scope).map((s) => <option key={s} value={s}>{AI_SCOPES[s].label}</option>)}
          </select>
          <button className="btn" disabled={saving || check.state === "checking"} onClick={() => changeConnection({ copyFrom })}>이 연결 복사</button>
          <span className="text-xs text-stone-500">키를 다시 입력하지 않고 복사합니다. 이후 변경은 각각 적용됩니다.</span>
        </div>}
        {editing && <p className="text-xs text-stone-500">API 키를 입력하고 저장하세요. Gemini 빠른 설정은 추론 강도를 낮음으로 지정합니다.{scope === "factcheck" ? " 팩트체크는 모델이 지원하면 웹 검색으로 최신 자료를 확인합니다." : ""}</p>}
      </div>
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
        <button className="btn" disabled={check.state === "checking" || editing || saving} onClick={ping}>
          연결 점검
        </button>
      </div>

      <fieldset disabled={saving} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {field(
          "AI 제공자",
          <select
            className={inputCls}
            disabled={ro}
            value={f.provider}
            onChange={(e) => {
              const p = e.target.value as Provider;
              const d = cur.providers[p];
              set({ provider: p, baseUrl: d.baseUrl || f.baseUrl, keyName: d.keyName, model: d.model || f.model, authScheme: d.authScheme, apiKey: "", clearKey: true, reasoningEffort: "default" });
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
          <input className={inputCls} readOnly={ro} value={f.model} onChange={(e) => set({ model: e.target.value })} placeholder="예: gemini-3.8-flash" />,
          "제공자가 안내하는 모델 이름 그대로",
        )}
        {field(
          "AI 호출 이름 (키 이름)",
          <input className={`${inputCls} font-mono`} readOnly={ro} value={f.keyName} onChange={(e) => set({ keyName: e.target.value.toUpperCase() })} placeholder="예: GEMINI_API_KEY" />,
          "키 값을 비워 두면 서버 환경변수에서 읽습니다 (…_API_KEY로 끝나야 함)",
        )}
        {field(
          "API 키 값",
          <input
            className={`${inputCls} font-mono`}
            readOnly={ro}
            type={ro ? "text" : "password"}
            autoComplete="off"
            value={ro ? cur.keyMasked || "(없음)" : f.apiKey}
            onChange={(e) => set({ apiKey: e.target.value, clearKey: false })}
            placeholder={!f.clearKey && cur.hasKey ? `지금 키 유지: ${cur.keyMasked} — 바꿀 때만 입력` : "새 API 키를 붙여 넣으세요"}
          />,
          f.clearKey ? "저장 시 기존 키를 지우고 해당 환경변수의 키를 사용합니다. 새 키를 입력해도 됩니다." : cur.keyFrom === "saved" ? "키는 서버 DB에 저장되며 화면에는 가려서 표시됩니다" : cur.keyFrom === "env" ? `서버 환경변수 ${cur.keyName} 사용 중` : "키가 없습니다",
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
        {f.provider === "gemini" && field("추론 강도", <select className={inputCls} disabled={ro} value={f.reasoningEffort} onChange={(e) => set({ reasoningEffort: e.target.value as Form["reasoningEffort"] })}>
          <option value="default">모델 기본값</option><option value="low">낮음 — 빠른 요약·개요</option><option value="medium">보통</option><option value="high">높음</option>
        </select>, "낮음은 응답 준비 시간을 줄이는 설정입니다. 지원 여부는 모델에 따라 다릅니다.")}
        {editing && <label className="flex items-center gap-2 text-xs text-stone-600"><input type="checkbox" checked={f.clearKey} onChange={(e) => set({ clearKey: e.target.checked, apiKey: "" })} />저장된 키 지우기 (서버 환경변수 사용)</label>}
      </fieldset>

      {err && <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>}
      <div className="flex items-center gap-2">
        {!editing ? (
          <button className="btn-primary" disabled={saving || check.state === "checking"} onClick={() => setEditing(true)}>
            {cur.inherited ? "이 용도에 API 추가" : "수정"}
          </button>
        ) : (
          <>
            <button className="btn-accent" disabled={saving} onClick={confirm}>
              {saving ? "적용 중…" : "저장하고 연결 점검"}
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
            <span className="text-xs text-stone-500">저장하면 이 용도에 바로 적용됩니다.</span>
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
