"use client";

import { useState } from "react";

const TEXT: [string, string][] = [
  ["endingStyle", "종결어미"],
  ["sentenceLength", "문장 길이·리듬"],
  ["paragraphing", "문단 구성"],
  ["voice", "화자·독자와의 거리"],
];
const LISTS: [string, string][] = [
  ["tone", "어조"],
  ["devices", "자주 쓰는 장치"],
  ["signaturePhrases", "자주 쓰는 표현"],
  ["avoid", "쓰지 않는 것"],
  ["sampleExcerpts", "문체 참고 발췌"],
];

/** 문체 프로필 보기·수정 (배열 항목은 한 줄에 하나) */
export default function StyleProfileView({ profile, onSave }: { profile: any; onSave?: (p: any) => Promise<void> }) {
  const [edit, setEdit] = useState(false);
  const [p, setP] = useState<any>(profile);
  const asList = (v: any): string[] => (Array.isArray(v) ? v : v ? [String(v)] : []);
  return (
    <div className="space-y-3 text-sm">
      {TEXT.map(([k, l]) => (
        <div key={k}>
          <div className="text-xs font-semibold text-stone-500">{l}</div>
          {edit ? (
            <textarea className="input min-h-[64px]" value={p[k] ?? ""} onChange={(e) => setP({ ...p, [k]: e.target.value })} />
          ) : (
            <p className="leading-6 text-stone-700">{p[k]}</p>
          )}
        </div>
      ))}
      {LISTS.map(([k, l]) => (
        <div key={k}>
          <div className="text-xs font-semibold text-stone-500">{l}</div>
          {edit ? (
            <textarea
              className="input min-h-[80px]"
              value={asList(p[k]).join("\n")}
              onChange={(e) => setP({ ...p, [k]: e.target.value.split("\n").filter((x) => x.trim()) })}
            />
          ) : k === "sampleExcerpts" ? (
            <div className="space-y-1">
              {asList(p[k]).map((x, i) => (
                <blockquote key={i} className="border-l-2 border-amber-300 pl-3 font-book text-[13px] leading-6 text-stone-700">
                  {x}
                </blockquote>
              ))}
            </div>
          ) : (
            <ul className="list-disc pl-5 leading-6 text-stone-700">
              {asList(p[k]).map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          )}
        </div>
      ))}
      {onSave && (
        <div className="flex gap-2 pt-2">
          {edit ? (
            <>
              <button
                className="btn-primary"
                onClick={async () => {
                  await onSave(p);
                  setEdit(false);
                }}
              >
                저장
              </button>
              <button
                className="btn"
                onClick={() => {
                  setP(profile);
                  setEdit(false);
                }}
              >
                취소
              </button>
            </>
          ) : (
            <button className="btn" onClick={() => setEdit(true)}>
              직접 수정
            </button>
          )}
        </div>
      )}
    </div>
  );
}
