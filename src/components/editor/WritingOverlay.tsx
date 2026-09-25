"use client";

import { useEffect, useRef, useState } from "react";

/**
 * AI 집필 중 진행 창 — 새로 쓰는 절의 편집 화면 가운데에만 뜬다(다른 절은 편집 가능). 본문은 다 쓴 뒤 한 번에 넣으므로 화면이 흔들리지 않는다.
 * 서버가 알려 주는 단계(앞 내용 정리 → 긴 절 개요 → 구상 → 집필)로 진행률을 어림한다.
 * 첫 문장 전 '생각하는 중'은 실측 평균(약 80초)으로 천천히 차오르고, 쓰기 시작하면 목표 글자 수 대비로 찬다 — 정확한 값이 아니라 예측을 돕는 표시다.
 */

type Stage = "review" | "outline" | "thinking" | "writing" | "finishing";

const STAGES: { key: Stage; label: string; desc: string }[] = [
  { key: "review", label: "이전 내용을 살펴보는 중", desc: "앞 절 요약과 바로 앞 문단을 읽고 흐름을 이어 갈 자리를 찾고 있습니다." },
  { key: "outline", label: "전체 구성을 짜는 중", desc: "긴 절이라 소제목 단위로 나눠 쓸 개요를 먼저 만들고 있습니다." },
  { key: "thinking", label: "생각하는 중", desc: "작가 문체 프로필과 스케치를 바탕으로 첫 문장과 전개를 구상하고 있습니다. 보통 1~2분 걸립니다." },
  { key: "writing", label: "작성하는 중", desc: "본문을 쓰고 있습니다. 아래에 최근 문장이 흘러갑니다." },
  { key: "finishing", label: "마무리하는 중", desc: "다 쓴 글을 이 절에 넣고 저장하고 있습니다." },
];

/** 단계별 진행률 구간(%) — 생각하는 구간은 예상 시간에 따라 천천히 차오른다 */
const RANGE: Record<Stage, [number, number, number?]> = {
  review: [0, 8, 12_000],
  outline: [8, 22, 50_000],
  thinking: [8, 35, 80_000],
  writing: [35, 98],
  finishing: [98, 100],
};

function stageOf(status: string, chars: number, partChars: number, done: boolean): Stage {
  if (done) return "finishing";
  if (/개요/.test(status)) return "outline"; // "긴 절의 집필 개요 준비 중…"도 '준비 중'이 들어 있어 먼저 본다
  if (/앞 내용|준비 중/.test(status)) return "review";
  // 파트마다 첫 글자가 나오기 전은 다시 '생각하는 중'
  if (/^(구상|집필 중… \(\d+\/\d+\)|이어서)/.test(status) && partChars < 40) return "thinking"; // 소제목 한 줄은 아직 구상 중
  return chars > 0 ? "writing" : "thinking";
}

export default function WritingOverlay(props: {
  status: string;
  text: string;
  chars: number;
  target: number;
  step?: { i: number; n: number; label: string } | null;
  onStop: () => void;
  /** 시작 시각 — 경과 시간 */
  startedAt?: number;
}) {
  const now = useNow(1000);
  // 파트가 바뀐 뒤 쓴 글자 (긴 절은 파트마다 다시 구상한다)
  const part = props.status.match(/\((\d+)\/(\d+)\)/);
  const partKey = part ? part[0] : "";
  const partBase = useRef<{ key: string; chars: number }>({ key: "", chars: 0 });
  if (partBase.current.key !== partKey) partBase.current = { key: partKey, chars: props.chars };
  const partChars = props.chars - partBase.current.chars;
  const done = props.target > 0 && props.chars >= props.target * 0.98 && /완료/.test(props.status);
  const stage = stageOf(props.status, props.chars, partKey ? partChars : props.chars, done);
  const stageSeen = useStageSeen(stage);
  const long = /개요/.test(props.status) || !!part || stageSeen.current.has("outline");

  // 단계에 들어온 시각
  const since = useRef<{ stage: Stage; at: number }>({ stage, at: Date.now() });
  if (since.current.stage !== stage) since.current = { stage, at: Date.now() };

  const [lo, hi, expect] = RANGE[stage];
  let pct: number;
  if (stage === "writing") {
    pct = lo + (hi - lo) * Math.min(1, props.target > 0 ? props.chars / props.target : 0);
  } else if (expect) {
    const t = now - since.current.at;
    pct = lo + (hi - lo) * (1 - Math.exp(-t / expect)); // 끝에 닿지 않고 천천히 차오른다
    // 긴 절에서 파트 사이 구상은 이미 쓴 분량 위에서 이어 간다
    if (stage === "thinking" && props.chars > 0) pct = Math.max(pct, 35 + 63 * Math.min(1, props.chars / Math.max(1, props.target)));
  } else pct = hi;
  pct = Math.max(1, Math.min(100, pct));
  const shown = useMonotonic(pct);

  const elapsed = props.startedAt ? Math.max(0, Math.round((now - props.startedAt) / 1000)) : 0;
  const stageSec = Math.max(0, Math.round((now - since.current.at) / 1000));
  const tail = props.text.replace(/⟦주:[^⟧]*⟧/g, "").replace(/[#*>]/g, "").trim();
  const steps = STAGES.filter((s) => s.key !== "outline" || long);
  const cur = STAGES.find((s) => s.key === stage)!;
  const order = steps.findIndex((s) => s.key === stage);

  return (
    <div className="pointer-events-auto absolute inset-0 z-30 flex items-center justify-center bg-stone-900/25 backdrop-blur-[2px]">
      <div className="w-[540px] max-w-[92%] rounded-2xl border border-stone-200 bg-white p-6 shadow-2xl" role="status" aria-live="polite">
        <div className="flex items-center gap-3">
          <span className="writing-pen" aria-hidden>
            ✎
          </span>
          <div className="min-w-0 flex-1">
            <div className="writing-title font-bookhead text-lg">지금은 집필 중</div>
            <div className="truncate text-xs text-stone-500">
              {props.step ? `${props.step.i}/${props.step.n}번째 절 · ${props.step.label}` : props.status}
              {part && ` · 파트 ${part[1]}/${part[2]}`}
            </div>
          </div>
          <button className="btn-primary bg-red-700 px-3 py-1 text-xs hover:bg-red-800" onClick={props.onStop} title="Esc — 쓴 데까지는 본문에 넣습니다">
            ■ 중지
          </button>
        </div>

        {/* 진행률 */}
        <div className="mt-4 flex items-baseline justify-between text-xs">
          <b className="text-amber-800">{cur.label}</b>
          <span className="tabular-nums text-stone-500">
            약 {Math.round(shown)}% · {elapsed}초 경과
          </span>
        </div>
        <div className="mt-1.5 h-2.5 overflow-hidden rounded-full bg-stone-100" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(shown)} aria-label="집필 진행률(어림)">
          <div className="h-full rounded-full bg-gradient-to-r from-amber-500 to-amber-700 transition-[width] duration-1000 ease-out" style={{ width: `${shown}%` }} />
        </div>
        <p className="mt-2 text-[12px] leading-5 text-stone-600">
          {cur.desc}
          {stage !== "writing" && stageSec >= 5 && <span className="text-stone-400"> ({stageSec}초째)</span>}
        </p>

        {/* 단계 */}
        <ol className="mt-3 grid gap-1 text-[11.5px]" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
          {steps.map((s, i) => (
            <li
              key={s.key}
              className={`flex items-center gap-1 rounded-md px-1.5 py-1 ${i === order ? "bg-amber-50 font-semibold text-amber-900 ring-1 ring-amber-300" : i < order ? "text-stone-500" : "text-stone-300"}`}
            >
              <span aria-hidden>{i < order ? "✓" : i === order ? "●" : "○"}</span>
              <span className="truncate">{s.label.replace(/ 중$/, "")}</span>
            </li>
          ))}
        </ol>

        <div className="mt-1 flex justify-between text-[11px] text-stone-400">
          <span>{props.chars ? `${props.chars.toLocaleString()}자 작성` : "아직 쓴 글자가 없습니다"}</span>
          {props.target > 0 && <span>목표 약 {props.target.toLocaleString()}자</span>}
        </div>
        <div className="writing-roll mt-3 h-[4.8em] overflow-hidden rounded-lg bg-stone-50 px-3 py-2 font-book text-[12.5px] leading-[1.6em] text-stone-600">
          <div className="flex h-full flex-col justify-end">
            <p className="whitespace-pre-line">{tail ? tail.slice(-180) : "…"}</p>
          </div>
        </div>
        <p className="mt-3 text-center text-[11px] text-stone-400">
          다 쓰면 이 절에 한 번에 들어갑니다 · 그동안 목차에서 <b className="text-stone-600">다른 절을 열어 편집</b>해도 집필은 계속됩니다 · 진행률은 어림값입니다 · Esc 중지
        </p>
      </div>
    </div>
  );
}

/** 주기적으로 지금 시각 */
function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** 진행률이 뒤로 가지 않게 (단계가 바뀌며 어림값이 줄어도 막대는 그대로) */
function useMonotonic(v: number) {
  const max = useRef(0);
  max.current = Math.max(max.current, v);
  return max.current;
}

/** 지금까지 거친 단계 */
function useStageSeen(stage: Stage) {
  const seen = useRef(new Set<Stage>());
  seen.current.add(stage);
  return seen;
}
