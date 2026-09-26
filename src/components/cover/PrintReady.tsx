"use client";

import { useEffect } from "react";

/** 글꼴·이미지를 모두 받은 뒤 조판 완료를 알린다 (renderPdf가 window.__PAGED_DONE을 기다린다) */
export default function PrintReady() {
  useEffect(() => {
    const w = window as unknown as { __PAGED_DONE?: boolean; __PAGED_ERROR?: string };
    const imgs = [...document.images].map((img) =>
      img.complete ? Promise.resolve(img.naturalWidth > 0) : new Promise<boolean>((ok) => {
        img.onload = () => ok(true);
        img.onerror = () => ok(false);
      }),
    );
    Promise.all([document.fonts.ready, ...imgs]).then(async ([, ...loaded]) => {
      // 글꼴을 쓰는 글이 그려진 뒤에야 늦게 받는 글꼴이 있어 한 번 더 기다린다
      await document.fonts.ready;
      if (loaded.some((ok) => !ok)) w.__PAGED_ERROR = "표지 이미지를 불러오지 못했습니다.";
      w.__PAGED_DONE = true;
    });
  }, []);
  return null;
}
