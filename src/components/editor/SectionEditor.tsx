"use client";

import Placeholder from "@tiptap/extension-placeholder";
import { NodeSelection, type Transaction } from "@tiptap/pm/state";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import dynamic from "next/dynamic";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isFocusMode, useFocusMode } from "./focusMode";
import { api } from "@/lib/client";
import { confirmDialog, promptDialog, toast, toastError } from "../ui/feedback";
import { clearJob, clearPartial, jobFor, locksSection, registerApplier, runJob, stopJob, takeDetachedSave, useAiJob, useAnyRunningIn, useLastWriteTiming, type AiJob, type JobMode } from "./aiJobs";
import { scheduleOutlinePreparation, scheduleSummaryPreparation } from "./preparation";
import { attachFile } from "@/lib/upload-client";
import {
  docParagraphs,
  charCount,
  charCountNoSpace,
  contentHash,
  docToMarkdown,
  isDocEmpty,
  markdownToDoc,
  parseDoc,
  type JNode,
} from "@/lib/doc/doc";
import type { Node as PMNode } from "@tiptap/pm/model";
import { DOC, bodyBox } from "@/lib/print/spec";
import { numberChapters, type LayoutSettings } from "@/lib/layout";
import type { ProjectTree, SectionPageInfo, TreeChapter, TreeSection } from "../types";
import { Figure } from "./Figure";
import { Footnote, type FootnoteAttrs } from "./Footnote";
import { PageBreaks, paginate, type PageGeom, type PaginateResult } from "./PageBreaks";
import { editorBlocks, matchPrintLayout, type SectionPrintLayout } from "./pageMap";
import type { AppliedChange } from "./ProofPanel";
import { findInBlock, posAfterTerm, replaceInBlock, selectInBlock, sentenceRangeAround, textblockAt } from "./pmOps";
import ImagesPanel, { type ImageCandidate, type ImageSuggestion } from "./ImagesPanel";
import type { FigureTarget, MadeFigure } from "./MakeFigurePane";
import PanelTabs, { type PanelTab } from "./PanelTabs";
import { conflictOf, noteServerContent, primeBase, recoverPending, registerCommit, resolveConflict, settleSection, useAutosave } from "./useAutosave";
import { loadExtra, rememberExtra, saveExtra, type ExtraMemory } from "./extraMemory";
import { pauseAutoRun, startAutoRun, useAutoChecking, useAutoWrite } from "./autoWrite";
import type { AutoItem, AutoOptions } from "@/lib/autowrite";
import { clearProofResult, loadProofResult, proofRunning, registerProofApplier, runProof, saveProofResult, stopProof, takeProofResult, useProofJob, useProofRunningIds } from "./proofJobs";
import WritingOverlay from "./WritingOverlay";
import EditorToolbar, { REWRITE_LABEL, type RewriteAction } from "./EditorToolbar";
import SelectionBubble from "./SelectionBubble";
import Menu from "./Menu";
import OutlinePanel from "./OutlinePanel";
import { useMe } from "@/lib/me-client";
import FootnotesPanel, { FootnoteTabLabel, footnoteNumberAt } from "./FootnotesPanel";
import PartialBanner from "./PartialBanner";
import { clipboardHasText, compositionDone, trackPositions, useDocValue, useEditLock, useStableFn } from "./editorHooks";

// 열 때만 필요한 창·패널은 따로 불러온다
const ProofPanel = dynamic(() => import("./ProofPanel"));
const FootnotePopover = dynamic(() => import("./FootnotePopover"));
const InlineDiff = dynamic(() => import("../InlineDiff"));
const VersionsPanel = dynamic(() => import("./VersionsPanel"));
const MemoryPanel = dynamic(() => import("./MemoryPanel"));
const ChapterReviseDialog = dynamic(() => import("./ChapterReviseDialog"));
const AutoWriteDialog = dynamic(() => import("./AutoWriteDialog"));
const CandidateCompareDialog = dynamic(() => import("./CandidateCompareDialog"));
const SaveConflictDialog = dynamic(() => import("./SaveConflictDialog"));
const ReferencesPanel = dynamic(() => import("./ReferencesPanel"));

/**
 * AI 집필 중지 — 자동 집필이 쓰는 절이면 전체가 일시 정지되므로 먼저 묻는다.
 * 돌려준 값: 멈췄으면 true
 */
export async function stopWriting(job: Pick<AiJob, "sectionId" | "auto">) {
  if (job.auto) {
    if (!(await confirmDialog("자동 집필이 쓰는 절입니다. 이 절을 멈추면 자동 집필이 일시 정지됩니다(쓴 데까지는 넣습니다). 멈출까요?", { okLabel: "멈추고 일시 정지" }))) return false;
    pauseAutoRun();
  }
  stopJob(job.sectionId);
  return true;
}

type Props = {
  project: ProjectTree;
  chapter: TreeChapter & { label: string; no?: number };
  section: TreeSection & { label: string };
  pageInfo?: SectionPageInfo;
  /** 실제 조판(Paged.js)에서 이 절의 블록별 쪽 — 지금 원고와 맞으면 편집 화면 쪽 나눔이 따라간다 */
  printLayout?: SectionPrintLayout;
  /** 이 절 앞 절들(같은 장)의 그림 수 — 그림 번호는 장마다 이어서 센다 */
  figureBase?: number;
  onMeta: (patch: Partial<TreeSection>) => void;
  /** figures: 저장한 원고의 그림 수 (그림이 있으면 저장마다 실제 조판을 다시 잰다) */
  onSaved: (sectionId: string, chars: number, figures?: number) => void;
  onRename: (title: string) => void;
  onRenameChapter: (title: string) => void;
  onTargetPages: (n: number) => void;
  onLayout: (patch: Partial<LayoutSettings>) => void;
  /** 서버에서 절 본문을 고친 뒤(장 퇴고 등) 편집 화면을 다시 불러온다 */
  onServerEdited: () => void;
  /** 책 전체 찾기 창 열기 */
  onBookSearch: (query: string) => void;
  /** 팩트체크(확인할 것) — 책 전체에 남은 개수와 창 열기 */
  checkCount: number;
  onOpenChecks: () => void;
  /** 이 위치로 이동해 선택 (확인 표시·검색 결과에서) — nonce가 바뀔 때마다 */
  locate?: { paragraph: number; text: string; nonce: number } | null;
};

type Loaded = { content: string; sketch: string; status: string; updatedAt: string; recovered: boolean };

/** 목차·저장 표시가 바뀌어도 이 절의 값이 그대로면 다시 그리지 않는다 (부모가 넘기는 함수는 늘 같은 참조) */
export default memo(SectionEditor);

function SectionEditor(props: Props) {
  const [data, setData] = useState<Loaded | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let alive = true;
    settleSection(props.section.id).then(() => api(`/api/sections/${props.section.id}`))
      .then(async (s) => {
        const rec = await recoverPending(props.section.id, { content: s.content ?? "", sketch: s.sketch ?? "" });
        if (!alive) return;
        // 저장 충돌 확인 기준: 복구본을 이어 쓰면 그 복구본이 기준으로 삼았던 서버 본문 — 그사이 서버가 바뀌었으면 저장 때 충돌로 알린다
        primeBase(props.section.id, rec ? (rec.baseHash ?? null) : (s.contentHash ?? contentHash(s.content)));
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

function EditorCore({ project, chapter, section, pageInfo, printLayout, figureBase = 0, onMeta, onSaved, onRename, onRenameChapter, onTargetPages, onLayout, onServerEdited, onBookSearch, checkCount, onOpenChecks, locate, data }: Props & { data: Loaded }) {
  const cpp = project.charsPerPage || 700;
  const [sketch, setSketch] = useState(data.sketch);
  const [sketchOpen, setSketchOpen] = useState(!data.content || isDocEmpty(parseDoc(data.content)));
  const [status, setStatus] = useState(data.status);
  const [counts, setCounts] = useState(() => {
    const d = parseDoc(data.content);
    return { chars: charCount(d), noSpace: charCountNoSpace(d) };
  });
  const [targetPages, setTargetPages] = useState<number>(section.targetPages || 3);
  const [autoOpen, setAutoOpen] = useState(false);
  // 자동 집필의 사실 확인·교정이 이 절을 고치는 중이면 잠근다
  const autoChecking = useAutoChecking(section.id);
  const autoDriving = useAutoWrite().driving;
  const [reviseOpen, setReviseOpen] = useState(false);
  const revisedRef = useRef(false);
  // 장 퇴고는 이 장의 어느 절이든 AI가 쓰는 중(이어쓰기 포함)이거나 교정 중이면 막는다 — 퇴고가 고친 원고를 쓰던 글이 덮지 않게
  const chapterIds = useMemo(() => chapter.sections.map((s) => s.id), [chapter.sections]);
  const chapterWriting = useAnyRunningIn(chapterIds);
  const proofIds = useProofRunningIds();
  const chapterProofing = useMemo(() => proofIds.split(",").some((id) => chapterIds.includes(id)), [proofIds, chapterIds]);
  const [candidate, setCandidate] = useState<string | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const [lengthHint, setLengthHint] = useState<null | { chars: number; target: number }>(null);
  const [tab, setTab] = useState<PanelTab>("ai");
  /** 선택 말풍선 [기억]으로 넘긴 글 — 책 기억 탭의 입력 칸에 채운다 */
  const [memoryDraft, setMemoryDraft] = useState<string | null>(null);
  const clearMemoryDraft = useCallback(() => setMemoryDraft(null), []);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const me = useMe();
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
  const proofJob = useProofJob(section.id);
  const proofBusy = proofJob?.state === "running";
  const [preProof, setPreProof] = useState<JNode | null>(null);
  const [versionKey, setVersionKey] = useState(0);
  const [zoom, setZoom] = useState(() => (typeof window !== "undefined" && window.innerWidth < 1500 ? 1 : 1.25));
  const [panelOpen, setPanelOpen] = useState(() => typeof window === "undefined" || (window.innerWidth >= 1280 && !isFocusMode()));
  // 집중 모드를 켜면 오른쪽 패널을 닫는다 (필요하면 [◂ 패널]로 다시 연다)
  const focusMode = useFocusMode();
  useEffect(() => {
    if (focusMode) setPanelOpen(false);
  }, [focusMode]);
  const [caretPage, setCaretPage] = useState<number | null>(null); // 이 절 안에서 몇 번째 쪽(0부터)
  const [pg, setPg] = useState<PaginateResult | null>(null);
  const [bubble, setBubble] = useState<{ x: number; y: number; len: number; single: boolean } | null>(null);
  const [fnEdit, setFnEdit] = useState<{ pos: number; x: number; y: number } | null>(null);
  const [fnBusy, setFnBusy] = useState<null | "one" | "auto" | "regen">(null);
  const [regenPos, setRegenPos] = useState<number | null>(null);
  const [rewriteBusy, setRewriteBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(data.recovered ? "브라우저에 보관돼 있던 최신 입력을 복원했습니다." : null);
  // 이 절의 AI 집필 작업 (편집기 밖에서 돈다 — 절을 옮겨도 계속된다). 이 절 작업만 구독한다
  const job = useAiJob(section.id);
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
  /** 새 버전 후보가 있거나 쓰는 중 — 첫 문장이 나오기 전(구상 중)에도 보여 준다 */
  const candidateActive = candidateText !== null || candidateWriting;
  const candidateStatus = candidateWriting ? (job!.md ? job!.status || "작성 중…" : job!.status || "구상 중…") : "";
  const dropCandidate = () => {
    setCandidate(null);
    clearJob(section.id);
    void clearPartial(section.id); // 끊긴 후보를 서버 보관본에서 불러온 경우 — 골랐으니 치운다
  };
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 원고 영역(진행 창 포함) — Esc 중지는 초점이 여기 있을 때만 */
  const deskRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const sketchRef = useRef(sketch);
  sketchRef.current = sketch;

  const secLabel = `${section.label} ${section.title}`.trim();
  const { state: saveState, markDirty, flush: flushQueue } = useAutosave(section.id, secLabel, (r) => {
    onMeta({ charCount: r.charCount, status: r.status, updatedAt: r.updatedAt });
    const ed = editorRef.current;
    let figures = 0;
    if (ed && !ed.isDestroyed) ed.state.doc.forEach((n) => void (n.type.name === "figure" && figures++));
    onSaved(section.id, r.charCount, figures);
  });
  const conflict = saveState.kind === "conflict" ? conflictOf(section.id) : null;
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
  // 창을 숨기거나 닫을 때·절을 옮길 때 밀린 입력은 useAutosave가 registerCommit으로 먼저 큐에 넣는다 (구독을 끊기 전에)
  useEffect(() => registerCommit(section.id, commitEdit), [section.id, commitEdit]);
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
      Figure.configure({ margins: project.layout.margins }),
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
        void insertImages(files, pos, pos);
        return true;
      },
      handlePaste: (view, event) => {
        // Word·Excel·웹 문서는 글과 함께 미리보기 그림도 넣는다 — 글이 있으면 글로 붙인다
        if (clipboardHasText(event.clipboardData)) return false;
        const files = [...(event.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
        if (!files.length) return false;
        const { from, to } = view.state.selection;
        void insertImages(files, from, to);
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
      scheduleCaretPage();
      updateFloating(editor);
    },
    onBlur: ({ editor, event }) => {
      const to = event.relatedTarget as HTMLElement | null;
      if (!to?.closest?.("[data-fn-ui]")) setBubble(null);
      else updateFloating(editor);
    },
  });

  editorRef.current = editor;

  /** 선택 영역 AI 결과 — 바로 넣지 않고 원문과 비교해 보여 준 뒤 [적용]할 때 넣는다. 그동안 선택 위치가 바뀌지 않게 편집을 잠근다 */
  const [rewritePreview, setRewritePreview] = useState<null | {
    action: RewriteAction;
    from: number;
    to: number;
    selection: string;
    text: string;
    req: RewriteReq;
    x: number;
    y: number;
  }>(null);

  // 편집 잠금은 여기 한 곳에서 정한다 — AI 집필·교정·자동 집필 점검·선택 영역 AI·각주 AI·저장 충돌 중 하나라도 있으면 잠근다
  const { canEdit, reason: busyReason, canEditRef } = useEditLock(editor, section.id, {
    locked,
    proofBusy,
    autoChecking,
    rewrite: !!rewriteBusy || !!rewritePreview,
    footnote: fnBusy === "one" || fnBusy === "auto",
    conflict: !!conflict,
    busy: rewriteBusy || rewritePreview ? "rewrite" : fnBusy ? "footnote" : null,
  });

  /** 그림 올리기 — 올리는 동안 문서가 바뀌어도 넣을 자리를 따라가고, 그사이 잠겼으면 넣지 않는다 */
  async function insertImages(files: File[], from: number, to: number) {
    const ed = editorRef.current;
    if (!ed) return;
    const track = trackPositions(ed, [from, to]);
    try {
      for (const f of files) {
        const attrs = await uploadImage(f);
        if (ed.isDestroyed) return;
        if (!canEditRef.current) return toast.error("그사이 이 절이 잠겨 그림을 넣지 못했습니다. 잠금이 풀린 뒤 다시 넣어 주세요.");
        const [a, b] = track.get().positions;
        const size = ed.state.doc.content.size;
        ed.view.dispatch(ed.state.tr.replaceRangeWith(Math.min(a, size), Math.min(Math.max(a, b), size), ed.schema.nodes.figure.create(attrs)));
      }
    } catch (e) {
      toastError(e);
    } finally {
      track.stop();
    }
  }

  /* ---------- 이미지 추천 (오른쪽 [이미지] 탭) ---------- */

  /** 추천이 가리킨 문단 — 그사이 문단이 옮겨졌으면 앞부분(anchor)이 같은 문단을 찾는다 */
  function suggestionBlock(ed: Editor, s: FigureTarget) {
    const b = s.paragraph > 0 ? textblockAt(ed.state.doc, s.paragraph) : null;
    if (b && b.node.textContent.trim().startsWith(s.anchor)) return b;
    let found: { node: PMNode; pos: number } | null = null;
    ed.state.doc.descendants((node, pos) => {
      if (found) return false;
      if (node.type.name === "paragraph" || node.type.name === "heading") {
        if (node.textContent.trim().startsWith(s.anchor)) found = { node, pos };
        return false;
      }
      return true;
    });
    return found as { node: PMNode; pos: number } | null;
  }

  function locateSuggestion(s: FigureTarget) {
    const ed = editorRef.current;
    const b = ed && suggestionBlock(ed, s);
    if (!ed || !b) return toast.error("그 문단을 찾지 못했습니다(내용이 바뀌었을 수 있습니다).");
    ed.chain().focus().setTextSelection({ from: b.pos + 1, to: b.pos + b.node.nodeSize - 1 }).scrollIntoView().run();
  }

  /** 승인 — 서버가 이미지를 가져와 원고 이미지로 저장하면, 그 문단(목록·인용 안이면 그 묶음) 끝에 캡션·출처와 함께 넣는다 */
  async function insertSuggestedImage(s: ImageSuggestion, c: ImageCandidate, caption: string) {
    const ed = editorRef.current;
    if (!ed || !canEditRef.current) {
      toast.error(busyReason || "지금은 이 절을 고칠 수 없습니다.");
      return false;
    }
    if (!suggestionBlock(ed, s)) {
      toast.error("추천한 문단을 찾지 못했습니다(내용이 바뀌었을 수 있습니다). [다시 추천 받기]를 눌러 주세요.");
      return false;
    }
    const r = await api<{ id: string; src: string; widthPx: number; heightPx: number }>("/api/assets/import", {
      method: "POST",
      json: { projectId: project.id, url: c.src, title: c.title },
      timeoutMs: 90_000,
    });
    if (ed.isDestroyed) return false;
    if (!canEditRef.current) {
      toast.error("그사이 이 절이 잠겨 그림을 넣지 못했습니다. 잠금이 풀린 뒤 다시 승인해 주세요.");
      return false;
    }
    // 내려받는 동안 본문이 바뀌었을 수 있다 — 넣기 직전에 다시 찾는다
    const text = [caption.trim(), c.credit && `(${c.credit})`].filter(Boolean).join(" ");
    return placeFigure(ed, s, { assetId: r.id, src: r.src, widthPx: r.widthPx, heightPx: r.heightPx }, text);
  }

  /** 그림을 그 문단(목록·인용 안이면 그 묶음) 끝에 넣고 선택한다 */
  function placeFigure(ed: Editor, t: FigureTarget, img: { assetId: string; src: string; widthPx: number; heightPx: number }, caption: string) {
    const b = suggestionBlock(ed, t);
    if (!b) {
      toast.error("그림을 넣을 문단을 찾지 못했습니다(그사이 내용이 바뀌었을 수 있습니다).");
      return false;
    }
    const $p = ed.state.doc.resolve(b.pos + 1);
    const at = $p.depth > 1 ? $p.after(1) : b.pos + b.node.nodeSize;
    const node = ed.schema.nodes.figure.create({ ...img, layout: "fit", caption });
    const tr = ed.state.tr.insert(at, node);
    ed.view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, at)).scrollIntoView());
    return true;
  }

  /** [직접 만들기] 승인 — 이미 원고 이미지로 저장된 그림을 만든 문단 끝에 넣는다 */
  function insertMadeFigure(t: FigureTarget, f: MadeFigure, caption: string) {
    const ed = editorRef.current;
    if (!ed || !canEditRef.current) {
      toast.error(busyReason || "지금은 이 절을 고칠 수 없습니다.");
      return false;
    }
    return placeFigure(ed, t, { assetId: f.assetId, src: f.src, widthPx: f.widthPx, heightPx: f.heightPx }, caption);
  }

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
  /**
   * 실제 조판 결과(Paginator가 저장된 원고로 잰 Paged.js 쪽)가 지금 원고와 같으면 블록별 쪽을 돌려준다 — 그림을 미리보기와 같은 쪽에 두게.
   * 원고가 그 뒤에 바뀌었으면(저장 전·다시 재기 전) null → 화면 계산(인쇄와 같은 크기의 상자를 잰다)만 쓴다.
   */
  const printLayoutRef = useRef(printLayout);
  printLayoutRef.current = printLayout;
  const hintsFor = (ed: Editor) => {
    const l = printLayoutRef.current;
    if (!l) return null;
    return matchPrintLayout(editorBlocks(ed.state.doc.toJSON() as JNode), l);
  };
  const runPaginate = useCallback(() => {
    if (!editor || editor.isDestroyed || !sheetRef.current || !scrollRef.current || !contentRef.current) return false;
    if (editor.view.composing) return false; // 한글 조합 중에는 건드리지 않는다
    const sc = scrollRef.current;
    const keep = sc.scrollTop;
    const hints = hintsFor(editor);
    // 조판 결과를 쓰기 시작하거나 그만둘 때는 앞 쪽부터 다시 끊는다
    if (Boolean(hints) !== syncedRef.current) dirtyFrom.current = null;
    syncedRef.current = Boolean(hints);
    const r = paginate(editor.view, {
      sheet: sheetRef.current,
      measureHost: contentRef.current,
      geom,
      docWidthMm: DOC.width,
      leadMm,
      label: pageLabel,
      dirtyFrom: dirtyFrom.current,
      hints,
    });
    dirtyFrom.current = null;
    sc.scrollTop = keep;
    // 값이 같으면 다시 그리지 않는다 (입력마다 도는 계산이라)
    setPg((p) => (p && p.pages === r.pages && p.synced === r.synced && Math.abs(p.lastFill - r.lastFill) < 0.05 && JSON.stringify(p.lastNotes) === JSON.stringify(r.lastNotes) ? p : r));
    cachePageBoxes();
    updateCaretPage();
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, geom, leadMm, pageLabel]);

  const syncedRef = useRef(false);
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
  // 새 조판 결과가 오면 처음부터 다시 끊는다
  useEffect(() => schedulePaginate(0), [printLayout, schedulePaginate]);
  // 그림 번호(장 번호 · 앞 절 그림 수)를 그림 노드가 읽는 곳에 두고, 번호를 다시 그리게 빈 트랜잭션을 보낸다 (캡션 줄 수가 달라질 수 있어 쪽 나눔도 다시)
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const st = (editor.storage as unknown as { figure?: { chapterNo: number; base: number } }).figure;
    if (!st || (st.chapterNo === (chapter.no ?? 0) && st.base === figureBase)) return;
    st.chapterNo = chapter.no ?? 0;
    st.base = figureBase;
    try {
      editor.view.dispatch(editor.state.tr.setMeta("figureLabel", true).setMeta("addToHistory", false));
    } catch {} // 편집기가 아직 화면에 붙기 전 — 그림 노드가 처음 그릴 때 위 값을 읽는다
    schedulePaginate(0);
  }, [editor, chapter.no, figureBase, schedulePaginate]);

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

  /**
   * 커서가 몇 번째 쪽인지 — 쪽 나눔을 계산할 때 쪽 끝 위치(본문 위에서부터)를 한 번 재 두고, 커서가 움직이면 그것과만 비교한다
   * (예전에는 커서가 움직일 때마다 모든 쪽 상자의 위치를 다시 쟀다). 한 프레임에 한 번만 한다.
   */
  const pageBottoms = useRef<number[]>([]);
  function cachePageBoxes() {
    const host = contentRef.current;
    if (!host) return;
    const top = host.getBoundingClientRect().top;
    pageBottoms.current = [...host.querySelectorAll(".pg-box")].map((b) => b.getBoundingClientRect().bottom - top);
  }
  function updateCaretPage() {
    const ed = editorRef.current;
    if (!contentRef.current || !ed || ed.isDestroyed) return;
    try {
      const top = ed.view.coordsAtPos(ed.state.selection.from).top - contentRef.current.getBoundingClientRect().top;
      setCaretPage(pageBottoms.current.filter((b) => b <= top + 1).length);
    } catch {}
  }
  const caretFrame = useRef(0);
  function scheduleCaretPage() {
    if (caretFrame.current) return;
    caretFrame.current = requestAnimationFrame(() => {
      caretFrame.current = 0;
      updateCaretPage();
    });
  }
  useEffect(() => () => cancelAnimationFrame(caretFrame.current), []);

  /** 제목 입력 칸 — 머리말처럼 절 하나뿐인 장이면 장·절 이름을 함께 바꾼다. 목차에서 이름을 바꾸면 새 이름으로 다시 만든다(옛 이름으로 되돌리지 않게) */
  const titleBox = (title: string) => (
    <textarea
      key={section.title}
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
      const len = ed.state.doc.textBetween(sel.from, sel.to, " ").trim().length;
      const single = sel.$from.sameParent(sel.$to);
      setBubble((b) => (b && b.x === a.left && b.y === a.top && b.len === len && b.single === single ? b : { x: a.left, y: a.top, len, single }));
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

  async function startJob(url: string, body: { targetPages?: number; targetChars?: number; mode?: string; extraInstruction?: string }, mode: JobMode) {
    if (!editor) return;
    if (proofRunning(section.id)) return toast("교정·교열이 끝난 뒤에 집필하세요.");
    if (!(await flush())) return toast.error("원고 저장에 실패했습니다. 저장을 완료한 뒤 다시 집필해주세요.");
    setLengthHint(null);
    if (mode !== "continue") setSketchOpen(false);
    const figures = mode === "adjust" ? docToMarkdown(editor.getJSON() as JNode).figures : [];
    runJob({ sectionId: section.id, label: secLabel, mode, url, body, target: jobTarget(mode, body), figures }).catch((e) => toastError(e, "AI 오류: "));
  }

  // 결과를 여기서 넣지 못하고 저장 큐로 서버에 저장했으면(편집기를 연 순간 이미 저장 단계였던 경우 등) 저장된 원고를 다시 불러온다.
  // 아무것도 저장하지 않은 작업(첫 글자 전 실패·중지)은 다시 불러오지 않는다 — 실행 취소 기록·스크롤을 잃지 않게
  const appliedRef = useRef(false);
  const wasWriting = useRef(false);
  useEffect(() => {
    if (writing) {
      wasWriting.current = true;
      appliedRef.current = false;
      return;
    }
    if (wasWriting.current && !appliedRef.current && takeDetachedSave(section.id)) onServerEdited();
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
        setCandidate(job.md); // 편집기 위 띠에 알리고, [크게 비교]에서 고른다
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
      await commitDoc("ai_draft"); // 잠금은 작업이 끝나면(useEditLock) 풀린다
      setVersionKey((k) => k + 1);
      checkLength(charCount(editor.getJSON() as JNode));
      return JSON.stringify(editor.getJSON());
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, section.id, setDoc, commitDoc, targetChars]);

  /** 자동 집필(범위: 고른 절 · 한 장 · 책 전체) — 진행은 autoWrite(편집기 밖)가 맡고, 진행 창은 편집 화면 오른쪽 아래에 뜬다 */
  async function startAuto(items: AutoItem[], options: AutoOptions) {
    setAutoOpen(false);
    if (!(await flush())) return toast.error("원고 저장에 실패했습니다. 저장을 완료한 뒤 다시 시작해주세요.");
    noteExtraUsed(options.extraInstruction);
    startAutoRun(project.id, items, options).catch((e) => toastError(e, "자동 집필: "));
  }

  const startWrite = (mode: "overwrite" | "continue" | "newVersion") => {
    onTargetPages(targetPages);
    if (mode === "newVersion") setCandidate(null);
    noteExtraUsed();
    startJob(`/api/sections/${section.id}/write`, { targetPages, mode, extraInstruction: extra }, mode);
  };

  /** [AI 집필하기 ▾]에서 고른 방식으로 쓴다 — 스케치·요지가 둘 다 없으면 먼저 묻는다 */
  const writeWith = async (mode: "overwrite" | "continue" | "newVersion") => {
    if (!sketch.trim() && !section.gist) {
      if (!(await confirmDialog("스케치가 비어 있습니다. 목차의 절 요지만으로 쓸까요?", { okLabel: "요지만으로 쓰기" }))) return;
    }
    startWrite(mode);
  };

  const acceptCandidate = async () => {
    if (!candidateText || !editor) return;
    if (!canEditRef.current) return toast.error(`${busyReason} — 끝난 뒤에 후보를 쓰세요.`);
    try {
      // 지금 본문을 먼저 버전으로 남긴다 — 남기지 못하면 바꾸지 않는다
      await api(`/api/sections/${section.id}/versions`, { method: "POST", json: { content: JSON.stringify(editor.getJSON()) } });
    } catch (e) {
      return toastError(e, "지금 본문을 버전 기록에 남기지 못해 후보로 바꾸지 않았습니다: ");
    }
    setDoc(markdownToDoc(candidateText), true);
    dropCandidate();
    await commitDoc("ai_draft");
    api(`/api/sections/${section.id}/versions`, { method: "POST", json: { content: JSON.stringify(editor.getJSON()), reason: "ai_output" } }).catch((e) => toastError(e, "고른 후보를 버전 기록에 남기지 못했습니다: "));
    setVersionKey((k) => k + 1);
    checkLength(charCount(editor.getJSON() as JNode));
    scheduleSummaryPreparation(section.id, undefined, 0);
  };

  /** 중단된 AI 집필(서버 보관본)을 본문 끝에 붙인다 — 붙이기 전 원고는 버전으로 남긴다 */
  async function appendPartial(text: string) {
    if (!editor || editor.isDestroyed) return false;
    if (!canEditRef.current) {
      toast.error(`${busyReason} — 끝난 뒤에 붙이세요.`);
      return false;
    }
    if (!(await flush())) {
      toast.error("원고 저장을 완료한 뒤 다시 시도하세요.");
      return false;
    }
    try {
      await api(`/api/sections/${section.id}/versions`, { method: "POST", json: { content: JSON.stringify(editor.getJSON()) } });
    } catch (e) {
      toastError(e, "붙이기 전 원고를 버전 기록에 남기지 못했습니다(붙이기는 계속합니다): ");
    }
    if (editor.isDestroyed) return false;
    appendAtEnd(editor, markdownToDoc(text));
    await commitDoc("ai_draft");
    setVersionKey((k) => k + 1);
    toast.success("보관돼 있던 AI 글을 본문 끝에 붙였습니다.");
    return true;
  }

  /** 보관된 AI 글이 이미 본문에 있나 — 글 여러 곳의 토막(마크다운 기호·공백 뺌)이 모두 본문에 있으면 그렇다고 본다 */
  function partialInBody(text: string) {
    if (!editor || editor.isDestroyed) return false;
    const body = editor.getText().replace(/\s+/g, "");
    const plain = text.replace(/[#*_>`~|\[\]-]/g, "").replace(/\s+/g, "");
    if (plain.length < 20) return plain.length > 0 && body.includes(plain);
    return [0.2, 0.5, 0.8].every((f) => {
      const at = Math.floor((plain.length - 20) * f);
      return body.includes(plain.slice(at, at + 20));
    });
  }

  /** 중단된 AI 집필을 새 버전 후보로 — 고르거나 버리면 보관본을 치운다(dropCandidate) */
  function comparePartial(text: string) {
    setCandidate(text);
    setCompareOpen(true);
  }

  const undoAi = async () => {
    if (!editor) return;
    try {
      if (!(await flush())) return toast.error("원고 저장을 완료한 뒤 다시 되돌리세요.");
      const vs = await api<{ id: string; reason: string }[]>(`/api/sections/${section.id}/versions`);
      const v = vs.find((x) => x.reason === "ai_write" || x.reason === "length_adjust");
      if (!v) return toast("되돌릴 AI 집필 이전 버전이 없습니다.");
      const r = await api<{ content: string }>(`/api/versions/${v.id}`, { method: "POST", json: { currentContent: JSON.stringify(editor.getJSON()) } });
      if (editor.isDestroyed) return;
      noteServerContent(section.id, r.content); // 서버가 이미 이 버전으로 바꿨다 — 다음 저장이 충돌로 보이지 않게
      setDoc(parseDoc(r.content), true);
      await commitDoc(statusFor(parseDoc(r.content)));
      setLengthHint(null);
      setVersionKey((k) => k + 1);
    } catch (e) {
      toastError(e, "AI 쓰기 전으로 되돌리지 못했습니다: ");
    }
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
    if (!canEditRef.current) return toast.error(`${busyReason} — 끝난 뒤에 되돌리세요.`);
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
    if (!canEditRef.current) return toast.error(`${busyReason} — 끝난 뒤에 되돌리세요.`);
    if (!(await confirmDialog("교정 전 상태로 모두 되돌릴까요?", { okLabel: "모두 되돌리기" }))) return;
    setDoc(preProof, true);
    setProof((p) => p?.map((x) => (x.state === "applied" ? { ...x, state: "reverted" } : x)) ?? null);
    void clearProofResult(section.id);
    await commitDoc("editing");
  };

  /* ---------- 선택 영역 AI (결과 미리보기 상태 rewritePreview는 위 잠금과 함께 둔다) ---------- */
  async function requestRewrite(action: RewriteAction, from: number, to: number, req: RewriteReq) {
    if (!editor) return;
    setRewriteBusy(action); // 결과를 적용하거나 취소할 때까지 편집을 잠근다 (useEditLock)
    try {
      if (!(await flush())) throw new Error("원고 저장을 완료한 뒤 다시 수정해주세요.");
      const r = await api<{ text: string }>(`/api/sections/${section.id}/rewrite`, {
        method: "POST",
        json: { action, ...(action === "custom" ? { mode: "custom" } : {}), ...req, content: JSON.stringify(editor.getJSON()) },
      });
      if (editor.isDestroyed) return;
      const c = editor.view.coordsAtPos(Math.min(to, editor.state.doc.content.size));
      setRewritePreview({ action, from, to, selection: req.selection, text: r.text.trim(), req, x: c.left, y: c.bottom });
    } catch (e) {
      toastError(e);
    } finally {
      setRewriteBusy(null);
    }
  }

  /** 직접 지시 — 지난번 지시를 다음 입력 칸에 채워 둔다 */
  const lastInstruction = useRef("");
  async function rewrite(action: RewriteAction) {
    if (!editor || !canEditRef.current) return;
    const { from, to } = editor.state.selection;
    if (from === to) return toast("먼저 본문에서 고칠 부분을 드래그해 선택하세요.");
    let toneTarget = "";
    let instruction = "";
    if (action === "tone") {
      toneTarget = (await promptDialog("어떤 톤으로 바꿀까요?", { choices: ["더 친근하게", "더 단호하게", "강연하듯", "더 담백하게", "더 따뜻하게"], placeholder: "직접 입력해도 됩니다", okLabel: "바꾸기" })) ?? "";
      if (!toneTarget) return;
    }
    if (action === "custom") {
      instruction = ((await promptDialog("선택한 부분을 어떻게 고칠까요?", { placeholder: `예: 문장을 짧게 끊고 비유 하나 넣기 (${CUSTOM_MAX}자 이하)`, okLabel: "고치기", initial: lastInstruction.current })) ?? "").trim();
      if (!instruction) return;
      if (instruction.length > CUSTOM_MAX) return toast.error(`지시는 ${CUSTOM_MAX}자 이하로 적어 주세요 (지금 ${instruction.length}자).`);
      lastInstruction.current = instruction;
    }
    const doc = editor.state.doc;
    await requestRewrite(action, from, to, {
      selection: doc.textBetween(from, to, NL),
      before: doc.textBetween(0, from, NL),
      after: doc.textBetween(to, doc.content.size, NL),
      toneTarget,
      ...(instruction ? { instruction } : {}),
    });
  }

  async function applyRewrite() {
    const p = rewritePreview;
    if (!editor || !p) return;
    // 미리보기 말고 다른 이유(AI 집필·교정 등)로 잠겼으면 넣지 않는다
    if (locked || proofBusy || autoChecking || conflict) return toast.error(`${locked ? "AI 집필" : proofBusy ? "교정·교열" : autoChecking ? "자동 집필 점검" : "저장 충돌"} 중이라 적용하지 않았습니다.`);
    // 적용 전 원고를 버전으로 남긴다 (되돌리기 대비) — 남기지 못해도 적용은 하되 알린다 (Ctrl+Z로 되돌릴 수 있다)
    try {
      await api(`/api/sections/${section.id}/versions`, { method: "POST", json: { content: JSON.stringify(editor.getJSON()), reason: "rewrite" } });
    } catch (e) {
      toastError(e, "적용 전 원고를 버전 기록에 남기지 못했습니다(Ctrl+Z로 되돌릴 수 있습니다): ");
    }
    if (editor.isDestroyed) return;
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
    if (editor && !editor.isDestroyed) editor.commands.focus();
  }

  /* ---------- 각주 (목록은 [각주] 탭을 열 때만 FootnotesPanel이 읽는다) ---------- */
  // 잠겨 있으면(AI 집필·교정 등) 각주도 고치지 않는다 — 편집기 밖 입력 칸·팝업에서 문서를 바꾸지 않게
  const setFootnoteNote = useStableFn((pos: number, note: string) => {
    if (!editor || !canEditRef.current || editor.state.doc.nodeAt(pos)?.type.name !== "footnote") return;
    editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, "note", note));
  });

  const deleteFootnote = useStableFn((pos: number) => {
    if (!editor || !canEditRef.current || editor.state.doc.nodeAt(pos)?.type.name !== "footnote") return;
    editor.view.dispatch(editor.state.tr.delete(pos, pos + 1));
    setFnEdit(null);
  });

  const selectFootnote = useStableFn((pos: number) => {
    if (!editor) return;
    editor.chain().focus().setNodeSelection(pos).scrollIntoView().run();
  });

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
    if (!editor || !canEditRef.current || fnBusy) return;
    const t = termAtSelection();
    if (!t) return;
    if (ai && !t.term) return toast("각주를 달 단어를 드래그해 선택하세요.");
    if (t.term.length > 80) return toast("각주는 단어나 짧은 구절(80자 이하)에 답니다.");
    let note = "";
    let at = t.at;
    if (ai) {
      setFnBusy("one"); // 쓰는 동안 편집을 잠근다 (useEditLock)
      const track = trackPositions(editor, [t.at]);
      try {
        const r = await api<{ note: string }>(`/api/sections/${section.id}/footnote`, {
          method: "POST",
          json: { action: "note", term: t.term, context: t.context },
        });
        note = r.note;
        at = track.get().positions[0];
      } catch (e: any) {
        toastError(e, "각주 AI 오류: ");
        return;
      } finally {
        track.stop();
        setFnBusy(null);
      }
      if (editor.isDestroyed) return;
    }
    at = Math.min(at, editor.state.doc.content.size);
    editor.chain().focus().insertContentAt(at, { type: "footnote", attrs: { note, term: t.term, auto: ai } }).setNodeSelection(at).run();
  }

  /** AI로 각주 다시 쓰기 — 기다리는 동안 본문을 고쳐도 같은 각주를 찾아 고친다 (예전 위치를 그대로 쓰면 다른 자리를 건드렸다) */
  async function regenFootnote(pos: number) {
    if (!editor || fnBusy || !canEditRef.current) return;
    const node = editor.state.doc.nodeAt(pos);
    if (node?.type.name !== "footnote") return;
    const a = node.attrs as FootnoteAttrs;
    const $p = editor.state.doc.resolve(pos);
    const term = a.term || termAtSelection()?.term || "";
    if (!term) return toast("각주를 단 단어를 알 수 없습니다. 내용을 직접 입력하세요.");
    setFnBusy("regen");
    setRegenPos(pos);
    const track = trackPositions(editor, [pos]);
    try {
      const r = await api<{ note: string }>(`/api/sections/${section.id}/footnote`, {
        method: "POST",
        json: { action: "note", term, context: $p.parent.textContent, current: a.note },
      });
      if (editor.isDestroyed) return;
      const at = track.get().positions[0];
      if (editor.state.doc.nodeAt(at)?.type.name !== "footnote") return toast.error("그사이 그 각주가 지워지거나 옮겨져 AI 결과를 넣지 않았습니다.");
      if (!canEditRef.current) return toast.error("그사이 이 절이 잠겨 AI 결과를 넣지 않았습니다.");
      editor.view.dispatch(editor.state.tr.setNodeAttribute(at, "note", r.note).setNodeAttribute(at, "auto", true));
    } catch (e: any) {
      toastError(e, "각주 AI 오류: ");
    } finally {
      track.stop();
      setFnBusy(null);
      setRegenPos(null);
    }
  }

  async function autoFootnote() {
    if (!editor || !canEditRef.current || fnBusy) return;
    if (isDocEmpty(editor.getJSON() as JNode)) return toast("각주를 달 본문이 없습니다.");
    if (!await flush()) return toast.error("원고 저장을 완료한 뒤 다시 시도해주세요.");
    setFnBusy("auto"); // 끝날 때까지 편집을 잠근다 (useEditLock) — 문단 번호로 넣기 때문
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
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing || e.keyCode === 229) return; // 창·메뉴가 먼저 쓴 Esc, 한글 조합 중 Esc는 건드리지 않는다
      // Esc로 집필 중지: 이 절이 잠겨 진행 창이 떠 있고, 초점이 본문(또는 아무 데도 없음)에 있을 때만 — 찾기 칸·창을 닫는 Esc가 집필을 멈추지 않게
      const j = jobRef.current;
      const at = document.activeElement;
      if (locksSection(j) && (!at || at === document.body || deskRef.current?.contains(at)) && !document.querySelector('[role="dialog"]')) {
        e.preventDefault();
        void stopWriting(j!);
        return;
      }
      setFnEdit(null);
      setBubble(null);
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
  // 도구줄에 넘기는 함수는 늘 같은 참조로 (도구줄은 memo — 편집기가 다시 그려져도 도구줄은 커서가 움직일 때만)
  const onAutoFootnote = useStableFn(autoFootnote);
  const onPickImage = useStableFn(() => fileRef.current?.click());
  const onRegenFootnote = useStableFn(regenFootnote);
  // 새 버전 후보 비교 — 입력마다 다시 읽지 않고, 비교 창을 열었을 때만 입력이 멈춘 뒤 읽는다(문단 LCS를 매번 다시 계산하지 않게)
  const comparing = candidateActive && compareOpen;
  const currentParas = useDocValue(editor, (d: PMNode) => docParagraphs(d.toJSON() as JNode), { key: (ps) => ps.join("\n"), initial: [] as string[], enabled: comparing, delay: 400 });
  const candidateParas = useMemo(() => (candidateText ? docParagraphs(markdownToDoc(candidateText)) : []), [candidateText]);

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      {/* 가운데: 편집 영역 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 작업줄 한 줄 — 왼쪽: 글 모양 도구 · 오른쪽: 목표 분량 · AI 집필 · 교정 · 팩트체크 (AI 다듬기·각주는 본문을 드래그하면 뜨는 말풍선에) */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-stone-300 bg-stone-200 px-3 py-1.5">
          {editor && <EditorToolbar editor={editor} busyReason={busyReason} bodySizePt={bodySizePt} lineHeight={lineHeight} paraSpacingMm={paraSpacingMm} onLayout={onLayout} onPickImage={onPickImage} onBookSearch={onBookSearch} />}
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f || !editor) return;
              const { from, to } = editor.state.selection;
              await insertImages([f], from, to);
            }}
          />
          <div className="ml-auto flex items-center gap-2">
            <label className="flex items-center gap-1 text-xs text-stone-600" title={`AI가 이 분량에 맞춰 씁니다 (약 ${targetChars.toLocaleString()}자)`}>
              목표
              <input
                type="number"
                min={0.5}
                max={60}
                step={0.5}
                className="w-12 rounded border border-stone-300 px-1 py-1 text-right text-sm"
                value={targetPages}
                onChange={(e) => setTargetPages(Math.max(0.5, Math.min(60, Number(e.target.value) || 1)))}
                onBlur={() => onTargetPages(targetPages)}
              />
              쪽
            </label>
            {writing ? (
              <button className="btn-primary bg-red-700 hover:bg-red-800" onClick={() => void stopWriting(writing)} title="Esc — 쓴 데까지는 본문에 넣습니다">
                ■ 중지
              </button>
            ) : (
              /* AI 집필 — 이 절 쓰기 방식과 PRO(여러 절을 한꺼번에 다루는 작업)를 한 펼침 메뉴에 */
              <Menu label="✎ AI 집필하기 ▾" align="right" buttonClass="btn-accent" disabled={!canEdit} title={busyReason || "이 절을 AI로 쓰기 · 전체 자동 집필 · 장 퇴고"}>
                {counts.chars === 0 ? (
                  <button className={MENU_ITEM} onClick={() => void writeWith("overwrite")}>
                    ✎ 이 절 집필하기 <span className="block text-xs text-stone-500">스케치·요지를 바탕으로 목표 분량만큼 씁니다</span>
                  </button>
                ) : (
                  <>
                    <button className={MENU_ITEM} onClick={() => void writeWith("continue")}>
                      뒤에 이어 쓰기 <span className="block text-xs text-stone-500">지금 본문 끝에 덧붙입니다</span>
                    </button>
                    <button className={MENU_ITEM} onClick={() => void writeWith("newVersion")}>
                      다른 버전 써 보기 <span className="block text-xs text-stone-500">지금 본문과 비교한 뒤 고릅니다</span>
                    </button>
                    <button className={MENU_ITEM} onClick={() => void writeWith("overwrite")}>
                      새로 쓰기 <span className="block text-xs text-stone-500">지금 본문은 버전 기록에 남습니다</span>
                    </button>
                  </>
                )}
                <div className="mt-1 border-t border-stone-200 px-3 pb-1 pt-2 text-[10px] font-bold tracking-wider text-violet-700">PRO</div>
                <button
                  className={MENU_ITEM}
                  disabled={autoDriving}
                  title={autoDriving ? "자동 집필이 진행 중입니다 (오른쪽 아래 진행 창)" : undefined}
                  onClick={() => setAutoOpen(true)}
                >
                  ⚡ 전체 자동 집필 <span className="block text-xs text-stone-500">여러 절·장·책 전체를 AI가 차례로 집필 → 사실 확인 → 교정</span>
                </button>
                <button
                  className={MENU_ITEM}
                  disabled={chapterWriting || chapterProofing}
                  title={chapterWriting ? "이 장에서 AI가 쓰는 절이 있습니다 — 끝난 뒤에 하세요" : chapterProofing ? "이 장에서 교정 중인 절이 있습니다 — 끝난 뒤에 하세요" : undefined}
                  onClick={async () => {
                    if (!(await flush())) return toast.error("원고 저장을 완료한 뒤 다시 시도하세요.");
                    setReviseOpen(true);
                  }}
                >
                  ↻ 장 퇴고 <span className="block text-xs text-stone-500">이 장의 절들을 함께 읽고 겹치는 내용·흐름을 고칩니다</span>
                </button>
              </Menu>
            )}
            <button className="btn" disabled={!!writing || !canEdit} onClick={runProofread} title={writing ? "AI 집필이 끝난 뒤에 교정할 수 있습니다" : busyReason || undefined}>
              {proofBusy ? "교정 중…" : "교정·교열"}
            </button>
            <button
              className={`btn ${checkCount ? "border-red-300 text-red-700" : ""}`}
              onClick={onOpenChecks}
              title="AI가 남긴 [확인 필요]·[이미지 제안] 표시를 책 전체에서 모아 확인합니다"
            >
              팩트체크{checkCount ? ` ${checkCount}` : ""}
            </button>
          </div>
        </div>

        {/* 알림 줄 */}
        {proofBusy && (
          <div className="flex items-center gap-2 border-b border-sky-200 bg-sky-50 px-4 py-2 text-sm text-sky-900">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-sky-700 border-t-transparent" />
            교정 중 — 끝날 때까지 이 절은 잠깁니다. 다른 절을 써도 됩니다.
            <button className="ml-auto shrink-0 rounded bg-sky-800 px-2 py-0.5 text-xs font-semibold text-white hover:bg-sky-700" onClick={() => stopProof(section.id)} title="교정을 멈추고 잠금을 풉니다 (고친 것은 넣지 않습니다)">
              ■ 중지
            </button>
          </div>
        )}
        {/* 새 버전 후보를 보여 주는 동안은 같은 글의 서버 보관본을 따로 알리지 않는다 */}
        <PartialBanner sectionId={section.id} busy={!!writing || candidateActive} onAppend={appendPartial} onCompare={comparePartial} inBody={partialInBody} />
        {candidateActive && !compareOpen && (
          <div className="flex flex-wrap items-center gap-2 border-b border-violet-200 bg-violet-50 px-4 py-2 text-sm text-violet-900">
            {candidateWriting ? (
              <>
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-violet-700 border-t-transparent" />
                <span>
                  새 버전 후보 작성 중 — {candidateStatus}
                  {candidateText ? ` (${candidateText.length.toLocaleString()}자)` : ""}. 지금 본문은 그대로입니다.
                </span>
                <button className="ml-auto rounded bg-violet-700 px-2 py-0.5 text-xs font-semibold text-white hover:bg-violet-600" onClick={() => setCompareOpen(true)}>
                  크게 보기
                </button>
                <button className="text-xs text-violet-700 hover:underline" onClick={() => stopJob(section.id)} title="쓴 데까지 후보로 남깁니다">
                  중지
                </button>
              </>
            ) : (
              <>
                <span className="font-semibold">새 버전 후보가 준비됐습니다</span>
                <span className="text-violet-700">({(candidateText ?? "").length.toLocaleString()}자) 지금 본문과 비교한 뒤 고르세요.</span>
                <button className="ml-auto rounded bg-violet-700 px-2 py-0.5 text-xs font-semibold text-white hover:bg-violet-600" onClick={() => setCompareOpen(true)}>
                  크게 비교
                </button>
                <button className="text-xs text-violet-700 hover:underline" onClick={dropCandidate}>
                  버리기
                </button>
              </>
            )}
          </div>
        )}
        {autoChecking && (
          <div className="flex items-center gap-2 border-b border-violet-200 bg-violet-50 px-4 py-2 text-sm text-violet-900">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-violet-700 border-t-transparent" />
            자동 집필이 이 절을 사실 확인·교정하는 중 — 끝날 때까지 잠깁니다.
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
                  disabled={!!writing || !canEdit}
                  title={busyReason || undefined}
                  onClick={() => startJob(`/api/sections/${section.id}/adjust`, { targetChars: lengthHint.target }, "adjust")}
                >
                  {lengthHint.chars < lengthHint.target ? "목표만큼 늘리기" : "목표만큼 줄이기"}
                </button>
                <button className="btn-ghost text-xs" disabled={!canEdit} onClick={undoAi}>
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
        <div ref={deskRef} className="relative flex min-h-0 flex-1 flex-col">
        {locked && job && (
          <WritingOverlay
            status={job.status}
            text={job.md.slice(-600)}
            chars={job.chars}
            target={job.target}
            step={job.batch ? { ...job.batch, label: job.label } : null}
            startedAt={job.startedAt}
            onStop={() => void stopWriting(job)}
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
                  {/* 집필 전에 개요를 보고 고친다 — 저장한 개요가 있으면 [AI 집필하기]가 그대로 쓴다 */}
                  <OutlinePanel
                    sectionId={section.id}
                    sketch={sketch}
                    targetPages={targetPages}
                    open={outlineOpen}
                    onOpenChange={setOutlineOpen}
                    beforeRequest={flush}
                    disabled={!canEdit || !!writing}
                    disabledReason={writing ? "AI가 쓰는 중에는 개요를 바꿀 수 없습니다" : busyReason}
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
                  <button className="ml-auto rounded bg-red-700 px-2 py-0.5 text-white hover:bg-red-800" onClick={() => void stopWriting(writing)}>
                    ■ 중지
                  </button>
                </div>
                <p className="mt-1.5 line-clamp-3 whitespace-pre-line font-book text-[12px] leading-5 text-stone-600">{writing.md.replace(/⟦주:[^⟧]*⟧/g, "").replace(/[#*>]/g, "").slice(-240) || "첫 문장을 구상하고 있습니다…"}</p>
                <p className="mt-1 text-[11px] text-amber-700">그동안 위 본문을 고쳐도 됩니다. 다 쓰면 그때의 본문 끝에 이어 붙입니다.</p>
              </div>
            )}
            <p className="mt-2 text-center font-sans text-[10px] text-stone-400" title={pg?.synced ? "미리보기와 같은 쪽 나눔입니다" : "저장하면 미리보기와 같은 쪽 나눔으로 맞춥니다"}>
              이 절 {pg?.pages ?? 1}쪽
            </p>
          </div>
        </div>
        </div>

        {/* 상태 줄 */}
        <div className="flex items-center gap-4 border-t border-stone-300 bg-stone-200 px-4 py-1.5 text-xs text-stone-600">
          <span
            title={
              pageInfo && pageInfo.start > 0
                ? `${pageInfo.side === "right" ? "오른쪽" : "왼쪽"} 페이지부터 시작${caretPage !== null ? ` · 커서는 ${sideOf(caretPage)} 페이지` : ""}`
                : undefined
            }
          >
            {pageInfo && pageInfo.start === 0 ? (
              "앞붙이 (쪽 번호 없음)"
            ) : pageInfo ? (
              <>
                <b className="text-stone-700">
                  p.{pageInfo.start}
                  {pageInfo.end !== pageInfo.start && `–${pageInfo.end}`}
                </b>
                {caretPage !== null && <span className="ml-1.5 text-stone-400">· 커서 {pageNo(caretPage)}</span>}
              </>
            ) : (
              "쪽 계산 중…"
            )}
          </span>
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
          <span className="ml-auto hidden text-stone-400 lg:inline">글을 드래그하면 AI 다듬기·각주 메뉴가 뜹니다</span>
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
      {/* 패널을 닫았을 때 — 오른쪽 끝의 좁은 띠를 누르면 다시 연다 */}
      {!panelOpen && (
        <button
          className="flex w-7 shrink-0 flex-col items-center gap-1 border-l border-stone-300 bg-stone-100 pt-3 text-xs text-stone-500 hover:bg-stone-200 hover:text-stone-800"
          onClick={() => setPanelOpen(true)}
          title="오른쪽 패널 열기"
          aria-label="오른쪽 패널 열기"
        >
          ◂<span style={{ writingMode: "vertical-rl" }}>패널 열기</span>
        </button>
      )}
      <aside
        className={`${panelOpen ? "flex" : "hidden"} w-80 shrink-0 flex-col border-l border-stone-300 bg-stone-50 max-xl:absolute max-xl:inset-y-0 max-xl:right-0 max-xl:z-30 max-xl:shadow-2xl`}
      >
        <PanelTabs tab={tab} onTab={setTab} labels={{ notes: <FootnoteTabLabel editor={editor} /> }} />
        <div className="min-h-0 flex-1 overflow-hidden">
          {tab === "ai" && (
            <div className="h-full space-y-4 overflow-auto p-3 text-sm">
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
              {section.hook && <p className="text-xs text-amber-800">✦ 흥미 포인트: {section.hook}</p>}
              <details className="rounded-lg bg-stone-100 p-2.5 text-xs leading-5 text-stone-600">
                <summary className="cursor-pointer font-semibold text-stone-700">AI가 참고하는 것</summary>
                <ul className="mt-1 list-disc pl-4">
                  <li>책 정보 · 목차 · 앞 절 내용</li>
                  <li>내 문체 {project.styleProfile ? "✓" : "(책 설정에서 학습할 수 있어요)"}</li>
                  {project.glossary.length > 0 && <li>용어집 {project.glossary.length}개</li>}
                  <li>
                    <button className="underline" onClick={() => setTab("refs")}>
                      자료
                    </button>{" "}
                    탭에 올린 글 (출처 표시)
                  </li>
                </ul>
              </details>
              {/* 개발자 정보 — 관리자에게만 */}
              {me?.role === "superadmin" && (
                <details className="rounded border border-stone-200 p-2 text-xs text-stone-500">
                  <summary className="cursor-pointer font-semibold text-stone-600">고급</summary>
                  <p className="mt-2 text-[11px] leading-4 text-stone-400">저장 후 입력이 20초간 멈추면 요약을 미리 갱신합니다. 스케치가 있는 5쪽 초과 절은 개요도 준비합니다.</p>
                  {lastTiming ? (
                    <div className="mt-2">
                      <div>
                        최근 집필 {(lastTiming.totalMs / 1000).toFixed(1)}초 · 첫 본문 {lastTiming.firstTextMs === null ? "없음" : `${(lastTiming.firstTextMs / 1000).toFixed(1)}초`}
                      </div>
                      <dl className="mt-1 grid grid-cols-2 gap-1">
                        <dt>원고 불러오기</dt><dd>{(lastTiming.loadMs / 1000).toFixed(1)}초</dd>
                        <dt>앞 내용 정리</dt><dd>{(lastTiming.summaryMs / 1000).toFixed(1)}초</dd>
                        <dt>집필 개요{lastTiming.outlineCached ? " (재사용)" : ""}</dt><dd>{(lastTiming.outlineMs / 1000).toFixed(1)}초</dd>
                        <dt>본문 생성</dt><dd>{(lastTiming.generationMs / 1000).toFixed(1)}초</dd>
                      </dl>
                      <p className="mt-1">첫 본문 시간은 서버 집필 시작부터, 본문 생성 시간은 모델 응답 대기를 포함합니다. 현재 탭에서 측정한 결과입니다.</p>
                    </div>
                  ) : (
                    <p className="mt-2 text-[11px] text-stone-400">이 탭에서 이 절을 집필하면 단계별 시간이 여기에 보입니다.</p>
                  )}
                </details>
              )}
            </div>
          )}
          {tab === "refs" && <ReferencesPanel sectionId={section.id} />}
          {tab === "memory" && <MemoryPanel projectId={project.id} where={secLabel} draft={memoryDraft} onDraftUsed={clearMemoryDraft} />}
          {tab === "images" && editor && (
            <ImagesPanel
              sectionId={section.id}
              lockReason={busyReason}
              getContent={() => JSON.stringify(editor.getJSON())}
              editor={editor}
              bookTitle={project.title}
              sectionTitle={section.title}
              onInsert={insertSuggestedImage}
              onInsertMade={insertMadeFigure}
              onLocate={locateSuggestion}
            />
          )}
          {tab === "versions" && editor && (
            <VersionsPanel
              beforeRestore={flush}
              onServerEdited={onServerEdited}
              sectionId={section.id}
              refreshKey={versionKey}
              lockReason={busyReason}
              getCurrent={() => editor.getJSON() as JNode}
              onRestore={async (c) => {
                noteServerContent(section.id, c); // 서버가 이미 이 버전으로 바꿨다 — 다음 저장이 충돌로 보이지 않게
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
              onKeep={async (c) => {
                try {
                  const { addMemory } = await import("./MemoryPanel");
                  await addMemory(project.id, "keep", `“${c.before.trim()}”은(는) 의도한 표현이다 — “${c.after.trim()}”(으)로 고치지 않는다`, secLabel);
                  toast.success("표현 유지로 책의 기억에 남겼습니다. 다음 교정·퇴고는 이곳을 고치자고 하지 않습니다.");
                  return true;
                } catch (e) {
                  toastError(e, "책의 기억에 남기지 못했습니다: ");
                  return false;
                }
              }}
            />
          )}
          {tab === "notes" && editor && (
            <FootnotesPanel
              editor={editor}
              lockReason={busyReason}
              fnBusy={fnBusy}
              regenPos={regenPos}
              activePos={fnEdit?.pos ?? null}
              onAuto={onAutoFootnote}
              onSelect={selectFootnote}
              onChange={setFootnoteNote}
              onRegen={onRegenFootnote}
              onDelete={deleteFootnote}
            />
          )}
        </div>
        <button
          className="flex items-center justify-center gap-1 border-t border-stone-200 bg-white py-1.5 text-xs text-stone-500 hover:bg-stone-100 hover:text-stone-800"
          onClick={() => setPanelOpen(false)}
          title="오른쪽 패널 닫기"
        >
          패널 닫기 ▸
        </button>
      </aside>

      {reviseOpen && (
        <ChapterReviseDialog
          chapterId={chapter.id}
          chapterName={`${chapter.label} ${chapter.title}`.trim()}
          chapters={numberChapters(project.chapters, project.layout.numberFormat).map((c) => ({ id: c.id, name: `${c.label} ${c.title}`.trim(), sectionIds: c.sections.map((x) => x.id) }))}
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

      {compareOpen && candidateActive && editor && (
        <CandidateCompareDialog
          current={currentParas}
          candidate={candidateParas}
          writing={candidateWriting}
          status={candidateStatus}
          onAccept={() => {
            setCompareOpen(false);
            void acceptCandidate();
          }}
          onDiscard={() => {
            setCompareOpen(false);
            dropCandidate();
          }}
          onClose={() => setCompareOpen(false)}
        />
      )}

      {autoOpen && (
        <AutoWriteDialog
          projectId={project.id}
          currentSectionId={section.id}
          currentChapterId={chapter.id}
          initialExtra={extra.trim() || (extraMem.keep ? extraMem.text : "") || extraMem.recent[0] || ""}
          recentExtra={extraMem.recent}
          onClose={() => setAutoOpen(false)}
          onStart={startAuto}
        />
      )}

      {/* 드래그 선택 → 말풍선: 단어·구절이면 각주, 문장·문단이면 다듬기·늘리기… */}
      {bubble && !fnEdit && !streaming && !rewritePreview && (
        <SelectionBubble
          x={bubble.x}
          y={bubble.y}
          length={bubble.len}
          singleBlock={bubble.single}
          disabled={!canEdit || !!fnBusy}
          fnBusy={fnBusy === "one"}
          rewriteBusy={rewriteBusy}
          onFootnote={(ai) => void addFootnote(ai)}
          onRewrite={(a) => void rewrite(a)}
          onMemory={() => {
            if (!editor) return;
            const { from, to } = editor.state.selection;
            setMemoryDraft(editor.state.doc.textBetween(from, to, " ").trim());
            setTab("memory");
            setPanelOpen(true);
          }}
        />
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
          onKeyDown={(e) => {
            if (e.key !== "Escape" || e.nativeEvent.isComposing) return;
            e.preventDefault(); // 창을 닫는 Esc — 집필 중지로 새지 않게
            cancelRewrite();
          }}
        >
          <div className="mb-2 flex items-center gap-2 text-xs">
            <b className="min-w-0 truncate text-violet-800" title={rewritePreview.req.instruction}>
              ✦ {rewritePreview.action === "custom" ? `직접 지시: ${rewritePreview.req.instruction ?? ""}` : REWRITE_LABEL[rewritePreview.action]}
            </b>
            <span className="shrink-0 text-stone-400">
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
          number={footnoteNumberAt(editor, fnEdit.pos)}
          attrs={editor.state.doc.nodeAt(fnEdit.pos)!.attrs as FootnoteAttrs}
          busy={fnBusy === "regen"}
          lockReason={busyReason}
          onChange={(v) => setFootnoteNote(fnEdit.pos, v)}
          onRegen={() => regenFootnote(fnEdit.pos)}
          onDelete={() => deleteFootnote(fnEdit.pos)}
          onClose={() => {
            setFnEdit(null);
            editor.commands.focus();
          }}
        />
      )}

      {/* 저장 충돌 — 다른 창·서버 작업이 먼저 고쳤다. 고를 때까지 저장을 멈추고 편집을 잠근다 */}
      {conflict && (
        <SaveConflictDialog
          label={secLabel}
          server={conflict.content}
          mine={editor ? JSON.stringify(editor.getJSON()) : undefined}
          onKeepMine={async () => {
            commitEdit();
            await resolveConflict(section.id, "mine");
          }}
          onTakeServer={async () => {
            commitEdit();
            await resolveConflict(section.id, "server");
            onServerEdited(); // 서버 원고로 다시 불러온다
          }}
        />
      )}
    </div>
  );
}

/** [AI 집필하기 ▾] 메뉴 항목 */
const MENU_ITEM = "block w-64 px-3 py-2 text-left text-sm hover:bg-stone-100 disabled:opacity-40";

/** 직접 지시 최대 길이 (서버와 같은 값) */
const CUSTOM_MAX = 500;
type RewriteReq = { selection: string; before: string; after: string; toneTarget: string; instruction?: string };

/** 선택 영역 글자를 문단 사이 줄바꿈으로 이어 읽는다 */
const NL = "\n";


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
