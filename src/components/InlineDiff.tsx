"use client";

import { Fragment, useMemo, useState } from "react";
import { diffDocParagraphs, diffWords, type ParaDiffRow, type WordDiff } from "@/lib/doc/diff";

const DEL = "bg-red-100 text-red-800 line-through decoration-red-400";
const ADD = "bg-emerald-100 text-emerald-900 underline decoration-emerald-400 underline-offset-2";

function Words({ parts }: { parts: WordDiff[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.type === "same" ? (
          <Fragment key={i}>{p.text}</Fragment>
        ) : (
          <span key={i} className={p.type === "del" ? DEL : ADD}>
            {p.text}
          </span>
        ),
      )}
    </>
  );
}

/** 두 글을 어절 단위로 비교해 한 줄로 보여준다 (빨강 취소선 = 지워짐, 초록 밑줄 = 새로 씀) */
export default function InlineDiff({ before, after }: { before: string; after: string }) {
  const parts = useMemo(() => diffWords(before, after), [before, after]);
  return <Words parts={parts} />;
}

const cut = (s: string, n = 60) => (s.length > n ? s.slice(0, n) + "…" : s);

type Block = { kind: "row"; row: ParaDiffRow } | { kind: "fold"; id: number; rows: string[] };

/**
 * 문단 배열(docParagraphs() 결과) 비교. 고친 문단은 어절 단위로, 바뀌지 않은 문단이 길게 이어지면 접는다.
 * before = 이전(버전·현재 본문), after = 이후(현재 본문·새 후보)
 */
export function ParagraphDiff({ before, after }: { before: string[]; after: string[] }) {
  const rows = useMemo(() => diffDocParagraphs(before, after), [before, after]);
  const [open, setOpen] = useState<Set<number>>(new Set());

  // 같은 문단이 3개 이상 이어지면 바뀐 곳 앞뒤 1문단만 남기고 접는다
  const blocks = useMemo(() => {
    const out: Block[] = [];
    let k = 0;
    let id = 0;
    while (k < rows.length) {
      if (rows[k].type !== "same") {
        out.push({ kind: "row", row: rows[k++] });
        continue;
      }
      const start = k;
      while (k < rows.length && rows[k].type === "same") k++;
      const run = rows.slice(start, k) as { type: "same"; text: string }[];
      if (run.length <= 2) {
        run.forEach((row) => out.push({ kind: "row", row }));
        continue;
      }
      const lead = start > 0 ? 1 : 0;
      const trail = k < rows.length ? 1 : 0;
      run.slice(0, lead).forEach((row) => out.push({ kind: "row", row }));
      const mid = run.slice(lead, run.length - trail);
      if (mid.length) out.push({ kind: "fold", id: id++, rows: mid.map((r) => r.text) });
      run.slice(run.length - trail).forEach((row) => out.push({ kind: "row", row }));
    }
    return out;
  }, [rows]);

  if (!rows.some((r) => r.type !== "same")) return <p className="py-4 text-center text-xs text-stone-400">바뀐 내용이 없습니다</p>;

  return (
    <div className="space-y-1 font-book text-[12px] leading-5">
      {blocks.map((b, i) => {
        if (b.kind === "fold") {
          if (open.has(b.id))
            return (
              <Fragment key={i}>
                {b.rows.map((t, x) => (
                  <p key={x} className="text-stone-400">
                    {t}
                  </p>
                ))}
              </Fragment>
            );
          return (
            <button
              key={i}
              className="block w-full rounded bg-stone-50 py-0.5 text-center font-sans text-[11px] text-stone-400 hover:bg-stone-100 hover:text-stone-600"
              onClick={() => setOpen(new Set(open).add(b.id))}
            >
              … 문단 {b.rows.length}개 같음 (펼치기)
            </button>
          );
        }
        const r = b.row;
        if (r.type === "change")
          return (
            <p key={i} className="border-l-2 border-amber-300 pl-1.5 text-stone-800">
              <Words parts={r.words} />
            </p>
          );
        if (r.type === "del")
          return (
            <p key={i} className="border-l-2 border-red-300 bg-red-50 pl-1.5 text-red-800 line-through decoration-red-300">
              {r.text}
            </p>
          );
        if (r.type === "add")
          return (
            <p key={i} className="border-l-2 border-emerald-300 bg-emerald-50 pl-1.5 text-emerald-900">
              {r.text}
            </p>
          );
        return (
          <p key={i} className="text-stone-400">
            {cut(r.text)}
          </p>
        );
      })}
    </div>
  );
}
