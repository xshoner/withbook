"use client";

import type { Node as PMNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { setLocalBusy } from "./jobStore";

/** 늘 같은 함수(참조)를 돌려주되 부를 때는 최신 fn을 부른다 — memo한 자식에 넘길 때 다시 그리지 않게 */
export function useStableFn<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}

/**
 * 편집 잠금 하나로 — 잠그는 이유(AI 집필·교정·자동 집필 점검·선택 영역 AI·각주 AI·저장 충돌)를 모두 모아
 * 편집 가능 여부를 한 곳에서 정한다. 여기저기서 setEditable(true)를 부르다 다른 작업 중인데 잠금이 풀리던 문제를 막는다.
 * busy: 편집기 안 짧은 작업(결과 확인·각주 요청) — 자동 집필 점검이 이 절을 고치기 전에 끝나기를 기다리게 알린다.
 */
export function useEditLock(
  editor: Editor | null,
  sectionId: string,
  s: { locked: boolean; proofBusy: boolean; autoChecking: boolean; rewrite: boolean; footnote: boolean; conflict: boolean; busy: string | null },
) {
  const reason = s.locked
    ? "AI가 이 절을 쓰는 중입니다 — 다른 절은 편집할 수 있습니다"
    : s.proofBusy
      ? "교정·교열 중입니다"
      : s.autoChecking
        ? "자동 집필이 이 절을 점검하는 중입니다"
        : s.rewrite
          ? "선택 영역 AI 결과를 먼저 적용하거나 취소하세요"
          : s.footnote
            ? "각주 작업 중입니다"
            : s.conflict
              ? "저장 충돌을 먼저 해결하세요"
              : "";
  const canEdit = !reason;
  const canEditRef = useRef(canEdit);
  canEditRef.current = canEdit;
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.setEditable(canEdit, false); // false: update 이벤트를 내지 않아 상태가 '수정 중'으로 바뀌지 않게
  }, [editor, canEdit]);
  useEffect(() => {
    setLocalBusy(sectionId, s.busy);
  }, [sectionId, s.busy]);
  useEffect(() => () => setLocalBusy(sectionId, null), [sectionId]);
  return { canEdit, reason, canEditRef };
}

/**
 * 문서에서 뽑은 값 — 입력이 멈춘 뒤(delay) 한 번 다시 계산하고, 값이 달라졌을 때만(key 비교) 다시 그린다.
 * 글자마다 편집기 전체를 다시 그리지 않게 각주 목록·비교용 문단처럼 필요한 곳에서만 쓴다. enabled가 거짓이면 계산하지 않는다.
 */
export function useDocValue<T>(editor: Editor | null, compute: (doc: PMNode) => T, opts: { key: (v: T) => string; delay?: number; enabled?: boolean; initial: T }) {
  const { key, delay = 300, enabled = true, initial } = opts;
  const [value, setValue] = useState<T>(initial);
  const fn = useRef({ compute, key });
  fn.current = { compute, key };
  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    if (!editor || !enabled) return;
    let timer: number | undefined;
    const run = () => {
      timer = undefined;
      if (editor.isDestroyed) return;
      const v = fn.current.compute(editor.state.doc);
      const k = fn.current.key(v);
      if (k === lastKey.current) return;
      lastKey.current = k;
      setValue(v);
    };
    const onTr = ({ transaction }: { transaction: Transaction }) => {
      if (!transaction.docChanged) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(run, delay);
    };
    run();
    editor.on("transaction", onTr);
    return () => {
      window.clearTimeout(timer);
      editor.off("transaction", onTr);
      lastKey.current = null;
    };
  }, [editor, enabled, delay]);
  return value;
}

/**
 * 비동기 작업(이미지 올리기·AI 요청) 동안 문서 위치를 따라간다 — 그사이 앞에서 글을 고쳐도 원래 자리를 가리킨다.
 * get(): 지금 문서에서의 위치 (그 자리가 지워졌으면 deleted: true). 끝나면 stop()
 */
export function trackPositions(editor: Editor, positions: number[]) {
  let cur = positions.slice();
  let deleted = false;
  const onTr = ({ transaction }: { transaction: Transaction }) => {
    if (!transaction.docChanged) return;
    cur = cur.map((p) => {
      const r = transaction.mapping.mapResult(p, 1);
      if (r.deleted) deleted = true;
      return r.pos;
    });
  };
  editor.on("transaction", onTr);
  return {
    get: () => ({ positions: cur, deleted }),
    stop: () => editor.off("transaction", onTr),
  };
}

/** 한글 등 입력 조합이 끝날 때까지 — 편집기가 닫히거나 5초가 지나도 기다림을 끝낸다 (작업이 끝없이 멈추지 않게) */
export function compositionDone(editor: Editor, maxMs = 5000): Promise<void> {
  if (editor.isDestroyed || !editor.view.composing) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.clearTimeout(t);
      editor.off("destroy", finish);
      if (!editor.isDestroyed) editor.view.dom.removeEventListener("compositionend", onEnd);
      resolve();
    };
    const onEnd = () => window.setTimeout(finish, 0);
    const t = window.setTimeout(finish, maxMs);
    editor.on("destroy", finish);
    editor.view.dom.addEventListener("compositionend", onEnd, { once: true });
  });
}

/** 클립보드에 글(Word·Excel·웹 문서 등)이 있으면 이미지로 붙이지 않는다 — 그런 프로그램은 글과 함께 그림(미리보기)도 넣는다 */
export function clipboardHasText(cd: DataTransfer | null) {
  if (!cd) return false;
  if ((cd.getData("text/plain") ?? "").trim()) return true;
  const html = cd.getData("text/html") ?? "";
  return !!html && /\S/.test(html.replace(/<style[\s\S]*?<\/style>|<[^>]+>|&nbsp;/gi, " "));
}
