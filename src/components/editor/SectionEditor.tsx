"use client";

import Placeholder from "@tiptap/extension-placeholder";
import { NodeSelection } from "@tiptap/pm/state";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, readStream } from "@/lib/client";
import { attachFile } from "@/lib/upload-client";
import {
  appendDocs,
  charCount,
  charCountNoSpace,
  docToMarkdown,
  emptyDoc,
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
import { findInBlock, posAfterTerm, replaceInBlock, selectInBlock } from "./pmOps";
import { recoverPending, settleSection, useAutosave, type SaveState } from "./useAutosave";
import VersionsPanel from "./VersionsPanel";
import FindPanel from "./FindPanel";
import BatchWriteDialog, { BATCH_MAX, type BatchItem, type SectionRef } from "./BatchWriteDialog";
import WritingOverlay from "./WritingOverlay";

type Props = {
  project: ProjectTree;
  chapter: TreeChapter & { label: string };
  section: TreeSection & { label: string };
  pageInfo?: SectionPageInfo;
  onMeta: (patch: Partial<TreeSection>) => void;
  onSaved: () => void;
  onRename: (title: string) => void;
  onRenameChapter: (title: string) => void;
  onTargetPages: (n: number) => void;
  onSaveState: (s: SaveState) => void;
  onLayout: (patch: Partial<LayoutSettings>) => void;
  allSections: SectionRef[];
  onTreeChanged: () => void;
};

type Loaded = { content: string; sketch: string; status: string; updatedAt: string; recovered: boolean };

export default function SectionEditor(props: Props) {
  const [data, setData] = useState<Loaded | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let alive = true;
    settleSection(props.section.id).then(() => api(`/api/sections/${props.section.id}`))
      .then(async (s) => {
        const rec = await recoverPending(props.section.id, s.updatedAt);
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

function EditorCore({ project, chapter, section, pageInfo, onMeta, onSaved, onRename, onRenameChapter, onTargetPages, onSaveState, onLayout, allSections, onTreeChanged, data }: Props & { data: Loaded }) {
  const cpp = project.charsPerPage || 700;
  const [sketch, setSketch] = useState(data.sketch);
  const [sketchOpen, setSketchOpen] = useState(!data.content || isDocEmpty(parseDoc(data.content)));
  const [status, setStatus] = useState(data.status);
  const [counts, setCounts] = useState(() => {
    const d = parseDoc(data.content);
    return { chars: charCount(d), noSpace: charCountNoSpace(d) };
  });
  const [targetPages, setTargetPages] = useState<number>(section.targetPages || 3);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [modeAsk, setModeAsk] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchStep, setBatchStep] = useState<{ i: number; n: number; label: string } | null>(null);
  const [live, setLive] = useState<{ text: string; chars: number; target: number } | null>(null);
  const [candidate, setCandidate] = useState<string | null>(null);
  const [lengthHint, setLengthHint] = useState<null | { chars: number; target: number }>(null);
  const [tab, setTab] = useState<"ai" | "versions" | "proof" | "notes">("ai");
  const [extra, setExtra] = useState("");
  const [proofLevel, setProofLevel] = useState<"proof" | "light">("proof");
  const [proof, setProof] = useState<AppliedChange[] | null>(null);
  const [proofBusy, setProofBusy] = useState(false);
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
  const streamingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const sketchRef = useRef(sketch);
  sketchRef.current = sketch;

  const { state: saveState, markDirty, flush } = useAutosave(section.id, (r) => {
    onMeta({ charCount: r.charCount, status: r.status, updatedAt: r.updatedAt });
    onSaved();
  });
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
            alert(e.message);
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
            alert(e.message);
          }
        });
        return true;
      },
    },
    onUpdate: ({ editor }) => {
      if (streamingRef.current) return;
      const doc = editor.getJSON() as JNode;
      const st = statusFor(doc);
      setStatus(st);
      setCounts({ chars: charCount(doc), noSpace: charCountNoSpace(doc) });
      markDirty({ content: JSON.stringify(doc), status: st });
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

  const runPaginate = useCallback(() => {
    if (!editor || editor.isDestroyed || !sheetRef.current || !scrollRef.current || !contentRef.current) return false;
    if (editor.view.composing) return false; // 한글 조합 중에는 건드리지 않는다
    const sc = scrollRef.current;
    const keep = sc.scrollTop;
    const r = paginate(editor.view, { sheet: sheetRef.current, measureHost: contentRef.current, geom, docWidthMm: DOC.width, leadMm, label: pageLabel });
    sc.scrollTop = keep;
    setPg(r);
    updateCaretPage(editor);
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, geom, leadMm, pageLabel]);

  const pgTimer = useRef<number | undefined>(undefined);
  const pgSince = useRef(0);
  const schedulePaginate = useCallback(
    (delay = 250) => {
      const now = Date.now();
      if (!pgSince.current) pgSince.current = now;
      window.clearTimeout(pgTimer.current);
      const wait = Math.max(0, Math.min(delay, pgSince.current + 1200 - now)); // 계속 바뀌어도 1.2초마다는 다시 잰다
      pgTimer.current = window.setTimeout(() => {
        if (runPaginate()) pgSince.current = 0;
        else pgTimer.current = window.setTimeout(() => schedulePaginate(400), 400);
      }, wait);
    },
    [runPaginate],
  );

  useEffect(() => {
    if (!editor) return;
    const onTr = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      if (!transaction.docChanged) return;
      setDocTick((t) => t + 1);
      schedulePaginate();
    };
    const onCompEnd = () => schedulePaginate(150);
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
    if (sel instanceof NodeSelection && sel.node.type.name === "footnote") {
      const c = ed.view.coordsAtPos(sel.from);
      setFnEdit({ pos: sel.from, x: c.left, y: c.bottom });
      setBubble(null);
      return;
    }
    if (ed.view.hasFocus()) setFnEdit(null);
    if (!sel.empty && ed.isEditable && !(sel instanceof NodeSelection)) {
      const a = ed.view.coordsAtPos(sel.from);
      setBubble({ x: a.left, y: a.top });
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
   * AI 스트리밍 집필. 집필 중에는 편집 화면을 건드리지 않고(흔들림 방지) 가운데 진행 창에만 흐름을 보여 주다가,
   * 다 쓰면 한 번에 본문에 넣는다. 새 버전 비교(newVersion)는 오른쪽 패널에 흘려 보여 준다.
   */
  async function runStream(url: string, body: object, mode: "overwrite" | "continue" | "newVersion" | "adjust", outer?: AbortController) {
    if (!editor) return;
    if (!await flush()) return alert("원고 저장에 실패했습니다. 저장을 완료한 뒤 다시 집필해주세요.");
    const base = mode === "continue" ? (editor.getJSON() as JNode) : emptyDoc();
    const figures = mode === "adjust" ? docToMarkdown(editor.getJSON() as JNode).figures : [];
    const ctrl = outer ?? new AbortController();
    abortRef.current = ctrl;
    streamingRef.current = mode !== "newVersion";
    if (mode !== "newVersion") editor.setEditable(false, false); // false: update 이벤트를 내지 않아 상태가 '수정 중'으로 바뀌지 않게
    setStreaming("준비 중…");
    setLive(mode === "newVersion" ? null : { text: "", chars: 0, target: mode === "adjust" ? (body as any).targetChars ?? targetChars : Math.round(((body as any).targetPages ?? targetPages) * cpp) });
    setLengthHint(null);
    setSketchOpen(false);
    let md = "";
    let last = 0;
    const docOf = () => (mode === "continue" ? appendDocs(base, markdownToDoc(md, figures)) : markdownToDoc(md, figures));
    const progress = () => {
      if (mode === "newVersion") return setCandidate(md);
      setLive((l) => (l ? { ...l, text: md.slice(-600), chars: charCount(markdownToDoc(md)) } : l));
    };
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal });
      await readStream(res, (e) => {
        if (e.t === "status" && e.v === "truncated") {
          setNotice("AI 출력이 한도에 걸려 중간에 끊겼습니다. [집필하기 → 뒤에 이어쓰기]로 이어 쓸 수 있습니다.");
          return;
        }
        if (e.t === "status") setStreaming(e.v ?? "");
        if (e.t === "delta") {
          if (!md) setStreaming((s) => (s && s.startsWith("구상") ? "집필 중…" : s));
          md += e.v ?? "";
          if (Date.now() - last > 250) {
            last = Date.now();
            progress();
          }
        }
        if (e.t === "error") throw new Error(e.v);
      });
    } catch (e: any) {
      if (!ctrl.signal.aborted) alert("AI 오류: " + e.message);
    } finally {
      if (editor.isDestroyed) {
        if (mode !== "newVersion" && md.trim()) {
          markDirty({ content: JSON.stringify(docOf()), status: "ai_draft" });
          await flush();
        }
        return;
      }
      if (md.trim()) {
        if (mode === "newVersion") setCandidate(md);
        else {
          // 완성된 글을 한 번에 넣는다
          const d = docOf();
          setDoc(d);
          setCounts({ chars: charCount(d), noSpace: charCountNoSpace(d) });
          if (mode !== "continue") scrollRef.current?.scrollTo({ top: 0 });
        }
      }
      streamingRef.current = false;
      editor.setEditable(true, false);
      setStreaming(null);
      setLive(null);
      if (!outer) abortRef.current = null;
      if (mode !== "newVersion" && md.trim()) {
        await commitDoc("ai_draft");
        setVersionKey((k) => k + 1);
        checkLength(charCount(editor.getJSON() as JNode));
        fetch(`/api/sections/${section.id}/summarize`, { method: "POST" }).catch(() => {});
      }
    }
  }

  /** 다른 절 집필 — 편집기 밖에서 받아 서버에 바로 저장한다 */
  async function writeOther(it: BatchItem, ctrl: AbortController) {
    setStreaming("준비 중…");
    setLive({ text: "", chars: 0, target: Math.round(it.targetPages * cpp) });
    let md = "";
    let last = 0;
    try {
      const res = await fetch(`/api/sections/${it.id}/write`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetPages: it.targetPages, mode: "overwrite", extraInstruction: extra }),
        signal: ctrl.signal,
      });
      await readStream(res, (e) => {
        if (e.t === "status" && e.v === "truncated") return;
        if (e.t === "status") setStreaming(e.v ?? "");
        if (e.t === "delta") {
          md += e.v ?? "";
          if (Date.now() - last > 250) {
            last = Date.now();
            setLive((l) => (l ? { ...l, text: md.slice(-600), chars: charCount(markdownToDoc(md)) } : l));
          }
        }
        if (e.t === "error") throw new Error(e.v);
      });
    } catch (e) {
      if (!ctrl.signal.aborted) throw e; // 중지했으면 쓴 데까지 저장
    }
    if (!md.trim()) return;
    await api(`/api/sections/${it.id}`, { method: "PUT", json: { content: JSON.stringify(markdownToDoc(md)), status: "ai_draft" } });
    fetch(`/api/sections/${it.id}/summarize`, { method: "POST" }).catch(() => {});
  }

  /** 여러 절(최대 3개) 한 번에 집필 — 책 순서대로 하나씩 쓰고 저장한다(앞 절 요약이 다음 절에 이어진다) */
  async function runBatch(items: BatchItem[]) {
    if (!editor || !items.length) return;
    setBatchOpen(false);
    if (!await flush()) return alert("원고 저장에 실패했습니다. 저장을 완료한 뒤 다시 집필해주세요.");
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
    } catch (e: any) {
      return alert("스케치 저장 실패: " + e.message);
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const done: string[] = [];
    try {
      for (const [i, it] of items.entries()) {
        if (ctrl.signal.aborted) break;
        setBatchStep({ i: i + 1, n: items.length, label: `${it.label} ${it.title}`.trim() });
        if (it.id === section.id) await runStream(`/api/sections/${section.id}/write`, { targetPages: it.targetPages, mode: "overwrite", extraInstruction: extra }, "overwrite", ctrl);
        else {
          editor.setEditable(false, false);
          await writeOther(it, ctrl);
        }
        if (!ctrl.signal.aborted) done.push(`${it.label} ${it.title}`.trim());
      }
    } catch (e: any) {
      if (!ctrl.signal.aborted) alert("AI 오류: " + e.message);
    } finally {
      abortRef.current = null;
      setBatchStep(null);
      setStreaming(null);
      setLive(null);
      if (!editor.isDestroyed) editor.setEditable(true, false);
      onTreeChanged();
      if (done.length) setNotice(`${done.length}개 절을 집필했습니다: ${done.join(", ")}. 목차에서 각 절을 열어 확인하세요.`);
    }
  }

  const startWrite = (mode: "overwrite" | "continue" | "newVersion") => {
    setModeAsk(false);
    onTargetPages(targetPages);
    if (mode === "newVersion") {
      setTab("ai");
      setPanelOpen(true);
    }
    runStream(`/api/sections/${section.id}/write`, { targetPages, mode, extraInstruction: extra }, mode);
  };

  const onWriteClick = () => {
    if (!sketch.trim() && !section.gist) {
      if (!confirm("스케치가 비어 있습니다. 목차의 절 요지만으로 쓸까요?")) return;
    }
    if (editor && !isDocEmpty(editor.getJSON() as JNode)) setModeAsk(true);
    else startWrite("overwrite");
  };

  const acceptCandidate = async () => {
    if (!candidate || !editor) return;
    await api(`/api/sections/${section.id}/versions`, { method: "POST", json: { content: JSON.stringify(editor.getJSON()) } });
    setDoc(markdownToDoc(candidate), true);
    setCandidate(null);
    await commitDoc("ai_draft");
    setVersionKey((k) => k + 1);
    checkLength(charCount(editor.getJSON() as JNode));
    fetch(`/api/sections/${section.id}/summarize`, { method: "POST" }).catch(() => {});
  };

  const undoAi = async () => {
    const vs = await api<{ id: string; reason: string }[]>(`/api/sections/${section.id}/versions`);
    const v = vs.find((x) => x.reason === "ai_write" || x.reason === "length_adjust");
    if (!v) return alert("되돌릴 AI 집필 이전 버전이 없습니다.");
    const r = await api<{ content: string }>(`/api/versions/${v.id}`, { method: "POST", json: { currentContent: JSON.stringify(editor?.getJSON()) } });
    setDoc(parseDoc(r.content), true);
    await commitDoc(statusFor(parseDoc(r.content)));
    setLengthHint(null);
    setVersionKey((k) => k + 1);
  };

  /* ---------- 교정·교열 ---------- */
  async function runProofread() {
    if (!editor) return;
    if (isDocEmpty(editor.getJSON() as JNode)) return alert("교정할 본문이 없습니다.");
    if (!await flush()) return alert("원고 저장을 완료한 뒤 다시 교정해주세요.");
    setTab("proof");
    setPanelOpen(true);
    setProofBusy(true);
    editor.setEditable(false, false);
    const before = editor.getJSON() as JNode;
    try {
      const r = await api<{ changes: Omit<AppliedChange, "state">[]; failed: Omit<AppliedChange, "state">[] }>(`/api/sections/${section.id}/proofread`, {
        method: "POST",
        json: { content: JSON.stringify(before), level: proofLevel },
      });
      if (editor.isDestroyed) return;
      setPreProof(before);
      const applied: AppliedChange[] = r.changes.map((c) => ({
        ...c,
        state: replaceInBlock(editor, c.paragraph, c.before, c.after) ? "applied" : "failed",
      }));
      setProof([...applied, ...r.failed.map((c) => ({ ...c, state: "failed" as const }))]);
      await commitDoc("proofread");
      setVersionKey((k) => k + 1);
    } catch (e: any) {
      alert("교정 오류: " + e.message);
    } finally {
      setProofBusy(false);
      if (!editor.isDestroyed) editor.setEditable(true, false);
    }
  }

  const revertOne = async (i: number) => {
    if (!editor || !proof) return;
    const c = proof[i];
    const ok = replaceInBlock(editor, c.paragraph, c.after, c.before);
    if (!ok) return alert("이미 다른 수정이 있어 이 항목만 되돌릴 수 없습니다. [전체 되돌리기]나 버전 기록을 쓰세요.");
    setProof(proof.map((x, k) => (k === i ? { ...x, state: "reverted" } : x)));
    await commitDoc("editing");
  };

  const revertAll = async () => {
    if (!preProof || !editor) return;
    if (!confirm("교정 전 상태로 모두 되돌릴까요?")) return;
    setDoc(preProof, true);
    setProof((p) => p?.map((x) => (x.state === "applied" ? { ...x, state: "reverted" } : x)) ?? null);
    await commitDoc("editing");
  };

  /* ---------- 선택 영역 AI ---------- */
  async function rewrite(action: "polish" | "expand" | "shorten" | "tone" | "example") {
    if (!editor || streaming || proofBusy || rewriteBusy) return;
    const { from, to } = editor.state.selection;
    if (from === to) return alert("먼저 본문에서 고칠 부분을 드래그해 선택하세요.");
    let toneTarget = "";
    if (action === "tone") {
      toneTarget = prompt("어떤 톤으로 바꿀까요? (예: 더 친근하게, 더 단호하게, 강연하듯)") ?? "";
      if (!toneTarget) return;
    }
    const doc = editor.state.doc;
    const selection = doc.textBetween(from, to, "\n");
    const before = doc.textBetween(0, from, "\n");
    const after = doc.textBetween(to, doc.content.size, "\n");
    setRewriteBusy(action);
    editor.setEditable(false, false);
    try {
      if (!await flush()) return alert("원고 저장을 완료한 뒤 다시 수정해주세요.");
      const r = await api<{ text: string }>(`/api/sections/${section.id}/rewrite`, {
        method: "POST",
        json: { action, selection, before, after, toneTarget, content: JSON.stringify(editor.getJSON()) },
      });
      if (editor.isDestroyed) return;
      const parts = markdownToDoc(r.text).content ?? [];
      const single = parts.length === 1 && parts[0].type === "paragraph";
      if (action === "example") {
        const $to = editor.state.doc.resolve(to);
        const end = $to.after($to.depth > 0 ? 1 : 0);
        editor.chain().focus().insertContentAt(end, parts).run();
      } else if (single) {
        editor.chain().focus().insertContentAt({ from, to }, parts[0].content ?? []).run();
      } else {
        editor.chain().focus().insertContentAt({ from, to }, parts).run();
      }
      setVersionKey((k) => k + 1);
    } catch (e: any) {
      alert(e.message);
    } finally {
      setRewriteBusy(null);
      if (!editor.isDestroyed) editor.setEditable(true, false);
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
    if (ai && !t.term) return alert("각주를 달 단어를 드래그해 선택하세요.");
    if (t.term.length > 80) return alert("각주는 단어나 짧은 구절(80자 이하)에 답니다.");
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
        alert("각주 AI 오류: " + e.message);
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
    if (!term) return alert("각주를 단 단어를 알 수 없습니다. 내용을 직접 입력하세요.");
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
      alert("각주 AI 오류: " + e.message);
    } finally {
      setFnBusy(null);
    }
  }

  async function autoFootnote() {
    if (!editor || streaming || proofBusy || rewriteBusy || fnBusy) return;
    if (isDocEmpty(editor.getJSON() as JNode)) return alert("각주를 달 본문이 없습니다.");
    if (!await flush()) return alert("원고 저장을 완료한 뒤 다시 시도해주세요.");
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
      alert("자동 각주 오류: " + e.message);
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
      if (e.key === "Escape" && abortRef.current) abortRef.current.abort();
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
  const tb = (label: string, onClick: () => void, active = false, title?: string) => (
    <button
      key={label + (title ?? "")}
      title={title ?? label}
      disabled={!!streaming || proofBusy || !!rewriteBusy || !!fnBusy}
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
          <button className="btn" disabled={!!streaming || proofBusy || !!rewriteBusy || !!fnBusy} onClick={runProofread}>
            {proofBusy ? "교정 중…" : "교정·교열"}
          </button>
          {streaming ? (
            <button className="btn-primary bg-red-700 hover:bg-red-800" onClick={() => abortRef.current?.abort()}>
              ■ 중지
            </button>
          ) : (
            <div className="relative">
              <div className="flex gap-2">
                <button className="btn-accent" onClick={onWriteClick} disabled={proofBusy || !!rewriteBusy}>
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
              <div className="flex flex-wrap items-center gap-2">
                <ToolGroup label="본문" tone="bg-stone-700">
                  {tb("소제목", () => editor.chain().focus().toggleHeading({ level: 3 }).run(), editor.isActive("heading"))}
                  {tb("굵게", () => editor.chain().focus().toggleBold().run(), editor.isActive("bold"))}
                  {tb("기울임", () => editor.chain().focus().toggleItalic().run(), editor.isActive("italic"))}
                  {tb("인용", () => editor.chain().focus().toggleBlockquote().run(), editor.isActive("blockquote"))}
                  {tb("• 목록", () => editor.chain().focus().toggleBulletList().run(), editor.isActive("bulletList"))}
                  {tb("1. 목록", () => editor.chain().focus().toggleOrderedList().run(), editor.isActive("orderedList"))}
                  {tb("구분선", () => editor.chain().focus().setHorizontalRule().run())}
                  {tb("🖼 이미지", () => fileRef.current?.click())}
                  {tb("↶ 되돌리기", () => editor.chain().focus().undo().run(), false, "실행 취소 (Ctrl+Z)")}
                  {tb("↷ 앞으로", () => editor.chain().focus().redo().run(), false, "다시 실행 (Ctrl+Y)")}
                </ToolGroup>
                <ToolGroup label="선택영역 AI" tone="bg-violet-700">
                  {(["polish", "expand", "shorten", "tone", "example"] as const).map((a) =>
                    tb(
                      rewriteBusy === a ? "…" : { polish: "다듬기", expand: "늘리기", shorten: "줄이기", tone: "톤 바꾸기", example: "예시 추가" }[a],
                      () => rewrite(a),
                      false,
                      "본문을 드래그해 선택한 뒤 누르세요",
                    ),
                  )}
                </ToolGroup>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <ToolGroup label="서식" tone="bg-sky-800" title="책 전체 본문에 적용됩니다 (미리보기·PDF·HWPX 포함)">
                  <label className="flex items-center gap-1 px-1 py-0.5 text-xs text-stone-600">
                    글자
                    <select className="rounded border border-stone-300 bg-white px-1 py-0.5 text-xs" value={bodySizePt} onChange={(e) => onLayout({ bodySizePt: Number(e.target.value) })}>
                      {[9, 9.5, 10, 10.5, 11, 11.5, 12].map((v) => (
                        <option key={v} value={v}>
                          {v}pt
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex items-center gap-1 px-1 py-0.5 text-xs text-stone-600">
                    줄간격
                    <select className="rounded border border-stone-300 bg-white px-1 py-0.5 text-xs" value={lineHeight} onChange={(e) => onLayout({ lineHeight: Number(e.target.value) })}>
                      {[1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2].map((v) => (
                        <option key={v} value={v}>
                          {Math.round(v * 100)}%
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex items-center gap-1 px-1 py-0.5 text-xs text-stone-600">
                    문단 간격
                    <select className="rounded border border-stone-300 bg-white px-1 py-0.5 text-xs" value={paraSpacingMm} onChange={(e) => onLayout({ paraSpacingMm: Number(e.target.value) })}>
                      {[0, 1, 2, 3, 4, 5, 6].map((v) => (
                        <option key={v} value={v}>
                          {v ? `${v}mm` : "없음"}
                        </option>
                      ))}
                    </select>
                  </label>
                </ToolGroup>
                <ToolGroup label="각주" tone="bg-amber-700">
                  <button
                    title="드래그한 단어에 AI가 각주를 씁니다"
                    disabled={selEmpty || !!streaming || proofBusy || !!rewriteBusy || !!fnBusy}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => addFootnote(true)}
                    className={`px-1.5 py-1 text-xs ${selEmpty ? "text-stone-400" : "bg-amber-100 font-semibold text-amber-900 hover:bg-amber-200"} disabled:opacity-50`}
                  >
                    {fnBusy === "one" ? "각주 쓰는 중…" : "✦ AI 각주"}
                  </button>
                  {tb("직접 각주", () => addFootnote(false), false, "선택한 단어(또는 커서 위치)에 각주를 달고 내용을 직접 입력합니다")}
                  {tb(fnBusy === "auto" ? "찾는 중…" : "자동 각주", autoFootnote, false, "AI가 이 절의 중요 키워드를 골라 각주를 답니다")}
                </ToolGroup>
                <FindPanel editor={editor} />
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
                alert(er.message);
              }
            }}
          />
        </div>

        {/* 알림 줄 */}
        {((streaming && !live) || notice || lengthHint) && (
          <div className="space-y-1 border-b border-stone-200 bg-amber-50 px-4 py-2 text-sm">
            {streaming && !live && (
              <div className="flex items-center gap-2 text-amber-900">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-amber-700 border-t-transparent" />
                {streaming} <span className="text-xs text-amber-700">· {counts.chars.toLocaleString()}자 · Esc로 중지</span>
              </div>
            )}
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
                  onClick={() => runStream(`/api/sections/${section.id}/adjust`, { targetChars: lengthHint.target }, "adjust")}
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
        {streaming && live && (
          <WritingOverlay status={streaming} text={live.text} chars={live.chars} target={live.target} step={batchStep} onStop={() => abortRef.current?.abort()} />
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
                className={`book-editor relative ${streaming ? "streaming-caret" : ""}`}
                style={{ "--body-pt": `${bodySizePt}pt`, "--body-lh": lineHeight, "--para-gap": `${paraSpacingMm}mm` } as React.CSSProperties}
              >
                <EditorContent editor={editor} />
              </div>
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
              {candidate !== null && (
                <div className="rounded-lg border border-violet-200 bg-violet-50 p-2">
                  <div className="mb-1 flex items-center justify-between text-xs font-semibold text-violet-800">
                    새 버전 후보 {streaming && "(작성 중…)"}
                    <span className="font-normal">{candidate.length.toLocaleString()}자</span>
                  </div>
                  <div className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-white p-2 font-book text-[12px] leading-5">{candidate}</div>
                  {!streaming && (
                    <div className="mt-2 flex gap-2">
                      <button className="btn-primary px-2 py-1 text-xs" onClick={acceptCandidate}>
                        이 버전 사용
                      </button>
                      <button className="btn px-2 py-1 text-xs" onClick={() => setCandidate(null)}>
                        버리기
                      </button>
                    </div>
                  )}
                </div>
              )}
              <div>
                <label className="label">이번 집필에만 적용할 추가 지시</label>
                <textarea
                  className="input min-h-[88px] text-xs"
                  placeholder="예: 사례를 교육 현장 위주로, 마지막은 질문으로 끝내기"
                  value={extra}
                  onChange={(e) => setExtra(e.target.value)}
                />
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

      {batchOpen && (
        <BatchWriteDialog
          sections={allSections}
          currentId={section.id}
          currentSketch={sketch}
          currentPages={targetPages}
          cpp={cpp}
          onClose={() => setBatchOpen(false)}
          onStart={runBatch}
        />
      )}

      {/* 드래그 선택 → 각주 말풍선 */}
      {bubble && !fnEdit && !streaming && (
        <div
          data-fn-ui
          className="fixed z-40 flex items-center gap-0.5 rounded-lg border border-stone-200 bg-white p-0.5 font-sans shadow-lg"
          style={{ left: Math.max(8, bubble.x - 8), top: Math.max(8, bubble.y - 40) }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <button className="rounded-md px-2 py-1 text-xs font-semibold text-amber-800 hover:bg-amber-50 disabled:opacity-50" disabled={!!fnBusy} onClick={() => addFootnote(true)}>
            {fnBusy === "one" ? "각주 쓰는 중…" : "✦ AI 각주"}
          </button>
          <button className="rounded-md px-2 py-1 text-xs text-stone-600 hover:bg-stone-100 disabled:opacity-50" disabled={!!fnBusy} onClick={() => addFootnote(false)}>
            직접 각주
          </button>
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

function FootnotePopover(props: {
  x: number;
  y: number;
  number: number;
  attrs: FootnoteAttrs;
  busy: boolean;
  onChange: (v: string) => void;
  onRegen: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { attrs } = props;
  const left = Math.min(Math.max(8, props.x - 150), (typeof window !== "undefined" ? window.innerWidth : 1200) - 330);
  const top = Math.min(props.y + 8, (typeof window !== "undefined" ? window.innerHeight : 800) - 230);
  return (
    <div data-fn-ui className="fixed z-50 w-80 rounded-lg border border-stone-200 bg-white p-3 font-sans shadow-2xl" style={{ left, top }}>
      <div className="mb-1.5 flex items-center gap-1.5 text-xs">
        <b className={attrs.auto ? "text-violet-700" : "text-amber-700"}>각주 {props.number > 0 ? props.number : ""})</b>
        <span className="min-w-0 flex-1 truncate text-stone-600">{attrs.term}</span>
        {attrs.auto && <span className="rounded bg-violet-100 px-1 text-[10px] text-violet-700">AI</span>}
        <button className="px-1 text-stone-400 hover:text-stone-700" onClick={props.onClose} title="닫기 (Esc)">
          ✕
        </button>
      </div>
      <textarea
        autoFocus={!attrs.note}
        className="input min-h-[84px] resize-y p-2 text-xs leading-5"
        placeholder="각주 내용을 입력하세요 (쪽 아래에 인쇄됩니다)"
        value={attrs.note}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") props.onClose();
        }}
      />
      <div className="mt-2 flex items-center gap-2 text-xs">
        <button className="btn px-2 py-1 text-xs" disabled={props.busy} onClick={props.onRegen}>
          {props.busy ? "쓰는 중…" : attrs.note ? "✦ AI로 다시 쓰기" : "✦ AI로 쓰기"}
        </button>
        <button className="ml-auto text-red-600 hover:underline" onClick={props.onDelete}>
          각주 삭제
        </button>
      </div>
    </div>
  );
}

/** 도구줄 기능 묶음 — 왼쪽 색 이름표 + 칸막이로 나눈 버튼들 */
function ToolGroup({ label, tone, title, children }: { label: string; tone: string; title?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-stretch overflow-hidden rounded-md border border-stone-300 bg-white shadow-sm" title={title}>
      <span className={`flex items-center px-1.5 text-[11px] font-semibold tracking-tight text-white ${tone}`}>{label}</span>
      <div className="flex items-center divide-x divide-stone-200">{children}</div>
    </div>
  );
}
