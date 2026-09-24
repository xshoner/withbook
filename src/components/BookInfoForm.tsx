"use client";

import { useState } from "react";

export type BookInfo = {
  title: string;
  subtitle: string;
  author: string;
  topic: string;
  intent: string;
  audience: string;
  keyMessage: string;
  tone: string;
  references: string;
  targetPages: number | string;
  extra: string;
};

export const EMPTY_INFO: BookInfo = {
  title: "",
  subtitle: "",
  author: "",
  topic: "",
  intent: "",
  audience: "",
  keyMessage: "",
  tone: "",
  references: "",
  targetPages: 200,
  extra: "",
};

const FIELDS: { key: keyof BookInfo; label: string; ph: string; area?: boolean; required?: boolean; half?: boolean }[] = [
  { key: "title", label: "책 제목", ph: "예: 공진화의 시간", required: true, half: true },
  { key: "subtitle", label: "부제", ph: "예: AI와 인간이 함께 진화하는 법", half: true },
  { key: "author", label: "저자명(필명)", ph: "예: 홍길동", half: true },
  { key: "targetPages", label: "목표 총 페이지 (A5)", ph: "200", half: true },
  { key: "topic", label: "주제 / 분야", ph: "예: 생성형 AI와 교육, 사회 변화" },
  { key: "intent", label: "집필 의도", ph: "왜 이 책을 쓰는지, 독자가 무엇을 얻기를 바라는지", area: true },
  { key: "audience", label: "주요 대상 독자", ph: "예: AI 변화에 막연한 불안을 느끼는 30~50대 직장인과 학부모", area: true },
  { key: "keyMessage", label: "핵심 메시지", ph: "책 전체를 한두 문장으로", area: true },
  { key: "tone", label: "톤", ph: "예: 친근하지만 전문적인, 강연하듯", half: true },
  { key: "references", label: "참고·경쟁 도서", ph: "예: 『사피엔스』, 『특이점이 온다』", half: true },
  { key: "extra", label: "기타 요청", ph: "꼭 다루고 싶은 사례, 피하고 싶은 것 등", area: true },
];

export default function BookInfoForm({
  initial,
  submitLabel,
  onSubmit,
  busy,
}: {
  initial: BookInfo;
  submitLabel: string;
  onSubmit: (v: BookInfo) => void;
  busy?: boolean;
}) {
  const [v, setV] = useState<BookInfo>(initial);
  return (
    <form
      className="grid grid-cols-2 gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(v);
      }}
    >
      {FIELDS.map((f) => (
        <div key={f.key} className={f.half ? "col-span-1" : "col-span-2"}>
          <label className="label">
            {f.label}
            {f.required && <span className="text-red-500"> *</span>}
          </label>
          {f.area ? (
            <textarea className="input min-h-[72px]" placeholder={f.ph} value={String(v[f.key])} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />
          ) : (
            <input
              className="input"
              type={f.key === "targetPages" ? "number" : "text"}
              required={f.required}
              placeholder={f.ph}
              value={String(v[f.key])}
              onChange={(e) => setV({ ...v, [f.key]: e.target.value })}
            />
          )}
        </div>
      ))}
      <div className="col-span-2 flex justify-end">
        <button className="btn-primary" disabled={busy || !v.title.trim()}>
          {busy ? "처리 중…" : submitLabel}
        </button>
      </div>
    </form>
  );
}
