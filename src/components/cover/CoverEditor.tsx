"use client";

import Link from "next/link";
import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, download } from "@/lib/client";
import { attachFile } from "@/lib/upload-client";
import { confirmDialog, toast, toastError } from "@/components/ui/feedback";
import CoverSheet, { type Guides } from "./CoverSheet";
import {
  BOOK_SIZES,
  type BookInfo,
  type BookSize,
  type Box,
  COVER_BLEED,
  type CoverDesign,
  type CoverEl,
  type CoverImage,
  FONTS,
  type FontKey,
  type ImageEl,
  PANEL_LABEL,
  PAPERS,
  PROMPT_MAX,
  type PanelId,
  type Paper,
  REGION_LABEL,
  type Region,
  TEXT_PRESETS,
  type TextEl,
  type Rect,
  buildImagePrompt,
  coverIssues,
  BARCODE_NOTE,
  coverLayout,
  elAbs,
  googleFontsHref,
  newId,
  panelAt,
  panelsOf,
  placeImage,
  pxAt300,
  pxForAi,
  AI_DPI,
  reflowSpine,
  regionBox,
  requestSize,
  spineWidth,
  textDefaults,
  titleElements,
} from "@/lib/cover/spec";

const PX_PER_MM = 96 / 25.4;
const SWATCHES = ["#1c1917", "#ffffff", "#57534e", "#b45309", "#b91c1c", "#1d4ed8", "#047857", "#7c3aed", "#f59e0b", "#fde68a"];
const src = (id: string) => `/api/assets/${id}`;

type Project = { title: string; subtitle: string; author: string; topic: string; keyMessage: string; audience: string; tone: string; targetPages: number; chapters: { title: string; kind: string }[] };
type Tab = "ai" | "image" | "text";

/** 표지 디자인 에디터 — 펼침면(뒷날개|뒷표지|책등|앞표지|앞날개)에 그림을 채우고 글·사진을 얹어 인쇄용 PDF로 내보낸다 */
export default function CoverEditor({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const [design, setDesign] = useState<CoverDesign | null>(null);
  const [savedJson, setSavedJson] = useState("");
  /** 책의 실제 조판 쪽수 (집필 화면 측정·본문 PDF) — 모르면 null */
  const [actualPages, setActualPages] = useState<number | null>(null);
  /** 끄는 동안에는 끌기 전 디자인으로 저장 여부·인쇄 점검을 계산한다(움직일 때마다 JSON·점검을 다시 하지 않게) */
  const [frozen, setFrozen] = useState<CoverDesign | null>(null);
  const [err, setErr] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("ai");
  const [region, setRegion] = useState<Region>("full");
  const [guides, setGuides] = useState<Guides>({ bleed: true, fold: true, safe: true, labels: true, barcode: true });
  const [zoom, setZoom] = useState<number | null>(null); // null = 화면에 맞춤
  const [fitZoom, setFitZoom] = useState(0.5);
  const [busy, setBusy] = useState<"" | "save" | "export" | "exportJpg" | "ai" | "edit" | "upload">("");
  // 그림 수정 — 수정 요청과, 바꿀 부분(펼침면 mm, 선택)
  const [editPrompt, setEditPrompt] = useState("");
  const [maskMode, setMaskMode] = useState(false);
  const [maskRect, setMaskRect] = useState<Rect | null>(null);
  const maskDrag = useRef<{ x: number; y: number } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [snapX, setSnapX] = useState<number | null>(null);
  const undo = useRef<CoverDesign[]>([]);
  const redo = useRef<CoverDesign[]>([]);
  const lastPush = useRef<{ key: string; at: number }>({ key: "", at: 0 });
  const canvasRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const aiAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    Promise.all([api<Project>(`/api/projects/${projectId}`), api<{ design: CoverDesign; saved: boolean; actualPages: number | null }>(`/api/projects/${projectId}/cover`)])
      .then(([p, c]) => {
        setProject(p);
        // 쪽수를 직접 고치지 않았으면 서버가 실제 조판 쪽수로 맞춰 준다(책등 폭 자동 계산)
        setDesign(c.design);
        setActualPages(c.actualPages ?? null);
        setSavedJson(c.saved ? JSON.stringify(c.design) : "");
        document.title = `표지 디자인 — ${p.title}`;
      })
      .catch((e) => setErr(e.message));
  }, [projectId]);

  const settled = frozen ?? design;
  const dirty = useMemo(() => (settled ? JSON.stringify(settled) !== savedJson : false), [settled, savedJson]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  /** 바꾸기 — key가 같고 0.7초 안이면 되돌리기 한 번으로 묶는다(글자 입력·슬라이더) */
  const update = useCallback((fn: (d: CoverDesign) => CoverDesign, key = "") => {
    setDesign((d) => {
      if (!d) return d;
      const now = Date.now();
      if (!key || key !== lastPush.current.key || now - lastPush.current.at > 700) {
        undo.current = [...undo.current.slice(-59), d];
        redo.current = [];
      }
      lastPush.current = { key, at: now };
      return fn(d);
    });
  }, []);
  const snapshot = useCallback((d: CoverDesign) => {
    undo.current = [...undo.current.slice(-59), d];
    redo.current = [];
    lastPush.current = { key: "", at: 0 };
  }, []);
  const doUndo = () => {
    const prev = undo.current.pop();
    if (!prev || !design) return;
    redo.current.push(design);
    setDesign(prev);
  };
  const doRedo = () => {
    const next = redo.current.pop();
    if (!next || !design) return;
    undo.current.push(design);
    setDesign(next);
  };

  const l = useMemo(() => (design ? coverLayout(design) : null), [design]);
  // 인쇄 점검의 글 자리는 화면에서 잰 실제 글자 자리로 본다 (상자 폭이 아니라 글자가 놓인 곳).
  // 잰 값은 위치와 상관없고 글·모양이 같을 때만 쓴다(끄는 동안·고친 직후 어긋나지 않게)
  const sheetRef = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<Record<string, { sig: string; box: Box }>>({});
  useEffect(() => {
    if (frozen || !design) return;
    let cancelled = false;
    const run = () => {
      const root = sheetRef.current;
      if (!root || cancelled) return;
      const pxPerMm = root.getBoundingClientRect().width / coverLayout(design).sheetW;
      const next: Record<string, { sig: string; box: Box }> = {};
      for (const el of design.elements) {
        if (el.kind !== "text" || !el.text.trim()) continue;
        const node = root.querySelector<HTMLElement>(`[data-el="${CSS.escape(el.id)}"]`);
        const box = node ? inkBoxOf(node, pxPerMm) : null;
        if (box) next[el.id] = { sig: inkSig(el), box };
      }
      setMeasured((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    const raf = requestAnimationFrame(run);
    document.fonts?.ready.then(() => !cancelled && requestAnimationFrame(run));
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [design, frozen, zoom, fitZoom]);
  const issues = useMemo(() => {
    if (!settled) return [];
    const m: Record<string, Box> = {};
    for (const el of settled.elements) {
      const hit = el.kind === "text" ? measured[el.id] : undefined;
      if (hit && hit.sig === inkSig(el)) m[el.id] = hit.box;
    }
    return coverIssues(settled, { actualPages, measured: m });
  }, [settled, actualPages, measured]);
  const selected = design?.elements.find((e) => e.id === sel) ?? null;

  // 화면에 맞춤 확대율
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || !l) return;
    const fit = () => setFitZoom(Math.max(0.1, Math.min((el.clientWidth - 48) / (l.sheetW * PX_PER_MM), (el.clientHeight - 48) / (l.sheetH * PX_PER_MM))));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [l?.sheetW, l?.sheetH]);
  const z = zoom ?? fitZoom;

  /* ---------- 확대한 펼침면 둘러보기: 스크롤 · 끌어 옮기기 · Ctrl+휠 확대 ---------- */

  // 확대·축소해도 보던 곳이 그대로 있게 — 기준점(화면 가운데 또는 휠을 굴린 자리)이 가리키던 비율을 기억했다가 다시 맞춘다
  const zoomAnchor = useRef<{ rx: number; ry: number; ax: number; ay: number } | null>(null);
  const zoomTo = useCallback((next: number | null, at?: { x: number; y: number }) => {
    const el = canvasRef.current;
    if (el) {
      const r = el.getBoundingClientRect();
      const ax = at ? at.x - r.left : el.clientWidth / 2;
      const ay = at ? at.y - r.top : el.clientHeight / 2;
      zoomAnchor.current = { rx: (el.scrollLeft + ax) / Math.max(1, el.scrollWidth), ry: (el.scrollTop + ay) / Math.max(1, el.scrollHeight), ax, ay };
    }
    setZoom(next === null ? null : Math.max(0.1, Math.min(4, next)));
  }, []);
  useLayoutEffect(() => {
    const el = canvasRef.current;
    const a = zoomAnchor.current;
    if (!el || !a) return;
    zoomAnchor.current = null;
    el.scrollLeft = a.rx * el.scrollWidth - a.ax;
    el.scrollTop = a.ry * el.scrollHeight - a.ay;
  }, [z]);

  // Ctrl(⌘)+휠: 마우스가 있는 곳을 기준으로 확대·축소 (그냥 휠은 위아래, Shift+휠은 좌우 스크롤)
  const zNow = useRef(z);
  zNow.current = z;
  // 펼침면(캔버스)은 불러온 뒤에 생긴다 — 그려질 때마다 보고, 처음 생긴 캔버스에 한 번만 붙인다
  const wheelEl = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || wheelEl.current === el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomTo(zNow.current * Math.exp(-e.deltaY * 0.0015), { x: e.clientX, y: e.clientY });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    wheelEl.current = el;
  });

  // 끌어서 둘러보기 — 빈 곳(요소가 아닌 곳)을 끌거나, 스페이스바를 누른 채 끌거나, 가운데 버튼으로 끌면 화면이 따라 움직인다
  const [spaceDown, setSpaceDown] = useState(false);
  const [panning, setPanning] = useState(false);
  useEffect(() => {
    const typing = () => {
      const t = document.activeElement as HTMLElement | null;
      return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
    };
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !typing()) {
        e.preventDefault(); // 화면이 아래로 내려가지 않게
        setSpaceDown(true);
      }
    };
    const up = (e: KeyboardEvent) => e.code === "Space" && setSpaceDown(false);
    const blur = () => setSpaceDown(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);
  const startPan = (e: ReactPointerEvent) => {
    const el = canvasRef.current;
    if (!el) return;
    const sx = e.clientX;
    const sy = e.clientY;
    const left = el.scrollLeft;
    const top = el.scrollTop;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (!moved && Math.hypot(dx, dy) < 4) return; // 그냥 누른 것(선택 해제)은 그대로
      if (!moved) {
        moved = true;
        setPanning(true);
      }
      el.scrollLeft = left - dx;
      el.scrollTop = top - dy;
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      setPanning(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };
  const onCanvasPointerDownCapture = (e: ReactPointerEvent) => {
    if (maskMode && e.button === 0 && !spaceDown) return; // 고칠 부분을 그리는 중
    const onEl = !!(e.target as HTMLElement).closest("[data-el]");
    const force = spaceDown || e.button === 1;
    if (force) {
      // 스페이스바·가운데 버튼: 요소 위에서도 끌어 옮기지 않고 화면만 움직인다
      e.preventDefault();
      e.stopPropagation();
      startPan(e);
    } else if (e.button === 0 && !onEl && !(e.target as HTMLElement).closest("button,input,textarea,select,a")) startPan(e);
  };

  const patchEl = (id: string, patch: Partial<TextEl> | Partial<ImageEl>, key?: string) =>
    update((d) => ({ ...d, elements: d.elements.map((e) => (e.id === id ? ({ ...e, ...patch } as CoverEl) : e)) }), key ?? `el:${id}:${Object.keys(patch).join(",")}`);

  /* ---------- 끌어 옮기기·크기 조절 ---------- */

  const drag = useRef<{ id: string; kind: "move" | "resize"; sx: number; sy: number; el: CoverEl; before: CoverDesign; moved: boolean } | null>(null);

  const onElPointerDown = (e: ReactPointerEvent, el: CoverEl) => {
    e.stopPropagation();
    if (e.button !== 0 || !design) return;
    setSel(el.id);
    drag.current = { id: el.id, kind: "move", sx: e.clientX, sy: e.clientY, el, before: design, moved: false };
  };
  const onResizePointerDown = (e: ReactPointerEvent, el: CoverEl) => {
    if (e.button !== 0 || !design) return;
    drag.current = { id: el.id, kind: "resize", sx: e.clientX, sy: e.clientY, el, before: design, moved: false };
  };

  // 끌기 처리는 창에 한 번만 붙이고(최신 배치·확대율은 ref로 읽는다), 움직임은 화면 갱신 한 번(requestAnimationFrame)에 한 번만 반영한다
  const lRef = useRef(l);
  const zRef = useRef(z);
  useEffect(() => {
    lRef.current = l;
    zRef.current = z;
  });

  useEffect(() => {
    let raf = 0;
    let last: PointerEvent | null = null;
    const r1 = (n: number) => Math.round(n * 10) / 10;
    const apply = () => {
      raf = 0;
      const g = drag.current;
      const lay = lRef.current;
      const e = last;
      if (!g || !lay || !e) return;
      const zz = zRef.current;
      const dx = (e.clientX - g.sx) / (PX_PER_MM * zz);
      const dy = (e.clientY - g.sy) / (PX_PER_MM * zz);
      if (!g.moved && Math.hypot(dx, dy) * PX_PER_MM * zz < 3) return;
      if (!g.moved) {
        g.moved = true;
        setFrozen(g.before);
      }
      const el0 = g.el;
      let patch: Partial<TextEl> | Partial<ImageEl>;
      let snap: number | null = null;
      if (g.kind === "resize") {
        if (el0.kind === "image") {
          const w = Math.max(5, el0.w + dx);
          patch = { w: r1(w), h: r1(w * (el0.h / el0.w)) };
        } else patch = { w: r1(Math.max(5, el0.w + (el0.vertical ? dy : dx))) };
      } else {
        let x = el0.x + dx;
        const y = el0.y + dy;
        // 패널 가운데 맞춤 (±1.5mm)
        const p = lay.panels[el0.panel];
        const w = boxWidth(el0);
        if (p && Math.abs(x + w / 2 - p.w / 2) < 1.5 && !e.altKey) {
          x = p.w / 2 - w / 2;
          snap = p.x + p.w / 2;
        }
        patch = { x: r1(x), y: r1(y) };
      }
      setSnapX(snap);
      setDesign((d) => (d ? { ...d, elements: d.elements.map((el) => (el.id === g.id ? ({ ...el, ...patch } as CoverEl) : el)) } : d));
    };
    const move = (e: PointerEvent) => {
      if (!drag.current) return;
      last = e;
      if (!raf) raf = requestAnimationFrame(apply);
    };
    const up = () => {
      if (raf) {
        cancelAnimationFrame(raf);
        apply(); // 마지막 움직임까지 반영
      }
      const g = drag.current;
      drag.current = null;
      last = null;
      setSnapX(null);
      setFrozen(null);
      if (!g?.moved) return;
      snapshot(g.before);
      // 끌어 놓은 곳의 패널로 옮긴다 (쪽수가 바뀌어도 그 패널을 따라가게)
      setDesign((d) => {
        if (!d) return d;
        const lay = coverLayout(d);
        return {
          ...d,
          elements: d.elements.map((el) => {
            if (el.id !== g.id || g.kind !== "move") return el;
            const abs = elAbs(lay, el);
            const panel = panelAt(lay, abs.x + boxWidth(el) / 2);
            if (panel === el.panel) return el;
            return { ...el, panel, x: Math.round((abs.x - lay.panels[panel].x) * 10) / 10 };
          }),
        };
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [snapshot]);

  /* ---------- 저장·내보내기 ---------- */

  const save = async (quiet = false) => {
    if (!design) return false;
    setBusy("save");
    try {
      const r = await api<{ design: CoverDesign }>(`/api/projects/${projectId}/cover`, { method: "PUT", json: { design } });
      setDesign(r.design);
      setSavedJson(JSON.stringify(r.design));
      if (!quiet) toast.success("표지를 저장했습니다.");
      return true;
    } catch (e) {
      toastError(e, "저장 실패: ");
      return false;
    } finally {
      setBusy("");
    }
  };

  const exportCover = async (format: "pdf" | "jpg") => {
    const kind = format === "jpg" ? "JPG" : "PDF";
    if (!design || !project) return;
    const errors = issues.filter((i) => i.level === "error");
    if (errors.length) return toast.error("출력 전에 고칠 것이 있습니다:\n" + errors.map((i) => "· " + i.message).join("\n"));
    const warns = issues.filter((i) => i.level === "warn");
    if (warns.length && !(await confirmDialog(`인쇄 점검에서 확인할 것이 ${warns.length}개 있습니다.\n\n${warns.slice(0, 6).map((i) => "· " + i.message).join("\n")}\n\n그대로 ${kind}를 만들까요?`, { okLabel: `${kind} 만들기` }))) return;
    if ((dirty || !savedJson) && !(await save(true))) return;
    setBusy(format === "jpg" ? "exportJpg" : "export");
    try {
      const h = await download(`/api/projects/${projectId}/cover/export`, { format }, `${project.title}_표지.${format}`);
      if (format === "jpg") return void toast.success("JPG(300 DPI)를 만들었습니다.");
      const c = h.get("x-pdf-check");
      const check = c ? JSON.parse(decodeURIComponent(c)) : null;
      toast.success(check ? `PDF를 만들었습니다 — ${check.widthMm} × ${check.heightMm}mm${check.sizeOk ? "" : " (크기 확인 필요)"}` : "PDF를 만들었습니다.");
    } catch (e) {
      toastError(e, `${kind} 내보내기 실패: `);
    } finally {
      setBusy("");
    }
  };

  /* ---------- AI 제작 ---------- */

  const book: BookInfo | null = useMemo(
    () =>
      project
        ? { title: project.title, subtitle: project.subtitle, author: project.author, topic: project.topic, keyMessage: project.keyMessage, audience: project.audience, tone: project.tone, chapters: project.chapters.filter((c) => c.kind === "body").map((c) => c.title) }
        : null,
    [project],
  );
  // 프롬프트 미리보기는 요소를 끄는 동안 다시 만들지 않는다
  const promptText = useMemo(() => (settled && book ? buildImagePrompt(settled, book, region) : ""), [settled, book, region]);
  /** 이 영역에서 작가가 직접 고친 프롬프트 (없으면 null = 자동) */
  const ownPrompt = design?.ai.prompts?.[region] ?? null;
  const setOwnPrompt = (text: string | null) =>
    update((d) => {
      const prompts = { ...d.ai.prompts };
      // 자동 프롬프트와 같아지거나 비우면 자동으로 돌아간다
      if (text == null || !text.trim() || text === promptText) delete prompts[region];
      else prompts[region] = text.slice(0, PROMPT_MAX);
      return { ...d, ai: { ...d.ai, prompts } };
    }, `ai.prompt.${region}`);

  // 영역을 바꾸면 지정한 부분은 버린다
  useEffect(() => {
    setMaskRect(null);
    setMaskMode(false);
  }, [region]);

  useEffect(() => {
    if (busy !== "ai" && busy !== "edit") return;
    const t0 = Date.now();
    setElapsed(0);
    const t = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(t);
  }, [busy]);

  const runAi = async () => {
    if (!design || !l) return;
    if (design.images[region] && !(await confirmDialog(`${REGION_LABEL[region]}에 이미 그림이 있습니다. 새 그림으로 바꿀까요? (지금 그림은 아래 ‘만든 그림’에서 다시 고를 수 있습니다)`, { okLabel: "새로 만들기" }))) return;
    setBusy("ai");
    const ctrl = new AbortController();
    aiAbort.current = ctrl;
    try {
      const r = await api<{ assetId: string; widthPx: number; heightPx: number; spineMm: number; native: { width: number; height: number }; history: CoverDesign["ai"]["history"] }>(
        `/api/projects/${projectId}/cover/generate`,
        { method: "POST", json: { design, region }, signal: ctrl.signal },
      );
      update((d) => ({
        ...d,
        images: { ...d.images, [region]: { assetId: r.assetId, widthPx: r.widthPx, heightPx: r.heightPx, fit: "cover", posX: 50, posY: 50, zoom: 1, ai: true, spineMm: r.spineMm } },
        ai: { ...d.ai, history: r.history },
      }));
      toast.success(`${REGION_LABEL[region]} 그림을 만들었습니다 — 모델 출력 ${r.native.width}×${r.native.height}px → 인쇄용 ${r.widthPx}×${r.heightPx}px (300 DPI)`);
    } catch (e: any) {
      if (!ctrl.signal.aborted) toastError(e, "AI 제작 실패: ");
    } finally {
      aiAbort.current = null;
      setBusy("");
    }
  };

  /** 지금 그림을 수정 요청대로 고친다 — 위치·확대 설정은 그대로 두고 그림만 바꾼다 */
  const runEdit = async () => {
    if (!design) return;
    const cur = design.images[region];
    if (!cur || !editPrompt.trim()) return;
    setBusy("edit");
    setMaskMode(false);
    const ctrl = new AbortController();
    aiAbort.current = ctrl;
    try {
      const r = await api<{ assetId: string; widthPx: number; heightPx: number; masked: boolean; history: CoverDesign["ai"]["history"] }>(
        `/api/projects/${projectId}/cover/edit`,
        { method: "POST", json: { design, region, prompt: editPrompt, rect: maskRect }, signal: ctrl.signal },
      );
      update((d) => {
        const old = d.images[region];
        return { ...d, images: { ...d.images, [region]: { ...(old ?? cur), assetId: r.assetId, widthPx: r.widthPx, heightPx: r.heightPx } }, ai: { ...d.ai, history: r.history } };
      });
      // 고친 뒤에는 지정한 부분(보라 테두리)을 치운다 — 실패하면 그대로 두어 다시 요청할 수 있게
      setMaskRect(null);
      toast.success(`${r.masked ? "지정한 부분을" : "그림을"} 고쳤습니다. 마음에 들지 않으면 되돌리기(Ctrl+Z)나 [만든 그림]에서 이전 그림을 고르세요.`);
    } catch (e: any) {
      if (!ctrl.signal.aborted) toastError(e, "그림 수정 실패: ");
    } finally {
      aiAbort.current = null;
      setBusy("");
    }
  };

  /** 만든 그림 삭제 — 서버에서 이미지(DB·저장소)를 지우고, 쓰던 영역에서도 뺀다 */
  const deleteHistory = async (assetId: string) => {
    if (!design) return;
    const used = (Object.entries(design.images) as [Region, CoverImage | undefined][]).filter(([, i]) => i?.assetId === assetId).map(([r]) => REGION_LABEL[r]);
    const ok = await confirmDialog(
      used.length ? `이 그림은 지금 ${used.join(", ")}에 쓰고 있습니다. 삭제하면 그 영역에서도 빠지고 되돌릴 수 없습니다. 삭제할까요?` : "이 그림을 삭제할까요? 저장소에서도 지워져 되돌릴 수 없습니다.",
      { okLabel: "삭제", danger: true },
    );
    if (!ok) return;
    setDeleting(assetId);
    try {
      await api(`/api/projects/${projectId}/cover/images/${assetId}`, { method: "DELETE" });
      const strip = (d: CoverDesign): CoverDesign => ({
        ...d,
        images: Object.fromEntries(Object.entries(d.images).filter(([, i]) => i?.assetId !== assetId)) as CoverDesign["images"],
        ai: { ...d.ai, history: d.ai.history.filter((h) => h.assetId !== assetId) },
      });
      update(strip);
      // 되돌리기 기록에도 지운 그림이 남지 않게 한다 (되돌리면 없는 파일을 가리키게 된다)
      undo.current = undo.current.map(strip);
      redo.current = redo.current.map(strip);
      // 서버는 저장본에서도 지웠으므로 ‘저장됨’ 기준도 맞춘다
      setSavedJson((j) => (j ? JSON.stringify(strip(JSON.parse(j))) : j));
      toast.success("그림을 삭제했습니다.");
    } catch (e) {
      toastError(e, "삭제 실패: ");
    } finally {
      setDeleting(null);
    }
  };

  /* ---------- 이미지 올리기 ---------- */

  const pickFile = (): Promise<File | null> =>
    new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/png,image/jpeg,image/webp";
      input.onchange = () => resolve(input.files?.[0] ?? null);
      input.click();
    });

  const uploadImage = async () => {
    const file = await pickFile();
    if (!file) return null;
    setBusy("upload");
    try {
      const fd = new FormData();
      fd.append("projectId", projectId);
      await attachFile(fd, "file", file);
      return await api<{ id: string; widthPx: number; heightPx: number }>("/api/assets", { method: "POST", body: fd });
    } catch (e) {
      toastError(e, "이미지 올리기 실패: ");
      return null;
    } finally {
      setBusy("");
    }
  };

  const uploadRegion = async () => {
    const a = await uploadImage();
    if (!a) return;
    update((d) => ({ ...d, images: { ...d.images, [region]: { assetId: a.id, widthPx: a.widthPx, heightPx: a.heightPx, fit: "cover", posX: 50, posY: 50, zoom: 1 } } }));
  };

  const addPhoto = async () => {
    const a = await uploadImage();
    if (!a || !l) return;
    const panel: PanelId = l.flap ? "frontFlap" : "back";
    const w = 34;
    const el: ImageEl = { id: newId(), kind: "image", panel, x: 12, y: 16, w, h: Math.round(w * (a.heightPx / a.widthPx) * 10) / 10, assetId: a.id, widthPx: a.widthPx, heightPx: a.heightPx, radius: 0, round: false };
    update((d) => ({ ...d, elements: [...d.elements, el] }));
    setSel(el.id);
  };

  const addText = (panel: PanelId, patch: Partial<TextEl>) => {
    if (!l) return;
    const p = l.panels[panel];
    if (!p || p.w <= 0) return toast.error(`${PANEL_LABEL[panel]}이 없습니다. 위에서 날개를 켜세요.`);
    const base = textDefaults();
    const w = patch.w ?? (panel === "spine" ? 120 : Math.max(20, p.w - 24));
    const el: TextEl = { ...base, x: panel === "spine" ? Math.max(0, p.w / 2 - ((patch.sizePt ?? base.sizePt) * 0.3528 * 1.2) / 2) : 12, y: 24, ...patch, w, panel, id: newId() };
    update((d) => ({ ...d, elements: [...d.elements, el] }));
    setSel(el.id);
    setTimeout(() => textRef.current?.select(), 50);
  };

  /* ---------- 키보드 ---------- */

  // 처리 함수는 렌더마다 새로 두되(최신 상태를 읽게), 창 리스너는 한 번만 붙인다
  const keyRef = useRef<((e: KeyboardEvent) => void) | null>(null);
  useEffect(() => {
    const f = (e: KeyboardEvent) => keyRef.current?.(e);
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, []);
  useEffect(() => {
    keyRef.current = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.closest("input, textarea, select, [contenteditable]") !== null);
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
        return;
      }
      if (typing) return;
      if (e.key === "Escape" && maskMode) {
        setMaskMode(false);
        return;
      }
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) doRedo();
        else doUndo();
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        doRedo();
      } else if (!selected) return;
      else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        update((d) => ({ ...d, elements: d.elements.filter((x) => x.id !== selected.id) }));
        setSel(null);
      } else if (e.key === "Escape") setSel(null);
      else if (mod && e.key.toLowerCase() === "d") {
        e.preventDefault();
        const copy = { ...selected, id: newId(), x: selected.x + 3, y: selected.y + 3 };
        update((d) => ({ ...d, elements: [...d.elements, copy] }));
        setSel(copy.id);
      } else if (e.key.startsWith("Arrow")) {
        e.preventDefault();
        const step = e.shiftKey ? 5 : 0.5;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        patchEl(selected.id, { x: Math.round((selected.x + dx) * 10) / 10, y: Math.round((selected.y + dy) * 10) / 10 }, `nudge:${selected.id}`);
      }
    };
  });

  if (err) return <div className="p-8 text-red-600">{err}</div>;
  if (!design || !project || !l || !book) return <div className="p-8 text-stone-400">불러오는 중…</div>;

  /** 판형·쪽수·날개 바꾸기 — 책등 폭이 바뀌면 책등 요소를 가운데 기준으로 옮긴다 */
  const setLayout = (patch: Partial<Pick<CoverDesign, "size" | "pages" | "pagesManual" | "paper" | "spineOverride" | "flaps">>, key: string) =>
    update((d) => {
      const next = { ...d, ...patch };
      return { ...next, elements: reflowSpine(d.elements, coverLayout(d).spine, coverLayout(next).spine) };
    }, key);

  const regionImg = design.images[region];
  const regionAt = regionImg ? placeImage(regionImg, regionBox(l, region)) : null;
  const rbox = regionBox(l, region);
  const regions: Region[] = ["full", ...panelsOf(l)];
  const errorCount = issues.filter((i) => i.level === "error").length;
  /** 쪽수를 직접 고쳤는데 실제 조판 쪽수와 다르면 알리고 [적용] 버튼을 보인다 */
  const pagesDiffer = actualPages != null && design.pagesManual && design.pages !== actualPages;

  return (
    <div className="flex h-screen flex-col bg-stone-100">
      <link rel="stylesheet" href={googleFontsHref()} precedence="default" />
      {/* ---------- 상단 ---------- */}
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 whitespace-nowrap border-b border-stone-200 bg-white px-4 py-2 text-sm">
        <Link href={`/projects/${projectId}`} className="btn-ghost" title="원고 편집 화면으로">
          ← 편집기
        </Link>
        <h1 className="mr-2 truncate font-semibold">
          표지 디자인 <span className="font-normal text-stone-500">— {project.title}</span>
        </h1>
        <label className="flex items-center gap-1">
          판형
          <select className="input w-auto py-1" value={design.size} onChange={(e) => setLayout({ size: e.target.value as BookSize }, "size")}>
            {(Object.keys(BOOK_SIZES) as BookSize[]).map((k) => (
              <option key={k} value={k}>
                {BOOK_SIZES[k].label}
              </option>
            ))}
          </select>
        </label>
        <label
          className="flex items-center gap-1"
          title={`책등 = {(쪽수 ÷ 2) × 0.11} + 1.6mm (미색모조 100g)\n${actualPages != null ? `책의 실제 조판 쪽수: ${actualPages}쪽` : "실제 쪽수를 아직 재지 않았습니다(집필 화면의 조판이 끝나거나 본문 PDF를 만들면 잽니다)."}\n쪽수를 고치면 직접 입력으로 바뀌고 책등 폭을 바로 다시 계산합니다.`}
        >
          쪽수
          <input
            type="number"
            min={2}
            max={3000}
            step={2}
            className="input w-20 py-1"
            value={design.pages}
            onChange={(e) => setLayout({ pages: Math.max(2, Math.round(Number(e.target.value) || 2)), pagesManual: true }, "pages")}
          />
          <span className={`text-[11px] ${design.pagesManual ? "text-amber-700" : "text-stone-400"}`}>{design.pagesManual ? "직접" : actualPages != null ? "실제" : "목표"}</span>
        </label>
        <label className="flex items-center gap-1">
          종이
          <select className="input w-auto py-1" value={design.paper} onChange={(e) => setLayout({ paper: e.target.value as Paper }, "paper")}>
            {(Object.keys(PAPERS) as Paper[]).map((k) => (
              <option key={k} value={k}>
                {PAPERS[k].label}
              </option>
            ))}
          </select>
        </label>
        <span className="rounded bg-emerald-50 px-2 py-1 text-emerald-800" title={`계산: (${design.pages} ÷ 2) × ${PAPERS[design.paper].perSheet} + ${PAPERS[design.paper].cover} = ${spineWidth(design.pages, design.paper)}mm`}>
          책등 <b>{l.spine}mm</b>
          {design.spineOverride != null && <span className="text-emerald-600"> (직접 입력)</span>}
        </span>
        <label className="flex items-center gap-1 text-xs text-stone-500" title="인쇄소가 알려 준 책등 두께가 따로 있으면 입력 (비우면 쪽수로 계산)">
          직접
          <input
            type="number"
            min={1}
            max={200}
            step={0.1}
            placeholder="mm"
            className="input w-16 py-1"
            value={design.spineOverride ?? ""}
            onChange={(e) => setLayout({ spineOverride: e.target.value === "" ? null : Math.max(1, Number(e.target.value) || 1) }, "spineOverride")}
          />
        </label>
        <label className="flex items-center gap-1" title="날개 없음을 고르면 날개만큼 작업 사이즈가 줄어듭니다">
          <select className="input py-1" value={design.flaps ? "1" : "0"} onChange={(e) => setLayout({ flaps: e.target.value === "1" }, "flaps")}>
            <option value="1">날개 있음</option>
            <option value="0">날개 없음</option>
          </select>
        </label>
        <div className="ml-auto flex items-center gap-2 text-xs">
          {(
            [
              ["bleed", "재단 여백"],
              ["fold", "접는 선"],
              ["safe", "안전 영역"],
              ["labels", "이름"],
              ["barcode", "바코드 자리"],
            ] as [keyof Guides, string][]
          ).map(([k, label]) => (
            <label key={k} className="flex items-center gap-1" title={k === "barcode" ? BARCODE_NOTE : undefined}>
              <input type="checkbox" checked={!!guides[k]} onChange={(e) => setGuides({ ...guides, [k]: e.target.checked })} />
              {label}
            </label>
          ))}
          <span className="mx-1 h-4 border-l border-stone-300" />
          <button className="btn-ghost" onClick={doUndo} disabled={!undo.current.length} title="되돌리기 (Ctrl+Z)">
            ↶
          </button>
          <button className="btn-ghost" onClick={doRedo} disabled={!redo.current.length} title="다시 하기 (Ctrl+Shift+Z)">
            ↷
          </button>
          <button className="btn-ghost" onClick={() => zoomTo(z / 1.25)} title="축소 (Ctrl+휠)">
            −
          </button>
          <button className="btn-ghost w-14" onClick={() => zoomTo(null)} title="화면에 맞춤 — 확대한 뒤에는 빈 곳을 끌거나(스페이스바+끌기: 어디서나) 스크롤해서 둘러봅니다">
            {Math.round(z * 100)}%
          </button>
          <button className="btn-ghost" onClick={() => zoomTo(z * 1.25)} title="확대 (Ctrl+휠)">
            +
          </button>
        </div>
      </header>

      {pagesDiffer && (
        <div className="flex flex-wrap items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs text-amber-900">
          <span>
            책의 실제 조판 쪽수는 <b>{actualPages}쪽</b>입니다. 지금 표지는 직접 입력한 {design.pages}쪽(책등 {spineWidth(design.pages, design.paper)}mm)으로 계산되어 있습니다.
          </span>
          <button className="btn px-2 py-0.5 text-xs" onClick={() => setLayout({ pages: actualPages!, pagesManual: false }, "")}>
            실제 쪽수 {actualPages}쪽 적용 (책등 {spineWidth(actualPages!, design.paper)}mm)
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* ---------- 왼쪽: AI 제작 · 그림 · 글 ---------- */}
        <aside className="flex w-80 shrink-0 flex-col border-r border-stone-200 bg-white">
          <div className="flex border-b border-stone-200 text-sm">
            {(
              [
                ["ai", "AI 제작"],
                ["image", "그림·배경"],
                ["text", "글·사진"],
              ] as [Tab, string][]
            ).map(([k, label]) => (
              <button key={k} className={`flex-1 px-2 py-2 ${tab === k ? "border-b-2 border-amber-700 font-semibold text-stone-900" : "text-stone-500"}`} onClick={() => setTab(k)}>
                {label}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-auto p-3 text-sm">
            {(tab === "ai" || tab === "image") && (
              <div>
                <label className="label">채울 영역</label>
                <select className="input" value={region} onChange={(e) => setRegion(e.target.value as Region)}>
                  {regions.map((r) => (
                    <option key={r} value={r}>
                      {REGION_LABEL[r]}
                      {design.images[r] ? " ✓" : ""}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] text-stone-500">
                  {rbox.w.toFixed(1)} × {rbox.h}mm (재단 여백 포함) · 300 DPI = {pxAt300(rbox.w)} × {pxAt300(rbox.h)}px
                </p>
              </div>
            )}

            {tab === "ai" && (
              <>
                <div>
                  <label className="label">프롬프트 안</label>
                  <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-stone-600">
                    <span className="shrink-0">요청 크기</span>
                    <input
                      className="input py-0.5 font-mono text-[11px]"
                      style={{ width: 96 }}
                      value={design.ai.requestSize}
                      onChange={(e) => update((d) => ({ ...d, ai: { ...d.ai, requestSize: e.target.value.trim() || "auto" } }), "ai.size")}
                      title="auto 또는 가로x세로 (예: 1536x1024)"
                    />
                    <span className="font-mono text-stone-500">→ {requestSize(rbox, design.ai.requestSize)}</span>
                  </div>
                  <p className="mb-1 text-[11px] leading-4 text-stone-500">
                    {`${design.ai.requestSize === "auto" ? "auto: 영역 비율에 맞춘 최대 크기 · " : ""}거부되면 ${rbox.w >= rbox.h ? "1536x1024" : "1024x1536"}로 다시 요청 · 받은 그림은 ${pxForAi(rbox.w)}×${pxForAi(rbox.h)}px(${AI_DPI} DPI — 쪽수가 늘어도 300 DPI 이상)로 저장`}
                  </p>
                  <textarea
                    className={`input h-56 resize-y font-mono text-[11px] leading-4 ${ownPrompt ? "border-amber-400 bg-amber-50/40 text-stone-800" : "bg-stone-50 text-stone-600"}`}
                    spellCheck={false}
                    value={ownPrompt ?? promptText}
                    onChange={(e) => setOwnPrompt(e.target.value)}
                    aria-label="프롬프트 안 (직접 고칠 수 있음)"
                  />
                  <div className="mt-1 flex items-start justify-between gap-2 text-[11px]">
                    <p className="text-stone-500">
                      {ownPrompt
                        ? "직접 고친 프롬프트를 그대로 보냅니다. 추가 지시·체크·배치를 바꿔도 이 글은 바뀌지 않습니다."
                        : "디자이너 역할 지시·책 정보·펼침면 배치가 자동으로 들어갑니다. 여기서 바로 고쳐 쓸 수 있고, 아래 추가 지시와 체크는 바로 반영됩니다."}
                    </p>
                    {ownPrompt && (
                      <button className="btn-ghost shrink-0 px-1.5 py-0.5 text-[11px]" onClick={() => setOwnPrompt(null)} title="직접 고친 내용을 버리고 자동 프롬프트로 돌아갑니다">
                        자동으로 되돌리기
                      </button>
                    )}
                  </div>
                </div>
                <div>
                  <label className="label">추가 지시 (이 책에서 강조할 것)</label>
                  <textarea
                    className="input h-24 text-xs leading-5"
                    placeholder={"예: 따뜻한 수채화 느낌, 새벽 바다와 등대를 상징으로.\n주 독자는 30대 직장인, 차분하지만 희망적인 톤."}
                    value={design.ai.instruction}
                    onChange={(e) => update((d) => ({ ...d, ai: { ...d.ai, instruction: e.target.value } }), "ai.instruction")}
                  />
                </div>
                <label className="flex items-start gap-2 text-xs">
                  <input type="checkbox" className="mt-0.5" checked={design.ai.withTitle} onChange={(e) => update((d) => ({ ...d, ai: { ...d.ai, withTitle: e.target.checked } }))} />
                  <span>
                    제목·저자명을 그림에 넣기 <span className="text-stone-500">(앞표지 + 책등 세로). 끄면 글자 없는 배경을 만들고 제목은 [글·사진]의 글 상자로 올립니다.</span>
                  </span>
                </label>
                {busy === "ai" ? (
                  <button className="btn-primary w-full bg-red-700 hover:bg-red-800" onClick={() => aiAbort.current?.abort()}>
                    ■ 그리는 중… {elapsed}초 (1~3분) — 멈추기
                  </button>
                ) : (
                  <button className="btn-accent w-full py-2" disabled={!!busy} onClick={runAi}>
                    ✨ AI 제작 — {REGION_LABEL[region]}
                  </button>
                )}
                {regionImg && (
                  <div className="space-y-2 rounded-lg border border-violet-200 bg-violet-50/40 p-2">
                    <label className="label mb-0">이 그림 수정 — 다시 만들지 않고 고칠 것만 요청</label>
                    <textarea
                      className="input h-20 text-xs leading-5"
                      placeholder={"예: 제목 글자를 더 굵고 크게. 하늘을 노을빛으로.\n책등 글자를 흰색으로, 앞날개 쪽 장식은 지워 줘."}
                      value={editPrompt}
                      onChange={(e) => setEditPrompt(e.target.value)}
                      disabled={!!busy}
                    />
                    <div className="flex flex-wrap items-center gap-1.5 text-xs">
                      <button className={`px-2 text-xs ${maskMode ? "btn-primary" : "btn"}`} disabled={!!busy} onClick={() => setMaskMode(!maskMode)} title="캔버스에서 끌어 사각형으로 지정하면 그 부분만 바꿉니다">
                        {maskMode ? "캔버스에서 끌어 지정하세요…" : maskRect ? "부분 다시 지정" : "고칠 부분 지정 (선택)"}
                      </button>
                      {maskRect && (
                        <>
                          <span className="text-violet-800">
                            {maskRect.w.toFixed(0)} × {maskRect.h.toFixed(0)}mm만 수정
                          </span>
                          <button className="btn-ghost px-1 text-xs" onClick={() => setMaskRect(null)}>
                            지우기
                          </button>
                        </>
                      )}
                      {!maskRect && !maskMode && <span className="text-stone-500">지정하지 않으면 그림 전체에서 요청한 것만 고칩니다.</span>}
                    </div>
                    {busy === "edit" ? (
                      <button className="btn-primary w-full bg-red-700 hover:bg-red-800" onClick={() => aiAbort.current?.abort()}>
                        ■ 고치는 중… {elapsed}초 — 멈추기
                      </button>
                    ) : (
                      <button className="btn w-full border-violet-300 text-violet-900" disabled={!!busy || !editPrompt.trim()} onClick={runEdit}>
                        ✏️ 수정 요청 보내기
                      </button>
                    )}
                  </div>
                )}
                {design.ai.history.length > 0 && (
                  <div>
                    <label className="label">만든 그림 (눌러서 이 영역에 쓰기)</label>
                    <div className="grid grid-cols-2 gap-2">
                      {[...design.ai.history].reverse().map((h) => (
                        <div key={h.assetId} className="group relative">
                          <button
                            className={`block w-full overflow-hidden rounded border ${Object.values(design.images).some((i) => i?.assetId === h.assetId) ? "border-amber-600 ring-2 ring-amber-200" : "border-stone-200"}`}
                            title={`${REGION_LABEL[h.region]} · ${new Date(h.at).toLocaleString()}`}
                            disabled={deleting === h.assetId}
                            onClick={() => update((d) => ({ ...d, images: { ...d.images, [region]: { assetId: h.assetId, widthPx: h.widthPx, heightPx: h.heightPx, fit: "cover", posX: 50, posY: 50, zoom: 1, ai: true, spineMm: h.region === "full" ? l.spine : undefined } } }))}
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img alt="" src={src(h.assetId)} className={`h-16 w-full object-cover ${deleting === h.assetId ? "opacity-30" : ""}`} loading="lazy" />
                            <div className="truncate px-1 text-left text-[10px] text-stone-500">
                              {REGION_LABEL[h.region]}
                              {h.edit ? " · 수정본" : ""}
                            </div>
                          </button>
                          <button
                            className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-[11px] leading-none text-white opacity-0 transition hover:bg-red-700 group-hover:opacity-100 focus:opacity-100"
                            title="이 그림 삭제 (저장소에서도 지웁니다)"
                            aria-label="그림 삭제"
                            disabled={!!deleting || !!busy}
                            onClick={() => deleteHistory(h.assetId)}
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}

            {tab === "image" && (
              <>
                <div className="flex gap-2">
                  <button className="btn flex-1" disabled={!!busy} onClick={uploadRegion}>
                    {busy === "upload" ? "올리는 중…" : regionImg ? "다른 파일로 바꾸기" : "파일 올리기"}
                  </button>
                  {regionImg && (
                    <button className="btn" onClick={() => update((d) => ({ ...d, images: { ...d.images, [region]: undefined } }))}>
                      지우기
                    </button>
                  )}
                </div>
                <p className="text-[11px] text-stone-500">JPG·PNG·WEBP. 인쇄용은 {pxAt300(rbox.w)} × {pxAt300(rbox.h)}px 이상 (300 DPI)을 권장합니다.</p>
                {regionImg && regionAt && (
                  <ImageControls
                    img={regionImg}
                    dpi={regionAt.dpi}
                    onChange={(patch, key) => update((d) => ({ ...d, images: { ...d.images, [region]: { ...d.images[region]!, ...patch } } }), key)}
                  />
                )}
                <div>
                  <label className="label">배경색 (그림이 없는 곳)</label>
                  <ColorField value={design.bgColor} onChange={(c) => update((d) => ({ ...d, bgColor: c }), "bg")} />
                </div>
              </>
            )}

            {tab === "text" && (
              <>
                <div>
                  <label className="label">글 상자 넣기</label>
                  <div className="grid grid-cols-2 gap-1.5">
                    {TEXT_PRESETS.filter((p) => l.panels[p.panel].w > 0).map((p) => (
                      <button key={p.label} className="btn justify-start px-2 text-xs" onClick={() => addText(p.panel, p.patch)} title={`${PANEL_LABEL[p.panel]}에 넣기`}>
                        <span className="text-stone-400">{PANEL_LABEL[p.panel]}</span> {p.label}
                      </button>
                    ))}
                  </div>
                  <button
                    className="btn mt-2 w-full text-xs"
                    onClick={() => {
                      const els = titleElements(design, project);
                      update((d) => ({ ...d, elements: [...d.elements, ...els] }));
                      setSel(els[0].id);
                    }}
                  >
                    책 정보로 제목·저자·책등 글 한 번에 넣기
                  </button>
                </div>
                <div>
                  <label className="label">빈 글 상자</label>
                  <div className="flex flex-wrap gap-1">
                    {panelsOf(l).map((p) => (
                      <button key={p} className="btn px-2 text-xs" onClick={() => addText(p, { text: "글을 입력하세요", vertical: p === "spine" })}>
                        {PANEL_LABEL[p]}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="label">사진 (저자 사진 등)</label>
                  <button className="btn w-full" disabled={!!busy} onClick={addPhoto}>
                    {busy === "upload" ? "올리는 중…" : "사진 올려 넣기"}
                  </button>
                </div>
                <div>
                  <label className="label">요소 ({design.elements.length}) — 아래일수록 위에 그려짐</label>
                  <ul className="space-y-1">
                    {design.elements.map((e, i) => (
                      <li key={e.id} className={`flex items-center gap-1 rounded border px-2 py-1 text-xs ${e.id === sel ? "border-blue-400 bg-blue-50" : "border-stone-200"}`}>
                        <button className="min-w-0 flex-1 truncate text-left" onClick={() => setSel(e.id)}>
                          <span className="text-stone-400">{PANEL_LABEL[e.panel]}</span> {e.kind === "text" ? e.text.split("\n")[0] || "(빈 글)" : "사진"}
                        </button>
                        <button className="btn-ghost px-1" disabled={i === 0} title="뒤로" onClick={() => update((d) => ({ ...d, elements: move(d.elements, i, i - 1) }))}>
                          ↑
                        </button>
                        <button className="btn-ghost px-1" disabled={i === design.elements.length - 1} title="앞으로" onClick={() => update((d) => ({ ...d, elements: move(d.elements, i, i + 1) }))}>
                          ↓
                        </button>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1 text-[11px] text-stone-400">끌어서 옮기기 · 방향키 0.5mm(Shift 5mm) · Ctrl+D 복제 · Delete 삭제 · Alt를 누르고 끌면 가운데 맞춤 끔</p>
                </div>
              </>
            )}
          </div>
        </aside>

        {/* ---------- 가운데: 펼침면 ---------- */}
        {/* 확대해 화면보다 커지면 사방으로 스크롤된다 — 가운데 맞춤을 justify-center가 아니라 margin:auto로 해야 왼쪽·위로 넘친 부분도 스크롤로 닿는다 */}
        <main
          ref={canvasRef}
          className="relative min-w-0 flex-1 overflow-auto"
          style={{ cursor: panning ? "grabbing" : spaceDown ? "grab" : undefined }}
          onPointerDownCapture={onCanvasPointerDownCapture}
          onPointerDown={(e) => e.target === e.currentTarget && setSel(null)}
          onAuxClick={(e) => e.button === 1 && e.preventDefault()}
        >
          <div className="flex min-h-full w-max min-w-full p-6" onPointerDown={(e) => e.target === e.currentTarget && setSel(null)}>
            <div className="relative shadow-xl" style={{ width: l.sheetW * PX_PER_MM * z, height: l.sheetH * PX_PER_MM * z, flex: "none", margin: "auto" }}>
              <div ref={sheetRef} style={{ position: "relative", width: `${l.sheetW}mm`, height: `${l.sheetH}mm`, transform: `scale(${z})`, transformOrigin: "0 0", ["--z" as string]: z } as React.CSSProperties}>
                <CoverSheet
                  design={design}
                  assetSrc={src}
                  guides={guides}
                  selectedId={sel}
                  onElPointerDown={onElPointerDown}
                  onResizePointerDown={onResizePointerDown}
                  onElDoubleClick={(el) => {
                    setSel(el.id);
                    setTimeout(() => textRef.current?.focus(), 30);
                  }}
                  onBackgroundPointerDown={(e) => {
                    if (!(e.target as HTMLElement).closest("[data-el]")) setSel(null);
                  }}
                />
                {(maskRect || maskMode) && tab === "ai" && (
                  <MaskLayer sheetW={l.sheetW} sheetH={l.sheetH} z={z} active={maskMode} rect={maskRect} bounds={rbox} onDraw={setMaskRect} onDone={() => setMaskMode(false)} dragRef={maskDrag} />
                )}
                {snapX != null && <div style={{ position: "absolute", left: `${snapX}mm`, top: 0, height: `${l.sheetH}mm`, borderLeft: `calc(1px / ${z}) solid #f43f5e`, pointerEvents: "none" }} />}
              </div>
            </div>
          </div>
          {(busy === "ai" || busy === "edit") && (
            <div className="pointer-events-none absolute inset-x-0 top-3 mx-auto w-fit rounded-full bg-stone-900/85 px-4 py-1.5 text-sm text-white shadow">
              AI가 {REGION_LABEL[region]}을 {busy === "edit" ? "고치는" : "그리는"} 중… {elapsed}초
            </div>
          )}
          {maskMode && (
            <div className="pointer-events-none absolute inset-x-0 bottom-20 mx-auto w-fit rounded-full bg-violet-700 px-4 py-1.5 text-sm text-white shadow">
              {REGION_LABEL[region]} 안에서 고칠 부분을 끌어 사각형으로 지정하세요 (Esc 취소)
            </div>
          )}
        </main>

        {/* ---------- 오른쪽: 선택한 요소 · 인쇄 점검 ---------- */}
        <aside className="w-72 shrink-0 overflow-auto border-l border-stone-200 bg-white p-3 pb-24 text-sm">
          {selected?.kind === "text" ? (
            <TextProps el={selected} textRef={textRef} panels={panelsOf(l)} onChange={(patch, key) => patchEl(selected.id, patch, key)} onRemove={() => { update((d) => ({ ...d, elements: d.elements.filter((x) => x.id !== selected.id) })); setSel(null); }} />
          ) : selected?.kind === "image" ? (
            <ImageElProps el={selected} panels={panelsOf(l)} onChange={(patch, key) => patchEl(selected.id, patch, key)} onRemove={() => { update((d) => ({ ...d, elements: d.elements.filter((x) => x.id !== selected.id) })); setSel(null); }} />
          ) : (
            <>
              <h3 className="mb-2 font-semibold">작업 사이즈 (mm)</h3>
              <table className="w-full text-xs text-stone-600">
                <tbody>
                  <Row k="전체 (재단 여백 포함)" v={`${l.sheetW} × ${l.sheetH}`} />
                  <Row k="앞표지 · 뒷표지" v={`${l.trimW} × ${l.trimH}`} />
                  <Row k="책등" v={`${l.spine} × ${l.trimH}`} />
                  {l.flap > 0 && <Row k="날개 (좌·우)" v={`${l.flap} × ${l.trimH}`} />}
                  <Row k="재단 여백 (사방)" v={`${COVER_BLEED}`} />
                </tbody>
              </table>
              <p className="mt-2 text-[11px] leading-4 text-stone-500">
                붉은 띠는 재단되어 잘리는 여백이라 그림을 끝까지 채웁니다{l.flap > 0 ? " (날개 바깥 끝과 위·아래만)" : ""}. 초록 점선 안쪽에 글을 두세요.
              </p>
              <h3 className="mb-2 mt-5 font-semibold">
                인쇄 점검 {issues.length ? <span className={errorCount ? "text-red-600" : "text-amber-600"}>{issues.length}</span> : <span className="text-emerald-600">통과</span>}
              </h3>
              <ul className="space-y-1.5 text-xs">
                {issues.map((i, n) => (
                  <li key={n} className={`rounded px-2 py-1.5 ${i.level === "error" ? "bg-red-50 text-red-800" : "bg-amber-50 text-amber-900"}`}>
                    {i.message}
                  </li>
                ))}
                {!issues.length && <li className="text-stone-500">해상도·재단 여백·안전 영역 모두 괜찮습니다.</li>}
              </ul>
              <p className="mt-4 text-[11px] text-stone-400">요소를 누르면 여기서 글·글꼴·색·위치를 바꿀 수 있습니다.</p>
            </>
          )}
        </aside>
      </div>

      {/* ---------- 오른쪽 아래: 저장 · 내보내기 ---------- */}
      <div className="fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-xl border border-stone-200 bg-white/95 p-2 shadow-lg backdrop-blur">
        <span className={`px-1 text-xs ${dirty || !savedJson ? "text-amber-700" : "text-stone-400"}`}>{dirty || !savedJson ? "저장 안 됨" : "저장됨"}</span>
        <button className="btn" disabled={!!busy || (!dirty && !!savedJson)} onClick={() => save()} title="Ctrl+S">
          {busy === "save" ? "저장 중…" : "저장"}
        </button>
        <button className="btn" disabled={!!busy} onClick={() => exportCover("jpg")} title="재단 여백 포함 300 DPI JPG 한 장">
          {busy === "exportJpg" ? "JPG 만드는 중…" : "내보내기 (JPG)"}
        </button>
        <button className="btn-primary" disabled={!!busy} onClick={() => exportCover("pdf")} title="재단 여백 포함 인쇄용 PDF (TrimBox·BleedBox 포함)">
          {busy === "export" ? "PDF 만드는 중…" : "내보내기 (PDF)"}
        </button>
      </div>
    </div>
  );
}

/* ---------------- 작은 부품 ---------------- */

/** 요소의 가로 폭(mm) — 세로쓰기 글은 줄 두께 × 줄 수 */
/** 글 모양 서명 — 이 값이 같으면 화면에서 잰 글자 자리를 그대로 쓸 수 있다 */
function inkSig(el: CoverEl) {
  return el.kind === "text" ? [el.text, el.w, el.sizePt, el.font, el.lineHeight, el.letterSpacing, el.align, el.vertical, el.bold, el.italic].join("|") : "";
}

/** 글 상자 안에서 글자가 실제로 그려진 자리 (상자 왼쪽 위 기준 mm) — 크기 조절 손잡이 등 글이 아닌 것은 뺀다 */
function inkBoxOf(node: HTMLElement, pxPerMm: number): Box | null {
  const base = node.getBoundingClientRect();
  const range = document.createRange();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType !== Node.TEXT_NODE || !child.textContent?.trim()) continue;
    range.selectNodeContents(child);
    for (const r of Array.from(range.getClientRects())) {
      if (r.width === 0 && r.height === 0) continue;
      x0 = Math.min(x0, r.left);
      y0 = Math.min(y0, r.top);
      x1 = Math.max(x1, r.right);
      y1 = Math.max(y1, r.bottom);
    }
  }
  if (!Number.isFinite(x0) || pxPerMm <= 0) return null;
  const mm = (v: number) => Math.round((v / pxPerMm) * 100) / 100;
  return { x: mm(x0 - base.left), y: mm(y0 - base.top), w: mm(x1 - x0), h: mm(y1 - y0) };
}

function boxWidth(el: CoverEl) {
  if (el.kind === "image") return el.w;
  if (!el.vertical) return el.w;
  return el.sizePt * 0.3528 * el.lineHeight * Math.max(1, el.text.split("\n").length);
}

function move<T>(arr: T[], from: number, to: number) {
  const a = [...arr];
  const [x] = a.splice(from, 1);
  a.splice(to, 0, x);
  return a;
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <tr className="border-b border-stone-100">
      <td className="py-1">{k}</td>
      <td className="py-1 text-right font-mono">{v}</td>
    </tr>
  );
}

function NumField({ label, value, onChange, step = 0.5, min, max, suffix }: { label: string; value: number; onChange: (n: number) => void; step?: number; min?: number; max?: number; suffix?: string }) {
  return (
    <label className="block">
      <span className="label">
        {label}
        {suffix && <span className="font-normal text-stone-400"> ({suffix})</span>}
      </span>
      <input type="number" className="input py-1" step={step} min={min} max={max} value={Math.round(value * 100) / 100} onChange={(e) => e.target.value !== "" && onChange(Number(e.target.value))} />
    </label>
  );
}

function ColorField({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <input type="color" className="h-8 w-10 cursor-pointer rounded border border-stone-300" value={value || "#000000"} onChange={(e) => onChange(e.target.value)} />
      <input className="input w-24 py-1 font-mono text-xs" value={value} onChange={(e) => /^#[0-9a-fA-F]{6}$/.test(e.target.value) && onChange(e.target.value)} />
      {SWATCHES.map((c) => (
        <button key={c} title={c} className={`h-5 w-5 rounded border ${value.toLowerCase() === c ? "ring-2 ring-blue-400" : "border-stone-300"}`} style={{ background: c }} onClick={() => onChange(c)} />
      ))}
    </div>
  );
}

function PanelSelect({ value, panels, onChange }: { value: PanelId; panels: PanelId[]; onChange: (p: PanelId) => void }) {
  return (
    <label className="block">
      <span className="label">패널</span>
      <select className="input py-1" value={value} onChange={(e) => onChange(e.target.value as PanelId)}>
        {panels.map((p) => (
          <option key={p} value={p}>
            {PANEL_LABEL[p]}
          </option>
        ))}
      </select>
    </label>
  );
}

function ImageControls({ img, dpi, onChange }: { img: CoverImage; dpi: number; onChange: (patch: Partial<CoverImage>, key: string) => void }) {
  return (
    <div className="space-y-2 rounded-lg border border-stone-200 p-2">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img alt="" src={src(img.assetId)} className="h-24 w-full rounded object-cover" />
      <div className={`text-xs ${dpi < 300 ? "text-amber-700" : "text-emerald-700"}`}>
        {img.widthPx} × {img.heightPx}px · 인쇄 해상도 <b>{dpi} DPI</b> {dpi < 300 ? "(300 DPI 미만)" : "✓"}
      </div>
      <div className="flex gap-1">
        {(
          [
            ["cover", "채우기 (재단 여백까지)"],
            ["contain", "전체 보이기"],
          ] as const
        ).map(([k, label]) => (
          <button key={k} className={`flex-1 text-xs ${img.fit === k ? "btn-primary" : "btn"}`} onClick={() => onChange({ fit: k }, "fit")}>
            {label}
          </button>
        ))}
      </div>
      {(
        [
          ["posX", "가로 위치", 0, 100, 1],
          ["posY", "세로 위치", 0, 100, 1],
          ["zoom", "확대", 1, 3, 0.01],
        ] as const
      ).map(([k, label, min, max, step]) => (
        <label key={k} className="block text-xs">
          <span className="flex justify-between text-stone-600">
            {label}
            <span className="font-mono">{k === "zoom" ? `${Math.round(img[k] * 100)}%` : `${Math.round(img[k])}%`}</span>
          </span>
          <input type="range" className="w-full" min={min} max={max} step={step} value={img[k]} onChange={(e) => onChange({ [k]: Number(e.target.value) }, `img:${k}`)} />
        </label>
      ))}
    </div>
  );
}

function TextProps({ el, textRef, panels, onChange, onRemove }: { el: TextEl; textRef: React.RefObject<HTMLTextAreaElement | null>; panels: PanelId[]; onChange: (patch: Partial<TextEl>, key?: string) => void; onRemove: () => void }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">글 상자 · {PANEL_LABEL[el.panel]}</h3>
        <button className="btn-ghost text-xs text-red-700" onClick={onRemove}>
          삭제
        </button>
      </div>
      <textarea ref={textRef} className="input h-28 text-sm leading-5" value={el.text} onChange={(e) => onChange({ text: e.target.value })} placeholder="글을 입력하세요" />
      <label className="block">
        <span className="label">글꼴</span>
        <select className="input py-1" value={el.font} onChange={(e) => onChange({ font: e.target.value as FontKey })} style={{ fontFamily: FONTS[el.font].css }}>
          {(Object.keys(FONTS) as FontKey[]).map((k) => (
            <option key={k} value={k} style={{ fontFamily: FONTS[k].css }}>
              {FONTS[k].label}
            </option>
          ))}
        </select>
      </label>
      <div className="grid grid-cols-2 gap-2">
        <NumField label="크기" suffix="pt" value={el.sizePt} step={0.5} min={4} max={200} onChange={(n) => onChange({ sizePt: n })} />
        <NumField label="줄 간격" value={el.lineHeight} step={0.05} min={0.8} max={3} onChange={(n) => onChange({ lineHeight: n })} />
        <NumField label="자간" suffix="em" value={el.letterSpacing} step={0.01} min={-0.2} max={1} onChange={(n) => onChange({ letterSpacing: n })} />
        <NumField label={el.vertical ? "상자 높이" : "상자 폭"} suffix="mm" value={el.w} min={2} max={600} onChange={(n) => onChange({ w: n })} />
      </div>
      <div className="flex flex-wrap gap-1">
        <button className={`px-2 text-xs ${el.bold ? "btn-primary" : "btn"}`} onClick={() => onChange({ bold: !el.bold })}>
          <b>굵게</b>
        </button>
        <button className={`px-2 text-xs ${el.italic ? "btn-primary" : "btn"}`} onClick={() => onChange({ italic: !el.italic })}>
          <i>기울임</i>
        </button>
        {(
          [
            ["left", el.vertical ? "위" : "왼쪽"],
            ["center", "가운데"],
            ["right", el.vertical ? "아래" : "오른쪽"],
          ] as const
        ).map(([k, label]) => (
          <button key={k} className={`px-2 text-xs ${el.align === k ? "btn-primary" : "btn"}`} onClick={() => onChange({ align: k })}>
            {label}
          </button>
        ))}
        <button className={`px-2 text-xs ${el.vertical ? "btn-primary" : "btn"}`} onClick={() => onChange({ vertical: !el.vertical })} title="세로쓰기 (책등 제목)">
          세로쓰기
        </button>
      </div>
      <div>
        <span className="label">글자 색</span>
        <ColorField value={el.color} onChange={(c) => onChange({ color: c }, "color")} />
      </div>
      <div className="space-y-2 rounded-lg border border-stone-200 p-2">
        <div className="flex items-center justify-between">
          <span className="label mb-0">글 상자 배경색</span>
          <button className={`px-2 py-0.5 text-[11px] ${!el.bg ? "btn-primary" : "btn"}`} onClick={() => onChange({ bg: "" })} title="배경 없음 (투명)">
            없음
          </button>
        </div>
        <ColorField value={el.bg || "#ffffff"} onChange={(c) => onChange({ bg: c }, "bg")} />
        <label className={`block text-xs ${el.bg ? "" : "opacity-40"}`}>
          <span className="flex justify-between text-stone-600">
            배경 불투명도<span className="font-mono">{Math.round(el.bgOpacity * 100)}%</span>
          </span>
          <input type="range" className="w-full" min={0} max={1} step={0.05} disabled={!el.bg} value={el.bgOpacity} onChange={(e) => onChange({ bgOpacity: Number(e.target.value) }, "bgOpacity")} />
        </label>
        <div className={`grid grid-cols-2 gap-2 ${el.bg ? "" : "pointer-events-none opacity-40"}`}>
          <NumField label="여백" suffix="mm" value={el.bgPad} step={0.5} min={0} max={20} onChange={(n) => onChange({ bgPad: n })} />
          <NumField label="모서리" suffix="mm" value={el.bgRadius} step={0.5} min={0} max={20} onChange={(n) => onChange({ bgRadius: n })} />
        </div>
      </div>
      <div className="space-y-2 rounded-lg border border-stone-200 p-2">
        <div className="flex items-center justify-between">
          <span className="label mb-0">글자 테두리</span>
          <button className={`px-2 py-0.5 text-[11px] ${!el.strokeColor ? "btn-primary" : "btn"}`} onClick={() => onChange({ strokeColor: "" })} title="테두리 없음">
            없음
          </button>
        </div>
        <ColorField value={el.strokeColor || "#ffffff"} onChange={(c) => onChange({ strokeColor: c }, "strokeColor")} />
        <label className={`block text-xs ${el.strokeColor ? "" : "opacity-40"}`}>
          <span className="flex justify-between text-stone-600">
            테두리 굵기<span className="font-mono">{el.strokeWidth.toFixed(2)}mm</span>
          </span>
          <input type="range" className="w-full" min={0.05} max={3} step={0.05} disabled={!el.strokeColor} value={el.strokeWidth} onChange={(e) => onChange({ strokeWidth: Number(e.target.value) }, "strokeWidth")} />
        </label>
        <p className="text-[11px] text-stone-400">글자 바깥으로 선을 두릅니다. 그림 위 제목을 또렷하게 할 때 씁니다 (0.2~0.5mm 권장).</p>
      </div>
      <div className="space-y-1">
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={el.shadow} onChange={(e) => onChange({ shadow: e.target.checked })} />
          글자 그림자
        </label>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <PanelSelect value={el.panel} panels={panels} onChange={(p) => onChange({ panel: p, x: 10, y: 20 })} />
        <div />
        <NumField label="가로 위치" suffix="mm" value={el.x} onChange={(n) => onChange({ x: n })} />
        <NumField label="세로 위치" suffix="mm" value={el.y} onChange={(n) => onChange({ y: n })} />
      </div>
      <p className="text-[11px] text-stone-400">위치는 패널 왼쪽·위 재단선 기준입니다. 캔버스에서 끌어 옮기고, 파란 네모로 크기를 바꿉니다.</p>
    </div>
  );
}

function ImageElProps({ el, panels, onChange, onRemove }: { el: ImageEl; panels: PanelId[]; onChange: (patch: Partial<ImageEl>, key?: string) => void; onRemove: () => void }) {
  const dpi = Math.round(el.widthPx / (el.w / 25.4));
  const ratio = el.heightPx / el.widthPx;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">사진 · {PANEL_LABEL[el.panel]}</h3>
        <button className="btn-ghost text-xs text-red-700" onClick={onRemove}>
          삭제
        </button>
      </div>
      <div className={`text-xs ${dpi < 300 ? "text-amber-700" : "text-emerald-700"}`}>
        {el.widthPx} × {el.heightPx}px · 인쇄 해상도 <b>{dpi} DPI</b>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <NumField label="폭" suffix="mm" value={el.w} min={2} max={600} onChange={(n) => onChange({ w: n, h: Math.round(n * ratio * 10) / 10 })} />
        <NumField label="높이" suffix="mm" value={el.h} min={2} max={400} onChange={(n) => onChange({ h: n })} />
        <NumField label="모서리" suffix="mm" value={el.radius} min={0} max={100} onChange={(n) => onChange({ radius: n })} />
        <label className="flex items-end gap-2 pb-2 text-xs">
          <input type="checkbox" checked={el.round} onChange={(e) => onChange({ round: e.target.checked })} />
          원형
        </label>
        <PanelSelect value={el.panel} panels={panels} onChange={(p) => onChange({ panel: p, x: 10, y: 20 })} />
        <div />
        <NumField label="가로 위치" suffix="mm" value={el.x} onChange={(n) => onChange({ x: n })} />
        <NumField label="세로 위치" suffix="mm" value={el.y} onChange={(n) => onChange({ y: n })} />
      </div>
    </div>
  );
}

/** 그림 수정 범위 — 끌어서 사각형을 그리고(영역 안으로 제한), 지정한 부분을 보라색으로 보여 준다 */
function MaskLayer({ sheetW, sheetH, z, active, rect, bounds, onDraw, onDone, dragRef }: { sheetW: number; sheetH: number; z: number; active: boolean; rect: Rect | null; bounds: Rect; onDraw: (r: Rect) => void; onDone: () => void; dragRef: React.MutableRefObject<{ x: number; y: number } | null> }) {
  const toMm = (e: ReactPointerEvent<HTMLDivElement>) => {
    const b = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - b.left) / b.width) * sheetW;
    const y = ((e.clientY - b.top) / b.height) * sheetH;
    return { x: Math.min(bounds.x + bounds.w, Math.max(bounds.x, x)), y: Math.min(bounds.y + bounds.h, Math.max(bounds.y, y)) };
  };
  const draw = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = dragRef.current;
    if (!s) return;
    const p = toMm(e);
    onDraw({ x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) });
  };
  return (
    <div
      style={{ position: "absolute", inset: 0, cursor: active ? "crosshair" : undefined, pointerEvents: active ? "auto" : "none", zIndex: 5 }}
      onPointerDown={(e) => {
        if (!active) return;
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        dragRef.current = toMm(e);
      }}
      onPointerMove={draw}
      onPointerUp={(e) => {
        if (!dragRef.current) return;
        draw(e);
        dragRef.current = null;
        onDone();
      }}
    >
      {active && <div style={{ position: "absolute", left: `${bounds.x}mm`, top: `${bounds.y}mm`, width: `${bounds.w}mm`, height: `${bounds.h}mm`, outline: `calc(2px / ${z}) dashed rgba(124, 58, 237, .7)` }} />}
      {rect && rect.w > 0 && rect.h > 0 && (
        <div style={{ position: "absolute", left: `${rect.x}mm`, top: `${rect.y}mm`, width: `${rect.w}mm`, height: `${rect.h}mm`, background: "rgba(124, 58, 237, .18)", outline: `calc(2px / ${z}) solid rgba(124, 58, 237, .95)` }} />
      )}
    </div>
  );
}
