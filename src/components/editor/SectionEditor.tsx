"use client";

import Placeholder from "@tiptap/extension-placeholder";
import { NodeSelection, type Transaction } from "@tiptap/pm/state";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/client";
import { confirmDialog, promptDialog, toast, toastError } from "../ui/feedback";
import { clearJob, jobFor, locksSection, registerApplier, runBatch, runJob, stopBatch, stopJob, useAiJobs, useLastWriteTiming, type JobMode } from "./aiJobs";
import { scheduleOutlinePreparation, scheduleSummaryPreparation } from "./preparation";
import { attachFile } from "@/lib/upload-client";
import {
  docParagraphs,
  charCount,
  charCountNoSpace,
  docToMarkdown,
  isDocEmpty,
  markdownToDoc,
  parseDoc,
  type JNode,
} from "@/lib/doc/doc";
import { DOC, bodyBox } from "@/lib/print/spec";
import type { LayoutSettings } from "@/lib/layout";
import type { ProjectTree, SectionPageInfo, TreeChapter, TreeSection } from "../types";
import { Figure } from "./Figure";
import { Footnote, type FootnoteAttrs } from "./Footnote";
import { PageBreaks, paginate, type PageGeom, type PaginateResult } from "./PageBreaks";
import ProofPanel, { type AppliedChange } from "./ProofPanel";
import { findInBlock, posAfterTerm, replaceInBlock, selectInBlock, sentenceRangeAround } from "./pmOps";
import { recoverPending, registerCommit, settleSection, useAutosave, type SaveState } from "./useAutosave";
import FindPanel from "./FindPanel";
import type { BatchItem, SectionRef } from "./BatchWriteDialog";
import { BATCH_MAX } from "./batch";
import { loadExtra, rememberExtra, saveExtra, type ExtraMemory } from "./extraMemory";
import { clearProofResult, loadProofResult, proofRunning, registerProofApplier, runProof, saveProofResult, takeProofResult, useProofJobs } from "./proofJobs";
import WritingOverlay from "./WritingOverlay";
import FootnotePopover from "./FootnotePopover";
import ToolGroup from "./ToolGroup";
import Menu from "./Menu";
import InlineDiff, { ParagraphDiff } from "../InlineDiff";

// 열 때만 필요한 창·패널은 따로 불러온다
const VersionsPanel = dynamic(() => import("./VersionsPanel"));
const ChapterReviseDialog = dynamic(() => import("./ChapterReviseDialog"));
const BatchWriteDialog = dynamic(() => import("./BatchWriteDialog"));

type Props = {
  project: ProjectTree;
  chapter: TreeChapter & { label: string };
  section: TreeSection & { label: string };
  pageInfo?: SectionPageInfo;
  onMeta: (patch: Partial<TreeSection>) => void;
  onSaved: (sectionId: string, chars: number) => void;
  onRename: (title: string) => void;
  onRenameChapter: (title: string) => void;
  onTargetPages: (n: number) => void;
  onSaveState: (s: SaveState) => void;
  onLayout: (patch: Partial<LayoutSettings>) => void;
  allSections: SectionRef[];
  onTreeChanged: () => void;
  /** 서버에서 절 본문을 고친 뒤(장 퇴고 등) 편집 화면을 다시 불러온다 */
  onServerEdited: () => void;
  /** 책 전체 찾기 창 열기 */
  onBookSearch: (query: string) => void;
  /** 이 위치로 이동해 선택 (확인 표시·검색 결과에서) — nonce가 바뀔 때마다 */
  locate?: { paragraph: number; text: string; nonce: number } | null;
};

type Loaded = { content: string; sketch: string; status: string; updatedAt: string; recovered: boolean };

export default function SectionEditor(props: Props) {
  const [data, setData] = useState<Loaded | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let alive = true;
    settleSection(props.section.id).then(() => api(`/api/sections/${props.section.id}`))
      .then(async (s) => {
        const rec = await recoverPending(props.section.id);
        if (!alive) return;
        setData({
          content: rec?.content ?? s.content,
          sketch: rec?.sketch ?? s.sketch,
          status: rec?.status ?? s.status,
          updatedAt: s.updatedAt,
          recovered: Boolean(rec),
        });
      })
      .catch((e) => setErr(e.message));
    return () => {
      alive = false;
    };
  }, [props.section.id]);
  if (err) return <div className="p-8 text-red-600">{err}</div>;
  if (!data) return <div className="p-8 text-stone-400">불러오는 중…</div>;
  return <EditorCore {...props} data={data} />;
}

function EditorCore({ project, chapter, section, pageInfo, onMeta, onSaved, onRename, onRenameChapter, onTargetPages, onSaveState, onLayout, allSections, onTreeChanged, onServerEdited, onBookSearch, locate, data }: Props & { data: Loaded }) {
  const cpp = project.charsPerPage || 700;
  const [sketch, setSketch] = useState(data.sketch);
  const [sketchOpen, setSketchOpen] = useState(!data.content || isDocEmpty(parseDoc(data.content)));
  const [status, setStatus] = useState(data.status);
  const [counts, setCounts] = useState(() => {
    const d = parseDoc(data.content);
    return { chars: charCount(d), noSpace: charCountNoSpace(d) };
  });
  const [targetPages, setTargetPages] = useState<number>(section.targetPages || 3);
  const [modeAsk, setModeAsk] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [reviseOpen, setReviseOpen] = useState(false);
  const revisedRef = useRef(false);
  const [candidate, setCandidate] = useState<string | null>(null);
  const [candCompare, setCandCompare] = useState(false);
  const [lengthHint, setLengthHint] = useState<null | { chars: number; target: number }>(null);
  const [tab, setTab] = useState<"ai" | "versions" | "proof" | "notes">("ai");
  // 추가 지시: [다른 절에서도 계속 쓰기]를 켜 두면 절을 옮겨도 남고, 집필에 쓴 지시는 최근 목록에서 다시 고를 수 있다
  const [extraMem, setExtraMem] = useState<ExtraMemory>({ keep: false, text: "", recent: [] });
  const [extra, setExtraText] = useState("");
  useEffect(() => {
    const m = loadExtra(project.id);
    setExtraMem(m);
    if (m.keep) setExtraText(m.text);
  }, [project.id]);
  const updateExtraMem = (m: ExtraMemory) => {
    setExtraMem(m);
    saveExtra(project.id, m);
  };
  const setExtra = (text: string) => {
    setExtraText(text);
    if (extraMem.keep) updateExtraMem({ ...extraMem, text });
  };
  /** 집필을 시작할 때 쓴 지시를 최근 목록에 남긴다 */
  const noteExtraUsed = (used = extra) => used.trim() && updateExtraMem(rememberExtra({ ...extraMem, text: extraMem.keep ? extra : extraMem.text }, used));
  const [proofLevel, setProofLevel] = useState<"proof" | "light">("proof");
  const [proof, setProof] = useState<AppliedChange[] | null>(null);
  // 교정도 편집기 밖에서 돈다 — 교정 중에 다른 절로 옮겨도 계속된다 (그동안 이 절만 잠근다)
  const proofJobs = useProofJobs();
  const proofJob = proofJobs.find((j) => j.sectionId === section.id) ?? null;
  const proofBusy = proofJob?.state === "running";
  const [preProof, setPreProof] = useState<JNode | null>(null);
  const [versionKey, setVersionKey] = useState(0);
  const [zoom, setZoom] = useState(() => (typeof window !== "undefined" && window.innerWidth < 1500 ? 1 : 1.25));
  const [panelOpen, setPanelOpen] = useState(() => typeof window === "undefined" || window.innerWidth >= 1280);
  const [caretPage, setCaretPage] = useState<number | null>(null); // 이 절 안에서 몇 번째 쪽(0부터)
  const [pg, setPg] = useState<PaginateResult | null>(null);
  const [selEmpty, setSelEmpty] = useState(true);
  const [bubble, setBubble] = useState<{ x: number; y: number } | null>(null);
  const [fnEdit, setFnEdit] = useState<{ pos: number; x: number; y: number } | null>(null);
  const [fnBusy, setFnBusy] = useState<null | "one" | "auto" | "regen">(null);
  const [docTick, setDocTick] = useState(0);
  const [rewriteBusy, setRewriteBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(data.recovered ? "브라우저에 보관돼 있던 최신 입력을 복원했습니다." : null);
  // 이 절의 AI 집필 작업 (편집기 밖에서 돈다 — 절을 옮겨도 계속된다)
  const aiJobs = useAiJobs();
  const job = aiJobs.find((j) => j.sectionId === section.id) ?? null;
  // 다중 집필 창에서 고를 수 없는 절 (AI 집필·교정 중)
  const busyIds = useMemo(
    () => new Set([...aiJobs.filter((j) => j.state === "running").map((j) => j.sectionId), ...proofJobs.filter((j) => j.state === "running").map((j) => j.sectionId)]),
    [aiJobs, proofJobs],
  );
  const lastTiming = useLastWriteTiming(section.id);
  const jobRef = useRef(job);
  jobRef.current = job;
  const writing = job?.state === "running" ? job : null;
  const locked = locksSection(job); // 이 절 전체를 새로 쓰는 중 → 이 절만 잠근다
  const streaming = locked ? job!.status || "집필 중…" : null;
  const streamingRef = useRef(false);
  streamingRef.current = locked;
  const candidateText = candidate ?? (job?.mode === "newVersion" && job.md ? job.md : null);
  const candidateWriting = job?.mode === "newVersion" && job.state === "running";
  const dropCandidate = () => {
    setCandidate(null);
    clearJob(section.id);
  };
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const sketchRef = useRef(sketch);
  sketchRef.current = sketch;

  const { state: saveState, markDirty, flush: flushQueue } = useAutosave(section.id, (r) => {
    onMeta({ charCount: r.charCount, status: r.status, updatedAt: r.updatedAt });
    onSaved(section.id, r.charCount);
  });
  /**
   * 입력마다 문서 전체를 JSON으로 바꾸고 글자를 세면 긴 절에서 타자가 무거워진다 → 입력이 250ms 멈추면 한 번에 한다.
   * 저장·AI 작업 전에는 commitEdit()으로 밀린 입력을 먼저 반영한다.
   */
  const editTimer = useRef<number | undefined>(undefined);
  const editorRef = useRef<Editor | null>(null);
  const commitEdit = useCallback(() => {
    if (editTimer.current === undefined) return;
    window.clearTimeout(editTimer.current);
    editTimer.current = undefined;
    const ed = editorRef.current;
    if (!ed || ed.isDestroyed || streamingRef.current) return;
    const doc = ed.getJSON() as JNode;
    const st = isDocEmpty(doc) ? (sketchRef.current.trim() ? "sketch" : "empty") : "editing";
    setStatus(st);
    setCounts({ chars: charCount(doc), noSpace: charCountNoSpace(doc) });
    markDirty({ content: JSON.stringify(doc), status: st });
  }, [markDirty]);
  const flush = useCallback(() => {
    commitEdit();
    return flushQueue();
  }, [commitEdit, flushQueue]);
  useEffect(() => {
    // Avoid speculative requests until a long section has a sketch and all edits are saved.
    if (targetPages <= 5 || !sketch.trim() || writing || tab !== "ai" || !["idle", "saved"].includes(saveState.kind)) return;
    return scheduleOutlinePreparation(section.id, { targetPages, extraInstruction: extra });
  }, [section.id, targetPages, sketch, extra, Boolean(writing), tab, saveState.kind, saveState.at]);
  useEffect(() => {
    const hide = () => document.visibilityState === "hidden" && commitEdit();
    window.addEventListener("pagehide", commitEdit);
    document.addEventListener("visibilitychange", hide);
    return () => {
      window.removeEventListener("pagehide", commitEdit);
      document.removeEventListener("visibilitychange", hide);
      commitEdit(); // 절을 옮겨도 밀린 입력을 저장 큐에 넣는다
    };
  }, [commitEdit]);
  useEffect(() => registerCommit(section.id, commitEdit), [section.id, commitEdit]);
  useEffect(() => onSaveState(saveState), [saveState, onSaveState]);
  useEffect(() => {
    if (data.recovered) markDirty({ content: data.content, sketch: data.sketch, status: data.status });
  }, [data, markDirty]);

  const statusFor = useCallback((doc: JNode) => (isDocEmpty(doc) ? (sketchRef.current.trim() ? "sketch" : "empty") : "editing"), []);

  const uploadImage = useCallback(
    async (file: File) => {
      const fd = new FormData();
      fd.append("projectId", project.id);
      await attachFile(fd, "file", file);
      const r = await api<{ id: string; src: string; widthPx: number; heightPx: number }>("/api/assets", { method: "POST", body: fd });
      return { assetId: r.id, src: r.src, widthPx: r.widthPx, heightPx: r.heightPx, layout: "fit", caption: "" };
    },
    [project.id],
  );

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ heading: { levels: [3] }, code: false, codeBlock: false, strike: false, link: false, underline: false }),
      Placeholder.configure({ placeholder: "여기에 본문을 직접 쓰거나, 위 스케치를 채우고 [집필하기]를 누르세요." }),
      Figure,
      Footnote,
      PageBreaks,
    ],
    content: parseDoc(data.content),
    editorProps: {
      attributes: { class: "book-editor-content" },
      handleDrop: (view, event) => {
        const files = [...(event.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"));
        if (!files.length) return false;
        event.preventDefault();
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.doc.content.size;
        files.forEach(async (f) => {
          try {
            const attrs = await uploadImage(f);
            view.dispatch(view.state.tr.insert(pos, view.state.schema.nodes.figure.create(attrs)));
          } catch (e: any) {
            toastError(e);
          }
        });
        return true;
      },
      handlePaste: (view, event) => {
        const files = [...(event.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
        if (!files.length) return false;
        files.forEach(async (f) => {
          try {
            const attrs = await uploadImage(f);
            view.dispatch(view.state.tr.replaceSelectionWith(view.state.schema.nodes.figure.create(attrs)));
          } catch (e: any) {
            toastError(e);
          }
        });
        return true;
      },
    },
    onUpdate: ({ editor }) => {
      if (streamingRef.current) return;
      editorRef.current = editor;
      window.clearTimeout(editTimer.current);
      editTimer.current = window.setTimeout(commitEdit, 250);
    },
    onSelectionUpdate: ({ editor }) => {
      updateCaretPage(editor);
      updateFloating(editor);
    },
    onBlur: ({ editor, event }) => {
      const to = event.relatedTarget as HTMLElement | null;
      if (!to?.closest?.("[data-fn-ui]")) setBubble(null);
      else updateFloating(editor);
    },
  });

  editorRef.current = editor;
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.setEditable(!locked && !proofBusy, false); // false: update 이벤트를 내지 않아 상태가 '수정 중'으로 바뀌지 않게
  }, [editor, locked, proofBusy]);

  /* ---------- 쪽 나눔 (실제 조판처럼 쪽마다 끊고 사이를 띄운다) ---------- */
  const margins = project.layout.margins;
  const geom = useMemo<PageGeom>(() => {
    const box = bodyBox(margins);
    return { top: box.top, bottom: box.bottom, body: box.height, padX: (DOC.width - box.width) / 2, gap: 10 };
  }, [margins]);
  // 절은 항상 새 쪽 맨 위에서 시작한다. 앞붙이·뒷붙이 첫 절 위의 장 제목은 편집 화면에도 같은 크기로 그린다.
  const leadMm = 0;
  const chapterHead = chapter.kind !== "body" && chapter.sections[0]?.id === section.id;
  const singleHead = chapterHead && chapter.sections.length === 1 && chapter.title === section.title;
  const sideOf = (k: number) => (((pageInfo?.startIdx ?? 1) + k) % 2 === 1 ? "오른쪽" : "왼쪽");
  const pageNo = useCallback(
    (k: number) => (!pageInfo ? `이 절 ${k + 1}번째 쪽` : pageInfo.start > 0 ? `${pageInfo.start + k}쪽` : `${pageInfo.startIdx + k}번째 면`),
    [pageInfo],
  );
  const pageLabel = useCallback(
    (k: number) => {
      const side = (i: number) => (((pageInfo?.startIdx ?? 1) + i) % 2 === 1 ? "오른쪽" : "왼쪽");
      const foot = pageInfo && pageInfo.start > 0 ? String(pageInfo.start + k) : "";
      return { foot, head: `${pageNo(k + 1)} · ${side(k + 1)}` };
    },
    [pageInfo, pageNo],
  );

  // 마지막 쪽 계산 뒤 처음 바뀐 문서 위치 (null = 처음부터 다시 — 글자 크기·확대·쪽 번호가 바뀐 경우)
  const dirtyFrom = useRef<number | null>(null);
  const runPaginate = useCallback(() => {
    if (!editor || editor.isDestroyed || !sheetRef.current || !scrollRef.current || !contentRef.current) return false;
    if (editor.view.composing) return false; // 한글 조합 중에는 건드리지 않는다
    const sc = scrollRef.current;
    const keep = sc.scrollTop;
    const r = paginate(editor.view, {
      sheet: sheetRef.current,
      measureHost: contentRef.current,
      geom,
      docWidthMm: DOC.width,
      leadMm,
      label: pageLabel,
      dirtyFrom: dirtyFrom.current,
    });
    dirtyFrom.current = null;
    sc.scrollTop = keep;
    setPg(r);
    updateCaretPage(editor);
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, geom, leadMm, pageLabel]);

  const pgTimer = useRef<number | undefined>(undefined);
  const pgSince = useRef(0);
  const schedulePaginate = useCallback(
    (delay = 250, changedAt?: number) => {
      // 문서 편집이면 바뀐 자리부터, 그 밖(설정·확대·글꼴)은 처음부터
      dirtyFrom.current = changedAt === undefined ? 0 : dirtyFrom.current === null ? changedAt : Math.min(dirtyFrom.current, changedAt);
      const now = Date.now();
      if (!pgSince.current) pgSince.current = now;
      window.clearTimeout(pgTimer.current);
      const wait = Math.max(0, Math.min(delay, pgSince.current + 1200 - now)); // 계속 바뀌어도 1.2초마다는 다시 잰다
      pgTimer.current = window.setTimeout(() => {
        if (runPaginate()) pgSince.current = 0;
        else pgTimer.current = window.setTimeout(() => schedulePaginate(400, dirtyFrom.current ?? 0), 400);
      }, wait);
    },
    [runPaginate],
  );

  useEffect(() => {
    if (!editor) return;
    const onTr = ({ transaction }: { transaction: Transaction }) => {
      if (!transaction.docChanged) return;
      setDocTick((t) => t + 1);
      // 이전에 기록한 위치를 이번 변경에 맞춰 옮기고, 이번에 바뀐 가장 앞 위치와 비교한다
      if (dirtyFrom.current) dirtyFrom.current = transaction.mapping.map(dirtyFrom.current, -1);
      let at = Infinity;
      transaction.mapping.maps.forEach((m, i) => m.forEach((_a, _b, start) => (at = Math.min(at, transaction.mapping.slice(i + 1).map(start, -1)))));
      schedulePaginate(250, Number.isFinite(at) ? at : 0);
    };
    const onCompEnd = () => schedulePaginate(150, dirtyFrom.current ?? editor.state.selection.from);
    editor.on("transaction", onTr);
    editor.view.dom.addEventListener("compositionend", onCompEnd);
    schedulePaginate(0);
    document.fonts?.ready.then(() => schedulePaginate(0)).catch(() => {});
    const el = contentRef.current;
    const onLoad = () => schedulePaginate(0);
    el?.addEventListener("load", onLoad, true); // 그림이 늦게 뜨면 다시 잰다
    return () => {
      editor.off("transaction", onTr);
      if (!editor.isDestroyed) editor.view.dom.removeEventListener("compositionend", onCompEnd);
      el?.removeEventListener("load", onLoad, true);
      window.clearTimeout(pgTimer.current);
    };
  }, [editor, schedulePaginate]);
  const { bodySizePt, lineHeight, paraSpacingMm } = project.layout;
  useEffect(() => schedulePaginate(0), [zoom, schedulePaginate, bodySizePt, lineHeight, paraSpacingMm]);

  // 확인 표시·문체 점검·책 전체 검색에서 고른 자리로 바로 가기 — 그 문장 전체를 골라 화면 가운데에 보이고 잠깐 강조한다.
  // 쪽 나눔 계산이 스크롤 위치를 되돌려 놓을 수 있으므로 계산이 끝난 뒤에 한 번 더 맞춘다.
  const [flash, setFlash] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  useEffect(() => {
    if (!editor || !locate) return;
    const timers: number[] = [];
    const go = (final: boolean) => {
      if (editor.isDestroyed) return;
      const r = sentenceRangeAround(editor, locate.paragraph, locate.text);
      if (!r) return;
      editor.chain().focus().setTextSelection(r).run();
      const sc = scrollRef.current;
      if (!sc || !sheetRef.current) return;
      const a = editor.view.coordsAtPos(r.from);
      const box = sc.getBoundingClientRect();
      sc.scrollTo({ top: sc.scrollTop + (a.top - box.top) - box.height / 3, behavior: final ? "smooth" : "auto" });
      if (final) {
        // 스크롤이 끝난 뒤 좌표로 강조 상자를 그린다 (지면 기준)
        timers.push(
          window.setTimeout(() => {
            if (editor.isDestroyed || !sheetRef.current) return;
            const h = sheetRef.current.getBoundingClientRect();
            const a2 = editor.view.coordsAtPos(r.from);
            const z2 = editor.view.coordsAtPos(r.to);
            const zoomF = h.width / sheetRef.current.offsetWidth || 1;
            setFlash({ top: (a2.top - h.top) / zoomF - 3, left: 0, width: sheetRef.current.offsetWidth, height: (Math.max(z2.bottom, a2.bottom) - a2.top) / zoomF + 6 });
            timers.push(window.setTimeout(() => setFlash(null), 2600));
          }, 450),
        );
      }
    };
    timers.push(window.setTimeout(() => go(false), 150));
    timers.push(window.setTimeout(() => go(true), 1300)); // 쪽 나눔(250ms~1.2s) 뒤
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [editor, locate]);

  function updateCaretPage(ed: Editor) {
    if (!contentRef.current || ed.isDestroyed) return;
    try {
      const top = ed.view.coordsAtPos(ed.state.selection.from).top;
      let k = 0;
      contentRef.current.querySelectorAll(".pg-box").forEach((b) => {
        if (b.getBoundingClientRect().bottom <= top + 1) k++;
      });
      setCaretPage(k);
    } catch {}
  }

  /** 제목 입력 칸 — 머리말처럼 절 하나뿐인 장이면 장·절 이름을 함께 바꾼다 */
  const titleBox = (title: string) => (
    <textarea
      ref={growTitle}
      rows={1}
      className="min-w-0 flex-1 resize-none overflow-hidden border-0 bg-transparent p-0 outline-none"
      defaultValue={section.title}
      onInput={(e) => {
        growTitle(e.currentTarget);
        schedulePaginate();
      }}
      onBlur={(e) => {
        const v = e.target.value.replace(/\s*\n\s*/g, " ").trim();
        if (!v || v === section.title) return;
        onRename(v);
        if (singleHead) onRenameChapter(v);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
          e.preventDefault();
          (e.target as HTMLTextAreaElement).blur();
        }
      }}
      title={title}
      style={{ font: "inherit", lineHeight: "inherit", width: "100%", wordBreak: "keep-all", overflowWrap: "break-word" }}
    />
  );

  /** 절 제목 칸 높이를 내용에 맞춘다 (긴 제목은 줄바꿈해서 모두 보이게) */
  const growTitle = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  /* ---------- 각주: 선택 말풍선 · 각주 편집 팝업 ---------- */
  function updateFloating(ed: Editor) {
    if (ed.isDestroyed) return;
    const sel = ed.state.selection;
    setSelEmpty(sel.empty);
    // 값이 같으면 이전 객체를 그대로 둔다 — 커서만 움직일 때 편집기 전체가 다시 그려지지 않게
    if (sel instanceof NodeSelection && sel.node.type.name === "footnote") {
      const c = ed.view.coordsAtPos(sel.from);
      setFnEdit((f) => (f && f.pos === sel.from && f.x === c.left && f.y === c.bottom ? f : { pos: sel.from, x: c.left, y: c.bottom }));
      setBubble(null);
      return;
    }
    if (ed.view.hasFocus()) setFnEdit(null);
    if (!sel.empty && ed.isEditable && !(sel instanceof NodeSelection)) {
      const a = ed.view.coordsAtPos(sel.from);
      setBubble((b) => (b && b.x === a.left && b.y === a.top ? b : { x: a.left, y: a.top }));
    } else setBubble(null);
  }

  /* ---------- 문서 교체 (히스토리 기록 없이) ---------- */
  const setDoc = useCallback(
    (json: JNode, history = false) => {
      if (!editor) return;
      const node = editor.schema.nodeFromJSON(json);
      const tr = editor.state.tr.replaceWith(0, editor.state.doc.content.size, node.content);
      if (!history) tr.setMeta("addToHistory", false);
      editor.view.dispatch(tr);
    },
    [editor],
  );

  const commitDoc = useCallback(
    async (st: string) => {
      if (!editor) return;
      window.clearTimeout(editTimer.current);
      editTimer.current = undefined;
      const doc = editor.getJSON() as JNode;
      setStatus(st);
      setCounts({ chars: charCount(doc), noSpace: charCountNoSpace(doc) });
      markDirty({ content: JSON.stringify(doc), status: st });
      await flush();
    },
    [editor, markDirty, flush],
  );

  /* ---------- 집필하기 ---------- */
  const targetChars = Math.round(targetPages * cpp);

  const checkLength = (chars: number) => {
    if (chars < targetChars * 0.85 || chars > targetChars * 1.15) setLengthHint({ chars, target: targetChars });
    else setLengthHint(null);
  };

  /**
   * AI 집필은 aiJobs(편집기 밖)에서 돈다 — 쓰는 동안 다른 절로 옮겨 편집해도 멈추지 않는다.
   * 이 절 전체를 새로 쓰는 동안(덮어쓰기·분량 조정)만 이 절을 잠근다. 이어쓰기는 쓰는 중에도 이 절을 고칠 수 있다.
   * 끝나면 이 편집기가 열려 있을 때 여기(applier)에서 넣고, 아니면 aiJobs가 저장 큐로 저장한다.
   */
  const jobTarget = (mode: JobMode, body: { targetPages?: number; targetChars?: number }) =>
    mode === "adjust" ? body.targetChars ?? targetChars : Math.round((body.targetPages ?? targetPages) * cpp);
  const secLabel = `${section.label} ${section.title}`.trim();

  async function startJob(url: string, body: { targetPages?: number; targetChars?: number; mode?: string; extraInstruction?: string }, mode: JobMode) {
    if (!editor) return;
    if (proofRunning(section.id)) return toast("교정·교열이 끝난 뒤에 집필하세요.");
    if (!(await flush())) return toast.error("원고 저장에 실패했습니다. 저장을 완료한 뒤 다시 집필해주세요.");
    setLengthHint(null);
    if (mode !== "continue") setSketchOpen(false);
    const figures = mode === "adjust" ? docToMarkdown(editor.getJSON() as JNode).figures : [];
    runJob({ sectionId: section.id, label: secLabel, mode, url, body, target: jobTarget(mode, body), figures }).catch((e) => toastError(e, "AI 오류: "));
  }

  // 편집기를 연 순간 이미 저장 단계였다면(결과를 여기서 넣지 못했다면) 저장된 원고를 다시 불러온다
  const appliedRef = useRef(false);
  const wasWriting = useRef(false);
  useEffect(() => {
    if (writing) {
      wasWriting.current = true;
      appliedRef.current = false;
      return;
    }
    if (wasWriting.current && !appliedRef.current && job?.mode !== "newVersion") onServerEdited();
    wasWriting.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [writing]);

  // 끝난 결과를 열린 편집기에 넣는다 (이어쓰기는 그사이 작가가 고친 본문 뒤에 붙인다)
  useEffect(() => {
    if (!editor) return;
    return registerApplier(section.id, async (job, doc) => {
      if (editor.isDestroyed) return null;
      appliedRef.current = true;
      if (job.mode === "newVersion") {
        setCandidate(job.md);
        setTab("ai");
        setPanelOpen(true);
        return null;
      }
      if (job.mode === "continue") {
        // 이어쓰기: 작가가 치고 있을 수 있다 — 앞 본문은 건드리지 않고 끝에만 한 번에 붙인다 (한글 조합 중이면 끝날 때까지 기다린다)
        await compositionDone(editor);
        if (editor.isDestroyed) return null;
        appendAtEnd(editor, doc);
      } else {
        setDoc(doc);
        scrollRef.current?.scrollTo({ top: 0 });
      }
      const d = editor.getJSON() as JNode;
      setCounts({ chars: charCount(d), noSpace: charCountNoSpace(d) });
      editor.setEditable(!proofRunning(section.id), false);
      await commitDoc("ai_draft");
      setVersionKey((k) => k + 1);
      checkLength(charCount(editor.getJSON() as JNode));
      return JSON.stringify(editor.getJSON());
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, section.id, setDoc, commitDoc, targetChars]);

  /** 여러 절(최대 3개) 한 번에 집필 — 책 순서대로 하나씩 쓰고 저장한다(앞 절 요약이 다음 절에 이어진다). 그동안 다른 절은 편집할 수 있다 */
  async function startBatch(items: BatchItem[], batchExtra: string) {
    if (!editor || !items.length) return;
    setBatchOpen(false);
    if (!(await flush())) return toast.error("원고 저장에 실패했습니다. 저장을 완료한 뒤 다시 집필해주세요.");
    try {
      for (const it of items) {
        if (it.id === section.id) {
          setSketch(it.sketch);
          setTargetPages(it.targetPages);
          markDirty({ sketch: it.sketch });
        } else await api(`/api/sections/${it.id}`, { method: "PUT", json: { sketch: it.sketch } });
        await api(`/api/projects/${project.id}/toc`, { method: "PATCH", json: { op: "updateSection", sectionId: it.id, targetPages: it.targetPages } }).catch(() => {});
      }
      await flush();
    } catch (e) {
      return toastError(e, "스케치 저장 실패: ");
    }
    const tree = onTreeChanged; // 편집기가 닫혀도 목차를 새로 고친다
    noteExtraUsed(batchExtra);
    runBatch(
      items.map((it) => ({
        sectionId: it.id,
        label: `${it.label} ${it.title}`.trim(),
        mode: "overwrite" as const,
        url: `/api/sections/${it.id}/write`,
        body: { targetPages: it.targetPages, mode: "overwrite", extraInstruction: batchExtra },
        target: Math.round(it.targetPages * cpp),
      })),
    )
      .then((done) => done.length && toast.success(`${done.length}개 절을 집필했습니다: ${done.join(", ")}`))
      .catch((e) => toastError(e, "AI 오류: "))
      .finally(tree);
  }

  const startWrite = (mode: "overwrite" | "continue" | "newVersion") => {
    setModeAsk(false);
    onTargetPages(targetPages);
    if (mode === "newVersion") {
      setCandidate(null);
      setTab("ai");
      setPanelOpen(true);
    }
    noteExtraUsed();
    startJob(`/api/sections/${section.id}/write`, { targetPages, mode, extraInstruction: extra }, mode);
  };

  const onWriteClick = async () => {
    if (!sketch.trim() && !section.gist) {
      if (!(await confirmDialog("스케치가 비어 있습니다. 목차의 절 요지만으로 쓸까요?", { okLabel: "요지만으로 쓰기" }))) return;
    }
    if (editor && !isDocEmpty(editor.getJSON() as JNode)) setModeAsk(true);
    else startWrite("overwrite");
  };

  const acceptCandidate = async () => {
    if (!candidateText || !editor) return;
    await api(`/api/sections/${section.id}/versions`, { method: "POST", json: { content: JSON.stringify(editor.getJSON()) } });
    setDoc(markdownToDoc(candidateText), true);
    dropCandidate();
    await commitDoc("ai_draft");
    api(`/api/sections/${section.id}/versions`, { method: "POST", json: { content: JSON.stringify(editor.getJSON()), reason: "ai_output" } }).catch(() => {});
    setVersionKey((k) => k + 1);
    checkLength(charCount(editor.getJSON() as JNode));
    scheduleSummaryPreparation(section.id, undefined, 0);
  };

  const undoAi = async () => {
    const vs = await api<{ id: string; reason: string }[]>(`/api/sections/${section.id}/versions`);
    const v = vs.find((x) => x.reason === "ai_write" || x.reason === "length_adjust");
    if (!v) return toast("되돌릴 AI 집필 이전 버전이 없습니다.");
    const r = await api<{ content: string }>(`/api/versions/${v.id}`, { method: "POST", json: { currentContent: JSON.stringify(editor?.getJSON()) } });
    setDoc(parseDoc(r.content), true);
    await commitDoc(statusFor(parseDoc(r.content)));
    setLengthHint(null);
    setVersionKey((k) => k + 1);
  };

  /* ---------- 교정·교열 ---------- */
  async function runProofread() {
    if (!editor) return;
    if (isDocEmpty(editor.getJSON() as JNode)) return toast("교정할 본문이 없습니다.");
    if (jobFor(section.id)?.state === "running") return toast("AI 집필이 끝난 뒤에 교정하세요.");
    if (!(await flush())) return toast.error("원고 저장을 완료한 뒤 다시 교정해주세요.");
    setTab("proof");
    setPanelOpen(true);
    setProof(null);
    runProof({ sectionId: section.id, label: secLabel, before: editor.getJSON() as JNode, level: proofLevel });
  }

  // 교정이 끝났을 때 이 편집기가 열려 있으면 여기서 고친다
  useEffect(() => {
    if (!editor) return;
    return registerProofApplier(section.id, async (changes, failed, before) => {
      if (editor.isDestroyed) return null;
      editor.setEditable(!locksSection(jobFor(section.id)), false);
      setPreProof(before);
      const applied: AppliedChange[] = changes.map((c) => ({ ...c, state: replaceInBlock(editor, c.paragraph, c.before, c.after) ? "applied" : "failed" }));
      const list = [...applied, ...failed.map((c) => ({ ...c, state: "failed" as const }))];
      setProof(list);
      await commitDoc("proofread");
      setVersionKey((k) => k + 1);
      return list;
    });
  }, [editor, section.id, commitDoc]);

  // 다른 절에 있는 동안 끝난 교정 — 서버가 적용해 두었으므로 내역만 가져온다.
  // 이 편집기를 연 뒤에 서버 적용으로 끝났다면(드문 경우) 저장된 원고를 다시 불러온다.
  const openedWhileProofing = useRef(proofBusy);
  useEffect(() => {
    if (proofJob?.state !== "done") return;
    if (openedWhileProofing.current) {
      openedWhileProofing.current = false;
      onServerEdited();
      return;
    }
    const r = takeProofResult(section.id);
    if (!r?.result) return;
    setPreProof(r.before);
    setProof(r.result);
    setTab("proof");
    setPanelOpen(true);
    setVersionKey((k) => k + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proofJob?.state]);

  // 새로 고침 뒤 — 편집기 밖에 남은 결과가 없으면 서버에 보관한 지난 교정 내역을 불러온다
  useEffect(() => {
    if (proofBusy || proofJob?.state === "done") return;
    let alive = true;
    loadProofResult(section.id).then((r) => {
      if (!alive || !r || proofRunning(section.id)) return;
      setPreProof((p) => p ?? r.before);
      setProof((p) => p ?? r.result);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section.id]);

  const revertOne = async (i: number) => {
    if (!editor || !proof) return;
    const c = proof[i];
    const ok = replaceInBlock(editor, c.paragraph, c.after, c.before);
    if (!ok) return toast.error("이미 다른 수정이 있어 이 항목만 되돌릴 수 없습니다. [전체 되돌리기]나 버전 기록을 쓰세요.");
    const next = proof.map((x, k): AppliedChange => (k === i ? { ...x, state: "reverted" } : x));
    setProof(next);
    if (preProof) void saveProofResult(section.id, { label: secLabel, before: preProof, result: next });
    await commitDoc("editing");
  };

  const revertAll = async () => {
    if (!preProof || !editor) return;
    if (!(await confirmDialog("교정 전 상태로 모두 되돌릴까요?", { okLabel: "모두 되돌리기" }))) return;
    setDoc(preProof, true);
    setProof((p) => p?.map((x) => (x.state === "applied" ? { ...x, state: "reverted" } : x)) ?? null);
    void clearProofResult(section.id);
    await commitDoc("editing");
  };

  /* ---------- 선택 영역 AI ---------- */
  type RewriteAction = "polish" | "expand" | "shorten" | "tone" | "example";
  const REWRITE_LABEL: Record<RewriteAction, string> = { polish: "다듬기", expand: "늘리기", shorten: "줄이기", tone: "톤 바꾸기", example: "예시 추가" };
  /** 선택 영역 AI 결과 — 바로 넣지 않고 원문과 비교해 보여 준 뒤 [적용]할 때 넣는다. 그동안 선택 위치가 바뀌지 않게 편집을 잠근다 */
  const [rewritePreview, setRewritePreview] = useState<null | {
    action: RewriteAction;
    from: number;
    to: number;
    selection: string;
    text: string;
    req: { selection: string; before: string; after: string; toneTarget: string };
    x: number;
    y: number;
  }>(null);

  async function requestRewrite(action: RewriteAction, from: number, to: number, req: { selection: string; before: string; after: string; toneTarget: string }) {
    if (!editor) return;
    setRewriteBusy(action);
    editor.setEditable(false, false);
    try {
      if (!(await flush())) throw new Error("원고 저장을 완료한 뒤 다시 수정해주세요.");
      const r = await api<{ text: string }>(`/api/sections/${section.id}/rewrite`, {
        method: "POST",
        json: { action, ...req, content: JSON.stringify(editor.getJSON()) },
      });
      if (editor.isDestroyed) return;
      const c = editor.view.coordsAtPos(Math.min(to, editor.state.doc.content.size));
      setRewritePreview({ action, from, to, selection: req.selection, text: r.text.trim(), req, x: c.left, y: c.bottom });
    } catch (e) {
      toastError(e);
      if (!editor.isDestroyed) editor.setEditable(!streamingRef.current, false);
    } finally {
      setRewriteBusy(null);
    }
  }

  async function rewrite(action: RewriteAction) {
    if (!editor || streaming || proofBusy || rewriteBusy || rewritePreview) return;
    const { from, to } = editor.state.selection;
    if (from === to) return toast("먼저 본문에서 고칠 부분을 드래그해 선택하세요.");
    let toneTarget = "";
    if (action === "tone") {
      toneTarget = (await promptDialog("어떤 톤으로 바꿀까요?", { choices: ["더 친근하게", "더 단호하게", "강연하듯", "더 담백하게", "더 따뜻하게"], placeholder: "직접 입력해도 됩니다", okLabel: "바꾸기" })) ?? "";
      if (!toneTarget) return;
    }
    const doc = editor.state.doc;
    await requestRewrite(action, from, to, {
      selection: doc.textBetween(from, to, NL),
      before: doc.textBetween(0, from, NL),
      after: doc.textBetween(to, doc.content.size, NL),
      toneTarget,
    });
  }

  async function applyRewrite() {
    const p = rewritePreview;
    if (!editor || !p) return;
    // 적용 전 원고를 버전으로 남긴다 (되돌리기 대비)
    await api(`/api/sections/${section.id}/versions`, { method: "POST", json: { content: JSON.stringify(editor.getJSON()), reason: "rewrite" } }).catch(() => {});
    editor.setEditable(true, false);
    const parts = markdownToDoc(p.text).content ?? [];
    const single = parts.length === 1 && parts[0].type === "paragraph";
    if (p.action === "example") {
      const $to = editor.state.doc.resolve(p.to);
      const end = $to.after($to.depth > 0 ? 1 : 0);
      editor.chain().focus().insertContentAt(end, parts).run();
    } else if (single) {
      editor.chain().focus().insertContentAt({ from: p.from, to: p.to }, parts[0].content ?? []).run();
    } else {
      editor.chain().focus().insertContentAt({ from: p.from, to: p.to }, parts).run();
    }
    setRewritePreview(null);
    setVersionKey((k) => k + 1);
  }

  function cancelRewrite() {
    setRewritePreview(null);
    if (editor && !editor.isDestroyed) {
      editor.setEditable(!streamingRef.current, false);
      editor.commands.focus();
    }
  }

  /* ---------- 각주 ---------- */
  const footnotes = useMemo(() => {
    const out: (FootnoteAttrs & { pos: number })[] = [];
    if (!editor || editor.isDestroyed) return out;
    editor.state.doc.descendants((n, pos) => {
      if (n.type.name === "footnote") out.push({ pos, ...(n.attrs as FootnoteAttrs) });
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, docTick]);

  const setFootnoteNote = (pos: number, note: string) => {
    if (!editor || editor.state.doc.nodeAt(pos)?.type.name !== "footnote") return;
    editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, "note", note));
  };

  const deleteFootnote = (pos: number) => {
    if (!editor || editor.state.doc.nodeAt(pos)?.type.name !== "footnote") return;
    editor.view.dispatch(editor.state.tr.delete(pos, pos + 1));
    setFnEdit(null);
  };

  const selectFootnote = (pos: number) => {
    if (!editor) return;
    editor.chain().focus().setNodeSelection(pos).scrollIntoView().run();
  };

  /** 선택한 단어(또는 커서 앞 어절)와 그 문단 */
  function termAtSelection() {
    if (!editor) return null;
    const { from, to, $to } = editor.state.selection;
    let term = editor.state.doc.textBetween(from, to, " ").trim();
    if (!term) {
      const before = $to.parent.textBetween(0, $to.parentOffset, " ");
      term = before.match(/([^\s"'“”‘’()[\]]+)\s*$/)?.[1]?.replace(/[.,!?·:;]+$/, "") ?? "";
    }
    return { term, at: to, context: $to.parent.textContent };
  }

  async function addFootnote(ai: boolean) {
    if (!editor || streaming || proofBusy || rewriteBusy || fnBusy) return;
    const t = termAtSelection();
    if (!t) return;
    if (ai && !t.term) return toast("각주를 달 단어를 드래그해 선택하세요.");
    if (t.term.length > 80) return toast("각주는 단어나 짧은 구절(80자 이하)에 답니다.");
    let note = "";
    if (ai) {
      setFnBusy("one");
      editor.setEditable(false, false);
      try {
        const r = await api<{ note: string }>(`/api/sections/${section.id}/footnote`, {
          method: "POST",
          json: { action: "note", term: t.term, context: t.context },
        });
        note = r.note;
      } catch (e: any) {
        toastError(e, "각주 AI 오류: ");
        return;
      } finally {
        setFnBusy(null);
        if (!editor.isDestroyed) editor.setEditable(true, false);
      }
      if (editor.isDestroyed) return;
    }
    const at = Math.min(t.at, editor.state.doc.content.size);
    editor.chain().focus().insertContentAt(at, { type: "footnote", attrs: { note, term: t.term, auto: ai } }).setNodeSelection(at).run();
  }

  async function regenFootnote(pos: number) {
    if (!editor || fnBusy) return;
    const node = editor.state.doc.nodeAt(pos);
    if (node?.type.name !== "footnote") return;
    const a = node.attrs as FootnoteAttrs;
    const $p = editor.state.doc.resolve(pos);
    const term = a.term || termAtSelection()?.term || "";
    if (!term) return toast("각주를 단 단어를 알 수 없습니다. 내용을 직접 입력하세요.");
    setFnBusy("regen");
    try {
      const r = await api<{ note: string }>(`/api/sections/${section.id}/footnote`, {
        method: "POST",
        json: { action: "note", term, context: $p.parent.textContent, current: a.note },
      });
      if (!editor.isDestroyed) {
        setFootnoteNote(pos, r.note);
        editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, "auto", true));
      }
    } catch (e: any) {
      toastError(e, "각주 AI 오류: ");
    } finally {
      setFnBusy(null);
    }
  }

  async function autoFootnote() {
    if (!editor || streaming || proofBusy || rewriteBusy || fnBusy) return;
    if (isDocEmpty(editor.getJSON() as JNode)) return toast("각주를 달 본문이 없습니다.");
    if (!await flush()) return toast.error("원고 저장을 완료한 뒤 다시 시도해주세요.");
    setFnBusy("auto");
    editor.setEditable(false, false);
    try {
      const r = await api<{ items: { paragraph: number; term: string; note: string }[] }>(`/api/sections/${section.id}/footnote`, {
        method: "POST",
        json: { action: "auto", content: JSON.stringify(editor.getJSON()) },
      });
      if (editor.isDestroyed) return;
      let n = 0;
      for (const it of r.items) {
        const pos = posAfterTerm(editor, it.paragraph, it.term);
        if (pos === null || editor.state.doc.nodeAt(pos)?.type.name === "footnote") continue;
        editor.view.dispatch(editor.state.tr.insert(pos, editor.schema.nodes.footnote.create({ note: it.note, term: it.term, auto: true })));
        n++;
      }
      setVersionKey((k) => k + 1);
      setNotice(n ? `AI가 중요 키워드 ${n}곳에 각주를 달았습니다. 보라색 번호가 AI 각주입니다 — 오른쪽 [각주] 탭에서 확인·수정하세요.` : "각주를 달 만한 키워드를 찾지 못했습니다.");
      if (n) {
        setTab("notes");
        setPanelOpen(true);
      }
    } catch (e: any) {
      toastError(e, "자동 각주 오류: ");
    } finally {
      setFnBusy(null);
      if (!editor.isDestroyed) editor.setEditable(true, false);
    }
  }

  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc || !editor) return;
    const onScroll = () => {
      if (bubble || fnEdit) updateFloating(editor);
    };
    sc.addEventListener("scroll", onScroll, { passive: true });
    return () => sc.removeEventListener("scroll", onScroll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, bubble, fnEdit]);

  /* ---------- 단축키 ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        flush();
      }
      if (e.key === "Escape" && jobRef.current?.state === "running") stopJob(section.id);
      if (e.key === "Escape") {
        setFnEdit(null);
        setBubble(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flush]);

  const onSketch = (v: string) => {
    setSketch(v);
    const st = editor && !isDocEmpty(editor.getJSON() as JNode) ? status : v.trim() ? "sketch" : "empty";
    setStatus(st);
    markDirty({ sketch: v, status: st });
  };

  const pagesNow = counts.chars / cpp;
  const pagesLabel = pageInfo && pageInfo.pages > 0 ? pageInfo.pages : pagesNow;
  // 버튼이 꺼진 이유 (툴팁으로 알려 준다)
  const busyReason = locked
    ? "AI가 이 절을 쓰는 중입니다 — 다른 절은 편집할 수 있습니다"
    : proofBusy
      ? "교정·교열 중입니다"
      : rewriteBusy || rewritePreview
        ? "선택 영역 AI 결과를 먼저 적용하거나 취소하세요"
        : fnBusy
          ? "각주 작업 중입니다"
          : "";
  const tb = (label: string, onClick: () => void, active = false, title?: string) => (
    <button
      key={label + (title ?? "")}
      title={busyReason || title || label}
      aria-label={title ?? label}
      disabled={!!busyReason}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`px-1.5 py-1 text-xs disabled:opacity-40 ${active ? "bg-stone-800 text-white" : "text-stone-700 hover:bg-stone-100"}`}
    >
      {label}
    </button>
  );

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      {/* 가운데: 편집 영역 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 상단 작업줄 */}
        <div className="flex flex-wrap items-center gap-3 border-b border-stone-300 bg-stone-200 px-4 py-2">
          <div className="min-w-[160px] flex-1 truncate text-xs text-stone-500" title="현재 절의 쪽 범위와 커서 위치">
            {pageInfo && pageInfo.start === 0 ? (
              <span>앞붙이 · 쪽 번호가 인쇄되지 않는 면 ({pageInfo.startIdx}번째 면부터)</span>
            ) : pageInfo ? (
              <>
                <b className="text-stone-700">
                  p.{pageInfo.start}
                  {pageInfo.end !== pageInfo.start && `–${pageInfo.end}`}
                </b>{" "}
                · {pageInfo.side === "right" ? "오른쪽(홀수)" : "왼쪽(짝수)"} 페이지부터 시작
                {caretPage !== null && (
                  <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 text-amber-800">
                    커서 위치 {pageNo(caretPage)} · {sideOf(caretPage)} 페이지 (안쪽 여백은 {sideOf(caretPage) === "오른쪽" ? "왼쪽" : "오른쪽"})
                  </span>
                )}
              </>
            ) : (
              <span>쪽 번호 계산 중…</span>
            )}
          </div>
          <label className="flex items-center gap-1 text-xs text-stone-600">
            분량
            <input
              type="number"
              min={0.5}
              max={60}
              step={0.5}
              className="w-14 rounded border border-stone-300 px-1.5 py-1 text-right text-sm"
              value={targetPages}
              onChange={(e) => setTargetPages(Math.max(0.5, Math.min(60, Number(e.target.value) || 1)))}
              onBlur={() => onTargetPages(targetPages)}
            />
            페이지 <span className="text-stone-400">(약 {targetChars.toLocaleString()}자)</span>
          </label>
          <button className="btn-ghost text-xs" onClick={() => setPanelOpen(!panelOpen)} title="오른쪽 패널(AI 옵션·버전·교정 내역) 열기/닫기">
            {panelOpen ? "패널 닫기 ▸" : "◂ 패널"}
          </button>
          <button
            className="btn"
            disabled={!!writing || proofBusy || !!rewriteBusy || !!fnBusy}
            onClick={runProofread}
            title={writing ? "AI 집필이 끝난 뒤에 교정할 수 있습니다" : undefined}
          >
            {proofBusy ? "교정 중…" : "교정·교열"}
          </button>
          <button
            className="btn"
            disabled={!!streaming || proofBusy || !!rewriteBusy || !!fnBusy}
            onClick={async () => {
              if (!(await flush())) return toast.error("원고 저장을 완료한 뒤 다시 시도하세요.");
              setReviseOpen(true);
            }}
            title="이 장의 절들을 한꺼번에 읽고 절 사이 중복·연결·흐름을 고칩니다"
          >
            장 퇴고
          </button>
          {writing ? (
            <button
              className="btn-primary bg-red-700 hover:bg-red-800"
              onClick={() => {
                if (writing.batch) stopBatch();
                stopJob(section.id);
              }}
              title="Esc — 쓴 데까지는 본문에 넣습니다"
            >
              ■ 중지
            </button>
          ) : (
            <div className="relative">
              <div className="flex gap-2">
                <button className="btn-accent" onClick={onWriteClick} disabled={proofBusy || !!rewriteBusy} title={proofBusy ? "교정·교열이 끝난 뒤에 집필할 수 있습니다" : undefined}>
                  ✎ AI 집필하기
                </button>
                <button
                  className="btn border-amber-600 text-amber-800 hover:bg-amber-50"
                  disabled={proofBusy || !!rewriteBusy}
                  onClick={() => {
                    setModeAsk(false);
                    setBatchOpen(true);
                  }}
                  title={`여러 절(최대 ${BATCH_MAX}개)을 골라 한 번에 집필`}
                >
                  ⧉ 다중 집필
                </button>
              </div>
              {modeAsk && (
                <div className="absolute right-0 top-10 z-30 w-64 rounded-lg border border-stone-200 bg-white p-2 shadow-xl">
                  <p className="px-2 py-1 text-xs text-stone-500">이미 본문이 있습니다. 어떻게 쓸까요?</p>
                  <button className="block w-full rounded px-2 py-2 text-left text-sm hover:bg-stone-100" onClick={() => startWrite("overwrite")}>
                    덮어쓰기 <span className="block text-xs text-stone-400">지금 본문은 버전 기록에 보관</span>
                  </button>
                  <button className="block w-full rounded px-2 py-2 text-left text-sm hover:bg-stone-100" onClick={() => startWrite("continue")}>
                    뒤에 이어쓰기 <span className="block text-xs text-stone-400">지정 분량만큼 이어서</span>
                  </button>
                  <button className="block w-full rounded px-2 py-2 text-left text-sm hover:bg-stone-100" onClick={() => startWrite("newVersion")}>
                    새 버전으로 생성(비교) <span className="block text-xs text-stone-400">오른쪽 패널에서 비교 후 선택</span>
                  </button>
                  <button
                    className="block w-full rounded px-2 py-2 text-left text-sm hover:bg-stone-100"
                    onClick={() => {
                      setModeAsk(false);
                      setBatchOpen(true);
                    }}
                  >
                    다중 집필 (최대 {BATCH_MAX}개 절) <span className="block text-xs text-stone-400">다음 절까지 이어서 집필</span>
                  </button>
                  <button className="mt-1 w-full rounded px-2 py-1 text-xs text-stone-400 hover:bg-stone-50" onClick={() => setModeAsk(false)}>
                    취소
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* 서식 도구 — 기능 묶음마다 이름표를 붙여 구분한다 */}
        <div className="space-y-1.5 border-b border-stone-300 bg-stone-100 px-3 py-1.5">
          {editor && (
            <>
              {/* 한 줄 도구줄: 본문 서식 · 각주 · 찾기 · 선택 AI · 책 서식(펼침) — 선택 AI는 드래그하면 뜨는 말풍선에도 있다 */}
              <div className="flex flex-wrap items-center gap-2">
                <ToolGroup label="본문" tone="bg-stone-700">
                  {tb("소제목", () => editor.chain().focus().toggleHeading({ level: 3 }).run(), editor.isActive("heading"))}
                  {tb("굵게", () => editor.chain().focus().toggleBold().run(), editor.isActive("bold"))}
                  {tb("기울임", () => editor.chain().focus().toggleItalic().run(), editor.isActive("italic"))}
                  {tb("인용", () => editor.chain().focus().toggleBlockquote().run(), editor.isActive("blockquote"))}
                  {tb("•", () => editor.chain().focus().toggleBulletList().run(), editor.isActive("bulletList"), "글머리 목록")}
                  {tb("1.", () => editor.chain().focus().toggleOrderedList().run(), editor.isActive("orderedList"), "번호 목록")}
                  {tb("―", () => editor.chain().focus().setHorizontalRule().run(), false, "구분선")}
                  {tb("🖼", () => fileRef.current?.click(), false, "이미지 넣기 (끌어다 놓거나 붙여 넣어도 됩니다)")}
                  {tb("↶", () => editor.chain().focus().undo().run(), false, "실행 취소 (Ctrl+Z)")}
                  {tb("↷", () => editor.chain().focus().redo().run(), false, "다시 실행 (Ctrl+Y)")}
                </ToolGroup>
                <ToolGroup label="각주" tone="bg-amber-700">
                  <button
                    title={selEmpty ? "먼저 각주를 달 단어를 드래그해 선택하세요" : busyReason || "드래그한 단어에 AI가 각주를 씁니다"}
                    disabled={selEmpty || !!busyReason}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => addFootnote(true)}
                    className={`px-1.5 py-1 text-xs ${selEmpty ? "text-stone-400" : "bg-amber-100 font-semibold text-amber-900 hover:bg-amber-200"} disabled:opacity-50`}
                  >
                    {fnBusy === "one" ? "각주 쓰는 중…" : "✦ AI 각주"}
                  </button>
                  {tb("직접", () => addFootnote(false), false, "선택한 단어(또는 커서 위치)에 각주를 달고 내용을 직접 입력합니다")}
                  {tb(fnBusy === "auto" ? "찾는 중…" : "자동", autoFootnote, false, "AI가 이 절의 중요 키워드를 골라 각주를 답니다")}
                </ToolGroup>
                <Menu
                  label={rewriteBusy ? `✦ ${REWRITE_LABEL[rewriteBusy as RewriteAction] ?? ""} 중…` : "✦ 선택 AI ▾"}
                  tone="text-violet-800"
                  disabled={!!busyReason || selEmpty}
                  title={selEmpty ? "본문을 드래그해 선택하면 다듬기·늘리기·줄이기·톤·예시를 쓸 수 있습니다" : busyReason || "선택한 부분을 AI로 고칩니다 (결과를 비교한 뒤 적용)"}
                >
                  {(Object.keys(REWRITE_LABEL) as RewriteAction[]).map((a) => (
                    <button key={a} className="block w-full px-3 py-1.5 text-left text-xs hover:bg-violet-50" onMouseDown={(e) => e.preventDefault()} onClick={() => rewrite(a)}>
                      {REWRITE_LABEL[a]}
                    </button>
                  ))}
                </Menu>
                <Menu label="서식 ▾" tone="text-sky-800" title="글자 크기·줄 간격·문단 간격 — 책 전체 본문에 적용됩니다 (미리보기·PDF·HWPX 포함)">
                  <div className="space-y-2 p-3 text-xs text-stone-600">
                    <p className="text-[11px] text-stone-500">책 전체 본문에 적용됩니다</p>
                    <label className="flex items-center justify-between gap-3">
                      글자 크기
                      <select className="rounded border border-stone-300 bg-white px-1 py-0.5 text-xs" value={bodySizePt} onChange={(e) => onLayout({ bodySizePt: Number(e.target.value) })}>
                        {[9, 9.5, 10, 10.5, 11, 11.5, 12].map((v) => (
                          <option key={v} value={v}>
                            {v}pt
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex items-center justify-between gap-3">
                      줄 간격
                      <select className="rounded border border-stone-300 bg-white px-1 py-0.5 text-xs" value={lineHeight} onChange={(e) => onLayout({ lineHeight: Number(e.target.value) })}>
                        {[1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2].map((v) => (
                          <option key={v} value={v}>
                            {Math.round(v * 100)}%
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex items-center justify-between gap-3">
                      문단 간격
                      <select className="rounded border border-stone-300 bg-white px-1 py-0.5 text-xs" value={paraSpacingMm} onChange={(e) => onLayout({ paraSpacingMm: Number(e.target.value) })}>
                        {[0, 1, 2, 3, 4, 5, 6].map((v) => (
                          <option key={v} value={v}>
                            {v ? `${v}mm` : "없음"}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                </Menu>
                <FindPanel editor={editor} onBookSearch={onBookSearch} disabled={!!busyReason} />
              </div>
            </>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f || !editor) return;
              try {
                const attrs = await uploadImage(f);
                editor.chain().focus().insertContent({ type: "figure", attrs }).run();
              } catch (er: any) {
                toastError(er);
              }
            }}
          />
        </div>

        {/* 알림 줄 */}
        {proofBusy && (
          <div className="flex items-center gap-2 border-b border-sky-200 bg-sky-50 px-4 py-2 text-sm text-sky-900">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-sky-700 border-t-transparent" />
            교정·교열 중 — 끝날 때까지 이 절은 잠겨 있습니다. 목차에서 다른 절로 옮겨 작업해도 교정은 계속되고, 끝나면 알려 드립니다.
          </div>
        )}
        {(notice || lengthHint) && (
          <div className="space-y-1 border-b border-stone-200 bg-amber-50 px-4 py-2 text-sm">
            {notice && (
              <div className="flex justify-between text-stone-700">
                {notice}
                <button className="text-xs underline" onClick={() => setNotice(null)}>
                  닫기
                </button>
              </div>
            )}
            {lengthHint && !streaming && (
              <div className="flex flex-wrap items-center gap-2 text-stone-700">
                분량이 목표({lengthHint.target.toLocaleString()}자)와 {Math.round(((lengthHint.chars - lengthHint.target) / lengthHint.target) * 100)}% 차이 납니다.
                <button
                  className="btn px-2 py-0.5 text-xs"
                  disabled={proofBusy || !!writing || !!rewriteBusy}
                  title={proofBusy ? "교정·교열이 끝난 뒤에 조정할 수 있습니다" : undefined}
                  onClick={() => startJob(`/api/sections/${section.id}/adjust`, { targetChars: lengthHint.target }, "adjust")}
                >
                  {lengthHint.chars < lengthHint.target ? "목표만큼 늘리기" : "목표만큼 줄이기"}
                </button>
                <button className="btn-ghost text-xs" onClick={undoAi}>
                  AI 쓰기 전으로 되돌리기
                </button>
                <button className="btn-ghost text-xs" onClick={() => setLengthHint(null)}>
                  그대로 두기
                </button>
              </div>
            )}
          </div>
        )}

        {/* 원고 */}
        <div className="relative flex min-h-0 flex-1 flex-col">
        {locked && job && (
          <WritingOverlay
            status={job.status}
            text={job.md.slice(-600)}
            chars={job.chars}
            target={job.target}
            step={job.batch ? { ...job.batch, label: job.label } : null}
            startedAt={job.startedAt}
            onStop={() => {
              if (job.batch) stopBatch();
              stopJob(section.id);
            }}
          />
        )}
        <div ref={scrollRef} className="editor-desk min-h-0 flex-1 overflow-auto py-6" style={{ overflowAnchor: "none" }}>
          <div style={{ zoom }} className="mx-auto w-fit">
            {/* 스케치 */}
            <div className="mb-3 rounded-lg border border-sky-200 bg-sky-50/80 font-sans" style={{ width: "154mm" }}>
              <button className="flex w-full items-center justify-between px-3 py-1.5 text-[11px] font-semibold text-sky-800" onClick={() => setSketchOpen(!sketchOpen)}>
                <span>
                  {sketchOpen ? "▾" : "▸"} 스케치 (인쇄되지 않음){!sketchOpen && sketch && <span className="ml-2 font-normal text-sky-600">{sketch.slice(0, 50)}…</span>}
                </span>
                <span className="font-normal text-sky-600">{sketch.length}자</span>
              </button>
              {sketchOpen && (
                <div className="px-3 pb-3">
                  {section.gist && <p className="mb-1.5 text-[11px] text-sky-700">목차 요지: {section.gist}</p>}
                  <textarea
                    className="w-full resize-y rounded border border-sky-200 bg-white p-2 text-[12px] leading-5 outline-none focus:border-sky-400"
                    rows={7}
                    placeholder={"개략적인 스케치를 적으세요. 예)\n- 도입: 지난주 딸이 AI에게 숙제를 물어본 장면\n- 핵심 주장: 기술보다 사람의 준비가 먼저\n- 꼭 넣을 문장: \"그때는 맞고 지금은 틀리다\"\n- 사례: 디지털 교과서 도입 논쟁"}
                    value={sketch}
                    onChange={(e) => onSketch(e.target.value)}
                  />
                </div>
              )}
            </div>

            {/* A5 원고 지면 — 실제 조판처럼 쪽마다 끊어 보여준다 (재단 여백 포함 154×216mm) */}
            <div
              ref={sheetRef}
              className="relative bg-white shadow-md"
              style={{ width: `${DOC.width}mm`, padding: `${geom.top}mm ${geom.padX}mm ${geom.bottom}mm` }}
            >
              <span className="pointer-events-none absolute inset-x-0 top-[9mm] text-center font-sans text-[8px] text-stone-400">
                {pageNo(0)} · {sideOf(0)}
              </span>
              {/* 앞붙이·뒷붙이 첫 절: 인쇄처럼 쪽 첫 줄에 장 제목 (16pt · 아래 8mm) */}
              {chapterHead && (
                <div className="font-bookhead text-[16pt]" style={{ marginBottom: "8mm", lineHeight: 1.35, fontWeight: 500 }}>
                  {singleHead ? titleBox("장 제목 (클릭해서 수정 · 목차의 장·절 이름이 함께 바뀝니다)") : <div className="whitespace-pre-wrap break-keep">{chapter.title}</div>}
                </div>
              )}
              {!singleHead && (
                <div className="mb-[6mm] flex items-baseline font-bookhead text-[13pt]" style={{ lineHeight: 1.4, fontWeight: 500 }}>
                  {section.label && <span className="mr-[2.5mm] shrink-0">{section.label}</span>}
                  {titleBox("절 제목 (클릭해서 수정 · 길면 자동 줄바꿈)")}
                </div>
              )}
              <div
                ref={contentRef}
                className="book-editor relative"
                style={{ "--body-pt": `${bodySizePt}pt`, "--body-lh": lineHeight, "--para-gap": `${paraSpacingMm}mm` } as React.CSSProperties}
              >
                <EditorContent editor={editor} />
              </div>
              {flash && (
                <div
                  aria-hidden
                  className="locate-flash pointer-events-none absolute z-10 rounded bg-amber-300/40 ring-2 ring-amber-500"
                  style={{ top: flash.top, left: flash.left, width: flash.width, height: flash.height }}
                />
              )}
              {/* 마지막 쪽 아래 각주 */}
              {pg && pg.lastNotes.length > 0 && (
                <div className="pointer-events-none absolute" style={{ left: `${geom.padX}mm`, right: `${geom.padX}mm`, bottom: `${geom.bottom}mm` }}>
                  <div className="pg-notes">
                    {pg.lastNotes.map((n) => (
                      <span key={n.n} className="pg-note">
                        <span className="pg-note-no">{n.n})</span>
                        <span>{n.text || "(내용 없음)"}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {/* 마지막 쪽을 끝까지 채워 한 쪽 크기로 */}
              <div style={{ height: `${pg ? pg.lastFill : geom.body * 0.6}mm` }} />
              {pg && pageInfo && pageInfo.start > 0 && (
                <span className="pointer-events-none absolute inset-x-0 bottom-[12mm] text-center font-sans text-[8px] text-stone-400">
                  {pageInfo.start + pg.pages - 1}
                </span>
              )}
            </div>
            {/* 이어쓰기 중: 본문은 계속 고칠 수 있고, AI 글은 다 쓰면 그때의 본문 끝에 붙는다 */}
            {writing && writing.mode === "continue" && (
              <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 font-sans text-xs text-amber-900" style={{ width: "154mm" }}>
                <div className="flex items-center gap-2">
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-amber-700 border-t-transparent" />
                  <b>AI가 이 절 끝에 이어 쓰는 중</b>
                  <span className="text-amber-700">· {writing.chars.toLocaleString()}자 · {writing.status}</span>
                  <button className="ml-auto rounded bg-red-700 px-2 py-0.5 text-white hover:bg-red-800" onClick={() => stopJob(section.id)}>
                    ■ 중지
                  </button>
                </div>
                <p className="mt-1.5 line-clamp-3 whitespace-pre-line font-book text-[12px] leading-5 text-stone-600">{writing.md.replace(/⟦주:[^⟧]*⟧/g, "").replace(/[#*>]/g, "").slice(-240) || "첫 문장을 구상하고 있습니다…"}</p>
                <p className="mt-1 text-[11px] text-amber-700">그동안 위 본문을 고쳐도 됩니다. 다 쓰면 그때의 본문 끝에 이어 붙입니다.</p>
              </div>
            )}
            <p className="mt-2 text-center font-sans text-[10px] text-stone-400">
              이 절 {pg?.pages ?? 1}쪽 · 쪽 나눔은 화면 계산값이며 최종 쪽수는 펼침면 미리보기(실제 조판)가 기준입니다
            </p>
          </div>
        </div>
        </div>

        {/* 상태 줄 */}
        <div className="flex items-center gap-4 border-t border-stone-300 bg-stone-200 px-4 py-1.5 text-xs text-stone-600">
          <span>
            {counts.chars.toLocaleString()}자 <span className="text-stone-400">(공백 제외 {counts.noSpace.toLocaleString()})</span>
          </span>
          <span>
            약 <b className="text-stone-700">{pagesLabel.toFixed(1)}</b>p / 목표 {targetPages}p
          </span>
          <span title="분당 500자 기준의 대략적인 읽기 시간">읽기 약 {Math.max(1, Math.ceil(counts.chars / 500))}분</span>
          <div className="h-1.5 w-32 overflow-hidden rounded-full bg-stone-100">
            <div className="h-full bg-amber-600" style={{ width: `${Math.min(100, (pagesLabel / targetPages) * 100)}%` }} />
          </div>
          <span className="ml-auto text-stone-400">1쪽 ≈ {Math.round(cpp)}자 (조판 결과로 자동 보정)</span>
          <label className="flex items-center gap-1" title="화면 확대 (인쇄에는 영향 없음)">
            화면
            <select className="rounded border border-stone-300 bg-white px-1 py-0 text-xs" value={zoom} onChange={(e) => setZoom(Number(e.target.value))}>
              {[1, 1.25, 1.5, 1.75].map((z) => (
                <option key={z} value={z}>
                  {Math.round(z * 100)}%
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {/* 오른쪽 보조 패널 */}
      <aside
        className={`${panelOpen ? "flex" : "hidden"} w-80 shrink-0 flex-col border-l border-stone-300 bg-stone-50 max-xl:absolute max-xl:inset-y-0 max-xl:right-0 max-xl:z-30 max-xl:shadow-2xl`}
      >
        <div className="flex border-b border-stone-200 text-sm">
          {(
            [
              ["ai", "AI 옵션"],
              ["versions", "버전 기록"],
              ["proof", "교정 내역"],
              ["notes", `각주${footnotes.length ? ` ${footnotes.length}` : ""}`],
            ] as const
          ).map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} className={`flex-1 border-b-2 py-2 ${tab === k ? "border-amber-700 font-semibold" : "border-transparent text-stone-500"}`}>
              {l}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          {tab === "ai" && (
            <div className="h-full space-y-4 overflow-auto p-3 text-sm">
              <p className="text-[11px] leading-4 text-stone-400">저장 후 입력이 20초간 멈추면 요약을 미리 갱신합니다. 스케치가 있는 5쪽 초과 절은 개요도 준비합니다.</p>
              {lastTiming && <details className="rounded border border-stone-200 p-2 text-xs text-stone-500">
                <summary className="cursor-pointer">최근 집필 {(lastTiming.totalMs / 1000).toFixed(1)}초 · 첫 본문 {lastTiming.firstTextMs === null ? "없음" : `${(lastTiming.firstTextMs / 1000).toFixed(1)}초`}</summary>
                <dl className="mt-2 grid grid-cols-2 gap-1">
                  <dt>원고 불러오기</dt><dd>{(lastTiming.loadMs / 1000).toFixed(1)}초</dd>
                  <dt>앞 내용 정리</dt><dd>{(lastTiming.summaryMs / 1000).toFixed(1)}초</dd>
                  <dt>집필 개요{lastTiming.outlineCached ? " (재사용)" : ""}</dt><dd>{(lastTiming.outlineMs / 1000).toFixed(1)}초</dd>
                  <dt>본문 생성</dt><dd>{(lastTiming.generationMs / 1000).toFixed(1)}초</dd>
                </dl>
                <p className="mt-1">첫 본문 시간은 서버 집필 시작부터, 본문 생성 시간은 모델 응답 대기를 포함합니다. 현재 탭에서 측정한 결과입니다.</p>
              </details>}
              {candidateText !== null && (
                <div className="rounded-lg border border-violet-200 bg-violet-50 p-2">
                  <div className="mb-1 flex items-center justify-between text-xs font-semibold text-violet-800">
                    새 버전 후보 {candidateWriting && "(작성 중…)"}
                    <span className="font-normal">{candidateText.length.toLocaleString()}자</span>
                  </div>
                  <label className="mb-1 flex items-center gap-1 text-[11px] text-violet-800">
                    <input type="checkbox" checked={candCompare} onChange={(e) => setCandCompare(e.target.checked)} /> 지금 본문과 비교 (바뀐 말만 표시)
                  </label>
                  {candCompare && editor ? (
                    <div className="max-h-96 overflow-auto rounded bg-white p-2 font-book text-[12px] leading-5">
                      <ParagraphDiff before={docParagraphs(editor.getJSON() as JNode)} after={docParagraphs(markdownToDoc(candidateText))} />
                    </div>
                  ) : (
                    <div className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-white p-2 font-book text-[12px] leading-5">{candidateText}</div>
                  )}
                  {!candidateWriting && (
                    <div className="mt-2 flex gap-2">
                      <button className="btn-primary px-2 py-1 text-xs" onClick={acceptCandidate}>
                        이 버전 사용
                      </button>
                      <button className="btn px-2 py-1 text-xs" onClick={dropCandidate}>
                        버리기
                      </button>
                    </div>
                  )}
                </div>
              )}
              <div>
                <label className="label" htmlFor="extra-instruction">
                  집필 추가 지시
                </label>
                <textarea
                  id="extra-instruction"
                  className="input min-h-[88px] text-xs"
                  placeholder="예: 사례를 교육 현장 위주로, 마지막은 질문으로 끝내기"
                  value={extra}
                  onChange={(e) => setExtra(e.target.value)}
                />
                <label className="mt-1 flex items-center gap-1.5 text-[11px] text-stone-600" title="끄면 이 절에서만 쓰고, 다른 절을 열면 비워집니다">
                  <input
                    type="checkbox"
                    checked={extraMem.keep}
                    onChange={(e) => updateExtraMem({ ...extraMem, keep: e.target.checked, text: e.target.checked ? extra : "" })}
                  />
                  다른 절에서도 계속 쓰기
                </label>
                {extraMem.recent.length > 0 && (
                  <div className="mt-2">
                    <div className="mb-1 text-[11px] text-stone-500">최근 쓴 지시 — 눌러서 채우기</div>
                    <ul className="space-y-1">
                      {extraMem.recent.map((r) => (
                        <li key={r} className={`group flex items-start gap-1 rounded border px-2 py-1 text-[11px] leading-4 ${r === extra.trim() ? "border-amber-400 bg-amber-50" : "border-stone-200 bg-white hover:bg-stone-50"}`}>
                          <button className="min-w-0 flex-1 text-left text-stone-700" title={r} onClick={() => setExtra(r)}>
                            <span className="line-clamp-2">{r}</span>
                          </button>
                          <button
                            className="shrink-0 text-stone-300 hover:text-red-600 group-focus-within:text-stone-400 group-hover:text-stone-400"
                            aria-label="최근 목록에서 지우기"
                            onClick={() => updateExtraMem({ ...extraMem, recent: extraMem.recent.filter((x) => x !== r) })}
                          >
                            ✕
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
              <div>
                <label className="label">교정 강도</label>
                <div className="flex gap-3 text-xs">
                  <label className="flex items-center gap-1">
                    <input type="radio" checked={proofLevel === "proof"} onChange={() => setProofLevel("proof")} /> 교정만
                  </label>
                  <label className="flex items-center gap-1">
                    <input type="radio" checked={proofLevel === "light"} onChange={() => setProofLevel("light")} /> 교정 + 가벼운 교열
                  </label>
                </div>
              </div>
              <div className="rounded-lg bg-stone-50 p-3 text-xs leading-5 text-stone-600">
                <div className="mb-1 font-semibold text-stone-700">집필 때 AI가 함께 참고하는 것</div>
                <ul className="list-disc pl-4">
                  <li>instruction.md 스타일 규칙 (항상)</li>
                  <li>책 정보 · 전체 목차 · 이 절의 요지</li>
                  <li>작가 문체 프로필 {project.styleProfile ? "✓" : "(없음 — 설정에서 학습)"}</li>
                  <li>앞 절 요약과 직전 절 마지막 문단</li>
                  <li>용어집 {project.glossary.length ? `(${project.glossary.length}개)` : "(없음)"}</li>
                </ul>
              </div>
              {section.hook && <p className="text-xs text-amber-800">✦ 흥미 포인트: {section.hook}</p>}
              <div className="text-xs text-stone-400">
                상태: {status} · 단축키: Ctrl+S 저장, Esc 집필 중지, Ctrl+↑/↓ 이전/다음 절
              </div>
            </div>
          )}
          {tab === "versions" && editor && (
            <VersionsPanel
              beforeRestore={flush}
              sectionId={section.id}
              refreshKey={versionKey}
              getCurrent={() => editor.getJSON() as JNode}
              onRestore={async (c) => {
                setDoc(parseDoc(c), true);
                await commitDoc(statusFor(parseDoc(c)));
              }}
              onSnapshot={async () => {
                await flush();
                await api(`/api/sections/${section.id}/versions`, { method: "POST", json: { content: JSON.stringify(editor.getJSON()) } });
              }}
            />
          )}
          {tab === "proof" && editor && (
            <ProofPanel
              changes={proof}
              busy={proofBusy}
              onRevert={revertOne}
              onRevertAll={revertAll}
              onLocate={(c) => selectInBlock(editor, c.paragraph, c.after) || findInBlock(editor, c.paragraph, c.after)}
            />
          )}
          {tab === "notes" && editor && (
            <div className="flex h-full flex-col text-sm">
              <div className="space-y-2 border-b border-stone-200 p-3">
                <button className="btn-accent w-full" disabled={!!fnBusy || !!streaming || proofBusy || !!rewriteBusy} onClick={autoFootnote}>
                  {fnBusy === "auto" ? "중요 키워드 찾는 중…" : "✦ AI 자동 각주 (이 절 전체)"}
                </button>
                <p className="text-[11px] leading-4 text-stone-500">
                  본문에서 단어를 드래그하면 [AI 각주]·[직접 각주]가 뜹니다. 번호를 클릭하면 내용을 고칠 수 있습니다. 보라색 = AI, 주황색 = 직접 단 각주. 인쇄·PDF에서는 쪽 아래에 번호순으로 들어갑니다.
                </p>
              </div>
              <div className="min-h-0 flex-1 space-y-2 overflow-auto p-3">
                {!footnotes.length && <p className="py-6 text-center text-xs text-stone-400">아직 각주가 없습니다.</p>}
                {footnotes.map((f, i) => (
                  <div key={`${f.pos}-${i}`} className={`rounded-lg border p-2 ${fnEdit?.pos === f.pos ? "border-amber-400 bg-amber-50/50" : "border-stone-200"}`}>
                    <div className="mb-1 flex items-center gap-1.5 text-xs">
                      <b className={f.auto ? "text-violet-700" : "text-amber-700"}>{i + 1})</b>
                      <span className="min-w-0 flex-1 truncate font-semibold text-stone-700">{f.term || "(단어 미상)"}</span>
                      {f.auto && <span className="rounded bg-violet-100 px-1 text-[10px] text-violet-700">AI</span>}
                      <button className="text-stone-500 hover:underline" onClick={() => selectFootnote(f.pos)}>
                        위치
                      </button>
                    </div>
                    <textarea
                      className="input min-h-[56px] resize-y p-1.5 text-xs leading-5"
                      placeholder="각주 내용을 입력하세요"
                      value={f.note}
                      onChange={(e) => setFootnoteNote(f.pos, e.target.value)}
                    />
                    <div className="mt-1 flex justify-end gap-2 text-[11px]">
                      <button className="text-violet-700 hover:underline disabled:opacity-40" disabled={!!fnBusy} onClick={() => regenFootnote(f.pos)}>
                        {fnBusy === "regen" && fnEdit?.pos === f.pos ? "쓰는 중…" : "AI로 다시 쓰기"}
                      </button>
                      <button className="text-red-600 hover:underline" onClick={() => deleteFootnote(f.pos)}>
                        삭제
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </aside>

      {reviseOpen && (
        <ChapterReviseDialog
          chapterId={chapter.id}
          chapterName={`${chapter.label} ${chapter.title}`.trim()}
          beforeRun={flush}
          onApplied={(ids) => {
            if (ids.length) revisedRef.current = true;
          }}
          onClose={() => {
            setReviseOpen(false);
            // 서버에서 고친 원고를 다시 불러온다 (창을 닫을 때 — 적용 결과 안내를 읽을 수 있게)
            if (revisedRef.current) onServerEdited();
          }}
        />
      )}

      {batchOpen && (
        <BatchWriteDialog
          sections={allSections}
          currentId={section.id}
          busyIds={busyIds}
          currentSketch={sketch}
          currentPages={targetPages}
          cpp={cpp}
          initialExtra={extra.trim() || (extraMem.keep ? extraMem.text : "") || extraMem.recent[0] || ""}
          recentExtra={extraMem.recent}
          onClose={() => setBatchOpen(false)}
          onStart={startBatch}
        />
      )}

      {/* 드래그 선택 → 각주 말풍선 */}
      {bubble && !fnEdit && !streaming && !rewritePreview && (
        <div
          data-fn-ui
          className="fixed z-40 flex items-center gap-0.5 rounded-lg border border-stone-200 bg-white p-0.5 font-sans shadow-lg"
          style={{ left: Math.max(8, bubble.x - 8), top: Math.max(8, bubble.y - 40) }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {(Object.keys(REWRITE_LABEL) as RewriteAction[]).map((a) => (
            <button key={a} className="rounded-md px-2 py-1 text-xs text-violet-800 hover:bg-violet-50 disabled:opacity-50" disabled={!!rewriteBusy || !!fnBusy} onClick={() => rewrite(a)}>
              {rewriteBusy === a ? "…" : REWRITE_LABEL[a]}
            </button>
          ))}
          <span className="mx-0.5 h-4 w-px bg-stone-200" />
          <button className="rounded-md px-2 py-1 text-xs font-semibold text-amber-800 hover:bg-amber-50 disabled:opacity-50" disabled={!!fnBusy} onClick={() => addFootnote(true)}>
            {fnBusy === "one" ? "각주 쓰는 중…" : "✦ AI 각주"}
          </button>
          <button className="rounded-md px-2 py-1 text-xs text-stone-600 hover:bg-stone-100 disabled:opacity-50" disabled={!!fnBusy} onClick={() => addFootnote(false)}>
            직접 각주
          </button>
        </div>
      )}

      {/* 선택 영역 AI 결과 — 원문과 비교해 보고 적용 */}
      {rewritePreview && (
        <div
          data-fn-ui
          role="dialog"
          aria-label="선택 영역 AI 결과"
          className="fixed z-50 w-[440px] max-w-[92vw] rounded-xl border border-violet-200 bg-white p-3 font-sans shadow-2xl"
          style={{
            left: Math.min(Math.max(8, rewritePreview.x - 60), (typeof window !== "undefined" ? window.innerWidth : 1200) - 460),
            top: Math.min(rewritePreview.y + 10, (typeof window !== "undefined" ? window.innerHeight : 800) - 320),
          }}
          onKeyDown={(e) => e.key === "Escape" && cancelRewrite()}
        >
          <div className="mb-2 flex items-center gap-2 text-xs">
            <b className="text-violet-800">✦ {REWRITE_LABEL[rewritePreview.action]}</b>
            <span className="text-stone-400">
              {rewritePreview.selection.length.toLocaleString()}자 → {rewritePreview.text.length.toLocaleString()}자
            </span>
            <button className="ml-auto text-stone-400 hover:text-stone-700" aria-label="닫기" onClick={cancelRewrite}>
              ✕
            </button>
          </div>
          <div className="max-h-64 overflow-auto rounded-lg bg-stone-50 p-2 font-book text-[12.5px] leading-6">
            {rewritePreview.action === "example" ? (
              <p className="whitespace-pre-wrap text-green-800">{rewritePreview.text}</p>
            ) : (
              <InlineDiff before={rewritePreview.selection} after={rewritePreview.text.replace(/\*\*|⟦주:[^⟧]*⟧/g, "")} />
            )}
          </div>
          {rewritePreview.action === "example" && <p className="mt-1 text-[11px] text-stone-500">선택한 문단 뒤에 새 문단으로 넣습니다.</p>}
          <div className="mt-2 flex items-center gap-2">
            <button autoFocus className="btn-primary px-3 py-1 text-xs" onClick={applyRewrite}>
              적용
            </button>
            <button
              className="btn px-3 py-1 text-xs"
              disabled={!!rewriteBusy}
              onClick={() => {
                const p = rewritePreview;
                setRewritePreview(null);
                requestRewrite(p.action, p.from, p.to, p.req);
              }}
            >
              {rewriteBusy ? "다시 쓰는 중…" : "다시"}
            </button>
            <button className="btn-ghost px-3 py-1 text-xs" onClick={cancelRewrite}>
              취소
            </button>
            <span className="ml-auto text-[11px] text-stone-400">적용 전 원고는 버전 기록에 남습니다</span>
          </div>
        </div>
      )}

      {/* 각주 번호 클릭 → 편집 팝업 */}
      {fnEdit && editor && editor.state.doc.nodeAt(fnEdit.pos)?.type.name === "footnote" && (
        <FootnotePopover
          key={fnEdit.pos}
          x={fnEdit.x}
          y={fnEdit.y}
          number={footnotes.findIndex((f) => f.pos === fnEdit.pos) + 1}
          attrs={editor.state.doc.nodeAt(fnEdit.pos)!.attrs as FootnoteAttrs}
          busy={fnBusy === "regen"}
          onChange={(v) => setFootnoteNote(fnEdit.pos, v)}
          onRegen={() => regenFootnote(fnEdit.pos)}
          onDelete={() => deleteFootnote(fnEdit.pos)}
          onClose={() => {
            setFnEdit(null);
            editor.commands.focus();
          }}
        />
      )}
    </div>
  );
}

/** 선택 영역 글자를 문단 사이 줄바꿈으로 이어 읽는다 */
const NL = "\n";


/** 한글 등 입력 조합이 끝날 때까지 */
function compositionDone(editor: Editor): Promise<void> {
  if (editor.isDestroyed || !editor.view.composing) return Promise.resolve();
  return new Promise((resolve) => editor.view.dom.addEventListener("compositionend", () => window.setTimeout(resolve, 0), { once: true }));
}

/** 문서 끝(끝의 빈 문단 자리)에 한 트랜잭션으로 붙인다 — 앞 본문·커서는 그대로 둔다 */
function appendAtEnd(editor: Editor, doc: JNode) {
  const st = editor.state;
  const end = st.doc.content.size;
  let from = end;
  for (let i = st.doc.childCount - 1; i >= 0; i--) {
    const c = st.doc.child(i);
    if (c.type.name !== "paragraph" || c.content.size > 0) break;
    from -= c.nodeSize;
  }
  const node = editor.schema.nodeFromJSON(doc);
  editor.view.dispatch(st.tr.replaceWith(from, end, node.content).setMeta("addToHistory", false));
}
