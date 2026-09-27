"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Paginator from "@/components/Paginator";
import TocPanel from "@/components/TocPanel";
import SectionEditor, { stopWriting } from "@/components/editor/SectionEditor";
import { flushAllPending, unsavedLabels, useSaveSummary } from "@/components/editor/useAutosave";
import { useAiJobs, useRunningIds } from "@/components/editor/aiJobs";
import { stopProof, useProofJobs, useProofRunningIds } from "@/components/editor/proofJobs";
import type { LayoutSettings } from "@/lib/layout";
import type { PagedInfo, ProjectTree, SectionPageInfo, TreeSection } from "@/components/types";
import { api, fmtTime } from "@/lib/client";
import { toast, toastError } from "@/components/ui/feedback";
import { numberChapters } from "@/lib/layout";
import { shiftSection } from "@/lib/page-shift";
import { mergePrintLayouts, type SectionPrintLayout } from "@/components/editor/pageMap";
import { KEYS, SHORTCUTS, sectionNavKey } from "@/components/editor/shortcuts";

// 열 때만 필요한 화면은 따로 불러온다 (편집 화면 첫 로딩을 가볍게)
const BookSearchDialog = dynamic(() => import("@/components/BookSearchDialog"));
const ChecksDialog = dynamic(() => import("@/components/ChecksDialog"));
const ExportDialog = dynamic(() => import("@/components/ExportDialog"));
const PreviewPane = dynamic(() => import("@/components/PreviewPane"));
const AutoWritePanel = dynamic(() => import("@/components/editor/AutoWritePanel"));

export default function Workspace() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const sp = useSearchParams();
  const [tree, setTree] = useState<ProjectTree | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [view, setView] = useState<"edit" | "preview">("edit");
  const [info, setInfo] = useState<PagedInfo | null>(null);
  const [measureKey, setMeasureKey] = useState(0);
  const [previewKey, setPreviewKey] = useState(0);
  const [exportOpen, setExportOpen] = useState(false);
  const [dialog, setDialog] = useState<null | { kind: "search"; q: string } | { kind: "checks" }>(null);
  const [checkCount, setCheckCount] = useState<number | null>(null);
  // 목차 접기 — 좁은 화면(1400px 미만)은 처음부터 접는다, 선택은 기억한다
  const [tocCollapsed, setTocCollapsed] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  useEffect(() => {
    try {
      const v = localStorage.getItem("bookk-toc-collapsed");
      setTocCollapsed(v ? v === "1" : window.innerWidth < 1400);
    } catch {}
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem("bookk-toc-collapsed", tocCollapsed ? "1" : "0");
    } catch {}
  }, [tocCollapsed]);
  // 서버에서 원고를 고치면(바꾸기·확인 표시·장 퇴고) 편집 화면을 다시 불러온다
  const [editorNonce, setEditorNonce] = useState(0);
  const [locate, setLocate] = useState<{ sid: string; paragraph: number; text: string; nonce: number } | null>(null);
  const [err, setErr] = useState("");
  const cppRef = useRef(700);

  // 목차 다시 읽기가 겹치면(저장·AI 완료·삭제가 잇따를 때) 늦게 도착한 옛 응답이 새 목차를 덮지 않게 마지막 요청만 쓴다
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const t = await api<ProjectTree>(`/api/projects/${id}`);
      if (seq !== loadSeq.current) return t;
      setTree(t);
      cppRef.current = t.charsPerPage;
      return t;
    } catch (e: any) {
      if (seq === loadSeq.current) setErr(e.message);
      return null;
    }
  }, [id]);

  useEffect(() => {
    load().then((t) => {
      if (!t) return;
      const all = t.chapters.flatMap((c) => c.sections.map((s) => s.id));
      let want = sp.get("s");
      try {
        want = want ?? localStorage.getItem(`bookk-last:${id}`);
      } catch {}
      setCurrent(want && all.includes(want) ? want : (all[0] ?? null));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (!current) return;
    try {
      localStorage.setItem(`bookk-last:${id}`, current);
      const url = new URL(window.location.href);
      url.searchParams.set("s", current);
      window.history.replaceState(window.history.state, "", url);
    } catch {}
  }, [current, id]);

  /* 번호 매기기 (앞붙이 → 본문 → 뒷붙이) */
  const chapters = useMemo(() => {
    if (!tree) return [];
    return numberChapters(tree.chapters, tree.layout.numberFormat);
  }, [tree]);

  const flat = useMemo(() => chapters.flatMap((c) => c.sections.map((s) => ({ c, s }))), [chapters]);
  const idx = flat.findIndex((f) => f.s.id === current);
  const cur = idx >= 0 ? flat[idx] : null;

  const go = useCallback((d: number) => {
    const n = flat[idx + d];
    if (n) setCurrent(n.s.id);
  }, [flat, idx]);

  /** 다음(없으면 처음부터) 아직 본문이 없는 절 — 비어 있거나 스케치만 있는 절 */
  const nextEmpty = useMemo(() => {
    const todo = (f: (typeof flat)[number]) => f.s.status === "empty" || f.s.status === "sketch";
    return flat.slice(idx + 1).find(todo) ?? flat.slice(0, Math.max(0, idx)).find(todo) ?? null;
  }, [flat, idx]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ? — 단축키 목록 (글을 쓰는 중이 아닐 때)
      const t = e.target as HTMLElement | null;
      if (e.key === "?" && !t?.closest("input, textarea, select, [contenteditable='true']")) {
        e.preventDefault();
        setKeysOpen((o) => !o);
        return;
      }
      if (e.key === "Escape") setKeysOpen(false);
      // Alt+↑/↓ 이전·다음 절, Alt+Shift+↓ 아직 본문이 없는 다음 절 (Ctrl+↑/↓는 글 안에서 문단 이동과 겹쳐 바꿨다)
      const nav = sectionNavKey(e);
      if (!nav) return;
      e.preventDefault();
      if (nav === "nextEmpty") {
        if (nextEmpty) setCurrent(nextEmpty.s.id);
        else toast("아직 쓰지 않은 절이 없습니다.");
        return;
      }
      go(nav === "prev" ? -1 : 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, nextEmpty]);

  const onOp = useCallback(
    async (body: Record<string, unknown>) => {
      try {
        const r = await api<{ id?: string }>(`/api/projects/${id}/toc`, { method: "PATCH", json: body });
        const t = await load();
        if (body.op === "addSection" && r.id) setCurrent(r.id);
        if (body.op === "addChapter" && r.id && t) {
          const c = t.chapters.find((x) => x.id === r.id);
          if (c?.sections[0]) setCurrent(c.sections[0].id);
        }
        if ((body.op === "deleteSection" || body.op === "deleteChapter") && t) {
          const all = t.chapters.flatMap((c) => c.sections.map((s) => s.id));
          if (!all.includes(current ?? "")) setCurrent(all[0] ?? null);
        }
        setMeasureKey((k) => k + 1);
      } catch (e: any) {
        toastError(e);
      }
    },
    [id, load, current],
  );

  const patchSection = useCallback((sid: string, patch: Partial<TreeSection>) => {
    setTree((t) => {
      if (!t) return t;
      // 바뀐 값이 없으면 목차를 새로 만들지 않는다 — 저장마다 목차·편집기가 다시 그려지지 않게 (updatedAt만 바뀐 저장은 무시)
      const cur = t.chapters.flatMap((c) => c.sections).find((s) => s.id === sid);
      const keys = (Object.keys(patch) as (keyof TreeSection)[]).filter((k) => k !== "updatedAt");
      if (!cur || keys.every((k) => cur[k] === patch[k])) return t;
      return { ...t, chapters: t.chapters.map((c) => ({ ...c, sections: c.sections.map((s) => (s.id === sid ? { ...s, ...patch } : s)) })) };
    });
  }, []);

  /* 조판 결과로 쪽 번호 갱신 + 1쪽당 글자 수 보정(이동 평균) */
  const onInfo = useCallback(
    (i: PagedInfo) => {
      setInfo(i);
      const secs = Object.values(i.sections).filter((s) => s.chars >= 500 && s.fig === 0 && s.pages > 0.3);
      const chars = secs.reduce((a, s) => a + s.chars, 0);
      const pages = secs.reduce((a, s) => a + s.pages, 0);
      if (chars >= 1500 && pages > 0) {
        const measured = chars / pages;
        const next = Math.round(cppRef.current * 0.7 + measured * 0.3);
        if (Math.abs(next - cppRef.current) / cppRef.current > 0.03) {
          cppRef.current = next;
          api(`/api/projects/${id}`, { method: "PATCH", json: { charsPerPage: next } }).catch(() => {});
          setTree((t) => (t ? { ...t, charsPerPage: next } : t));
        }
      }
    },
    [id],
  );

  /**
   * 저장마다 책 전체를 다시 조판하지 않는다.
   * 분량이 3%(최소 150자) 넘게 바뀌면 그 절 하나만 다시 재고 뒤 절들의 쪽 번호를 그만큼 민다(sectionMeasure).
   * 책 전체는 절을 옮길 때 한 번 다시 잰다(오른쪽 시작 장의 빈 쪽·차례 쪽수까지 정확히).
   */
  const staleRef = useRef(false);
  const infoRef = useRef<PagedInfo | null>(null);
  infoRef.current = info;
  const [sectionMeasure, setSectionMeasure] = useState<{ sid: string; n: number } | null>(null);
  const onSaved = useCallback((sid: string, chars: number, figures = 0) => {
    staleRef.current = true;
    const measured = infoRef.current?.sections[sid]?.chars;
    if (measured === undefined) setMeasureKey((k) => k + 1);
    // 그림이 있는 절은 저장할 때마다 다시 잰다 — 편집 화면이 그림을 미리보기와 같은 쪽에 두려면 지금 원고의 실제 조판이 필요하다
    else if (figures > 0 || Math.abs(chars - measured) > Math.max(150, measured * 0.03)) setSectionMeasure({ sid, n: Date.now() });
  }, []);
  /** 실제 조판에서 절마다 본문 블록(그림 포함)이 놓인 쪽 — 편집 화면 쪽 나눔이 따라간다 */
  const [printLayouts, setPrintLayouts] = useState<Record<string, SectionPrintLayout>>({});
  const onLayouts = useCallback((m: Record<string, SectionPrintLayout>) => setPrintLayouts((p) => mergePrintLayouts(p, m)), []);
  // 책 순서(앞붙이 → 본문 → 뒷붙이)의 장
  const orderRef = useRef<{ id: string; sectionIds: string[] }[]>([]);
  orderRef.current = chapters.map((c) => ({ id: c.id, sectionIds: c.sections.map((s) => s.id) }));
  const treeRef = useRef<ProjectTree | null>(null);
  treeRef.current = tree;
  const onSectionInfo = useCallback((sid: string, m: SectionPageInfo) => {
    const cur = infoRef.current;
    const t = treeRef.current;
    if (!cur || !t) return;
    const next = shiftSection(cur, sid, m, {
      startRight: t.layout.chapterStartRight,
      chapters: orderRef.current,
    });
    // 오른쪽 시작 장의 빈 쪽이 달라져 여기서 맞출 수 없다 → 책 전체를 다시 잰다
    if (!next) setMeasureKey((k) => k + 1);
    else if (next !== cur) {
      infoRef.current = next;
      setInfo(next);
    }
  }, []);
  useEffect(() => {
    if (!staleRef.current) return;
    staleRef.current = false;
    setMeasureKey((k) => k + 1);
  }, [current]);

  /**
   * 책의 실제 조판 쪽수 기록 — 목차에 보이는 쪽수(전체 조판·절 하나만 다시 잰 값 모두)가 바뀔 때마다 보낸다.
   * 책 선택 화면·표지 책등이 이 값을 쓴다. 절을 고치는 동안 잇달아 바뀌므로 잠시 멈춘 뒤 한 번만.
   */
  const postedTotal = useRef<number | null>(null);
  const total = info?.total;
  useEffect(() => {
    if (!total || !Number.isFinite(total) || total === postedTotal.current) return;
    const t = setTimeout(() => {
      postedTotal.current = total;
      api(`/api/projects/${id}/page-count`, { method: "POST", json: { total } }).catch(() => (postedTotal.current = null));
    }, 1500);
    return () => clearTimeout(t);
  }, [id, total]);

  useEffect(() => {
    api<{ total: number }>(`/api/projects/${id}/checks`).then((r) => setCheckCount(r.total)).catch(() => {});
  }, [id]);

  /** 서버에서 절 본문을 고친 뒤 — 목차 글자 수·쪽 번호를 새로 받고, 여는 절이 바뀌었으면 다시 불러온다 */
  const onServerEdited = useCallback(
    (sectionIds?: string[]) => {
      load();
      setMeasureKey((k) => k + 1);
      if (!sectionIds || (current && sectionIds.includes(current))) setEditorNonce((n) => n + 1);
    },
    [load, current],
  );

  // AI 집필은 편집기 밖에서 돈다 — 끝나면(작업 수가 줄면) 목차 상태·글자 수를 새로 받는다.
  // 쓰는 중 글자 수(250ms마다)는 JobChips만 다시 그린다 — 여기서는 어느 절이 돌고 있는지만 본다
  const runningIds = useRunningIds();
  const proofIds = useProofRunningIds();
  const writingIds = useMemo(() => (runningIds ? runningIds.split(",") : []), [runningIds]);
  const runningCount = useRef(0);
  const busyCount = writingIds.length + (proofIds ? proofIds.split(",").length : 0);
  useEffect(() => {
    if (busyCount < runningCount.current) {
      load();
      setMeasureKey((k) => k + 1);
    }
    runningCount.current = busyCount;
  }, [busyCount, load]);

  // 편집기에 넘기는 함수는 늘 같은 참조로 — SectionEditor(memo)가 목차·저장 표시가 바뀔 때마다 다시 그려지지 않게. 지금 절은 ref로 읽는다
  const curRef = useRef(cur);
  curRef.current = cur;
  // 그림 번호는 장마다 이어서 센다 — 이 절 앞 절들의 그림 수 (조판 결과에서)
  const figureBase = useMemo(() => {
    if (!cur || !info) return 0;
    let n = 0;
    for (const s of cur.c.sections) {
      if (s.id === cur.s.id) break;
      n += info.sections[s.id]?.fig ?? 0;
    }
    return n;
  }, [cur, info]);
  const editorServerEdited = useCallback(() => onServerEdited(), [onServerEdited]);
  const onBookSearch = useCallback((q: string) => setDialog({ kind: "search", q }), []);
  const onMeta = useCallback((p: Partial<TreeSection>) => curRef.current && patchSection(curRef.current.s.id, p), [patchSection]);
  const onLayout = useCallback(
    (patch: Partial<LayoutSettings>) => {
      setTree((t) => (t ? { ...t, layout: { ...t.layout, ...patch } } : t));
      api(`/api/projects/${id}`, { method: "PATCH", json: { layout: patch } })
        .then(() => setMeasureKey((k) => k + 1))
        .catch((e) => toastError(e, "조판 설정 저장 실패: "));
    },
    [id],
  );
  const onOpRef = useRef(onOp);
  onOpRef.current = onOp;
  const onRename = useCallback((title: string) => curRef.current && onOpRef.current({ op: "renameSection", sectionId: curRef.current.s.id, title }), []);
  const onRenameChapter = useCallback((title: string) => curRef.current && onOpRef.current({ op: "renameChapter", chapterId: curRef.current.c.id, title }), []);
  const onTargetPages = useCallback(
    (n: number) => {
      const c = curRef.current;
      if (!c || n === c.s.targetPages) return;
      patchSection(c.s.id, { targetPages: n });
      api(`/api/projects/${id}/toc`, { method: "PATCH", json: { op: "updateSection", sectionId: c.s.id, targetPages: n } }).catch((e) => toastError(e, "분량 저장 실패: "));
    },
    [id, patchSection],
  );
  const onTocReload = useCallback(async () => {
    await load();
    setMeasureKey((k) => k + 1);
  }, [load]);
  const onToggleToc = useCallback(() => setTocCollapsed((c) => !c), []);
  /** 저장을 모두 마친 뒤에 — 못 한 절이 있으면 이름을 알린다 */
  const flushOrWarn = useCallback(async () => {
    if (await flushAllPending()) return true;
    const names = unsavedLabels();
    toast.error(`저장을 완료하지 못했습니다${names.length ? `: ${names.join(", ")}` : ""}. 연결을 확인하고 다시 시도하세요.`);
    return false;
  }, []);

  const gotoText = useCallback((sid: string, paragraph: number, text: string) => {
    setView("edit");
    setCurrent(sid);
    setLocate({ sid, paragraph, text, nonce: Date.now() });
  }, []);

  if (err) return <div className="p-10 text-red-600">{err}</div>;
  if (!tree) return <div className="p-10 text-stone-400">불러오는 중…</div>;

  return (
    <div className="flex h-screen flex-col">
      {/* 상단 바 */}
      <header className="menubar-dark flex items-center gap-3 border-b border-stone-900 bg-stone-800 px-3 py-2 text-stone-100">
        <Link href="/projects" className="btn-ghost" title="책 목록" aria-label="책 목록">
          ≡
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 truncate text-sm">
            <span className="font-bookhead text-white">{tree.title}</span>
            {cur && (
              <>
                <span className="text-stone-500">›</span>
                <span className="truncate text-stone-300">
                  {cur.c.label} {cur.c.title}
                </span>
                <span className="text-stone-500">›</span>
                <span className="truncate font-semibold text-amber-200">
                  {cur.s.label} {cur.s.title}
                </span>
              </>
            )}
            <button className="btn-ghost px-1.5" disabled={idx <= 0} onClick={() => go(-1)} title={`이전 절 (${KEYS.prevSection})`} aria-label="이전 절">
              ◀
            </button>
            <button className="btn-ghost px-1.5" disabled={idx < 0 || idx >= flat.length - 1} onClick={() => go(1)} title={`다음 절 (${KEYS.nextSection})`} aria-label="다음 절">
              ▶
            </button>
            <button
              className="btn-ghost whitespace-nowrap px-1.5 text-xs"
              disabled={!nextEmpty}
              onClick={() => nextEmpty && setCurrent(nextEmpty.s.id)}
              title={nextEmpty ? `아직 본문이 없는 다음 절: ${nextEmpty.s.label} ${nextEmpty.s.title} (${KEYS.nextEmpty})` : "모든 절에 본문이 있습니다"}
            >
              ⇥ 다음 빈 절
            </button>
          </div>
        </div>
        <JobChips onGo={setCurrent} />
        <SaveIndicator onGo={setCurrent} />
        <div className="flex overflow-hidden rounded-md border border-stone-500 text-sm">
          <button className={`px-3 py-1 ${view === "edit" ? "bg-amber-600 text-white" : "bg-stone-700 text-stone-200 hover:bg-stone-600"}`} onClick={() => setView("edit")}>
            편집
          </button>
          <button
            className={`px-3 py-1 ${view === "preview" ? "bg-amber-600 text-white" : "bg-stone-700 text-stone-200 hover:bg-stone-600"}`}
            onClick={async () => {
              if (!(await flushOrWarn())) return;
              setPreviewKey((k) => k + 1);
              setView("preview");
            }}
          >
            펼침면 미리보기
          </button>
        </div>
        <button
          className={`btn ${checkCount ? "border-red-300 text-red-100" : ""}`}
          onClick={() => setDialog({ kind: "checks" })}
          title="AI가 남긴 [확인 필요]·[이미지 제안] 표시를 모아 처리합니다"
        >
          확인할 것{checkCount ? ` ${checkCount}` : ""}
        </button>
        <button
          className="btn"
          onClick={() => window.open(`/projects/${id}/cover`, `cover-${id}`)}
          title="표지(날개·책등 포함 펼침면)를 AI로 만들고 글을 얹어 인쇄용 PDF로 내보냅니다 — 새 창"
        >
          표지 디자인
        </button>
        <button className="btn" onClick={async () => {
          if (!(await flushOrWarn())) return;
          setExportOpen(true);
        }}>
          내보내기
        </button>
        <Link className="btn" href={`/projects/${id}/settings`}>
          책 설정
        </Link>
        <button className="btn-ghost px-2" onClick={() => setKeysOpen((o) => !o)} title={`단축키 목록 (${KEYS.help})`} aria-label="단축키 목록" aria-haspopup="dialog">
          ⌨
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <TocPanel
          projectId={id}
          chapters={chapters}
          current={current}
          cpp={tree.charsPerPage}
          info={info}
          targetPages={tree.targetPages}
          onSelect={setCurrent}
          onOp={onOp}
          onReload={onTocReload}
          collapsed={tocCollapsed}
          onToggleCollapse={onToggleToc}
          writing={writingIds}
        />
        {view === "preview" ? (
          <PreviewPane projectId={id} focus={current} reloadKey={previewKey} onInfo={onInfo} />
        ) : cur ? (
          <SectionEditor
            key={`${cur.s.id}:${editorNonce}`}
            locate={locate?.sid === cur.s.id ? locate : null}
            onServerEdited={editorServerEdited}
            onBookSearch={onBookSearch}
            project={tree}
            chapter={cur.c}
            section={cur.s}
            pageInfo={info?.sections[cur.s.id]}
            printLayout={printLayouts[cur.s.id]}
            figureBase={figureBase}
            onMeta={onMeta}
            onSaved={onSaved}
            onLayout={onLayout}
            onRename={onRename}
            onRenameChapter={onRenameChapter}
            onTargetPages={onTargetPages}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-stone-400">
            <div className="text-center">
              <p>왼쪽 목차에서 절을 선택하세요.</p>
              {!chapters.length && (
                <button className="btn-accent mt-4" onClick={() => router.push(`/projects/${id}/toc?auto=1`)}>
                  AI로 목차 설계하기
                </button>
              )}
            </div>
          </div>
        )}
      </div>
      {view === "edit" && <Paginator projectId={id} trigger={measureKey} section={sectionMeasure} onInfo={onInfo} onSection={onSectionInfo} onLayouts={onLayouts} />}
      {keysOpen && <ShortcutsDialog onClose={() => setKeysOpen(false)} />}
      {dialog?.kind === "search" && (
        <BookSearchDialog
          projectId={id}
          initialQuery={dialog.q}
          onClose={() => setDialog(null)}
          onGoto={(sid, p, t) => {
            setDialog(null);
            gotoText(sid, p, t);
          }}
          beforeEdit={flushAllPending}
          onEdited={onServerEdited}
        />
      )}
      {dialog?.kind === "checks" && (
        <ChecksDialog
          projectId={id}
          onClose={() => setDialog(null)}
          onGoto={(sid, p, t) => {
            setDialog(null);
            gotoText(sid, p, t);
          }}
          beforeEdit={flushAllPending}
          onEdited={onServerEdited}
          onCount={setCheckCount}
        />
      )}
      <AutoWritePanel
        projectId={id}
        onGoto={(sid) => {
          setView("edit");
          setCurrent(sid);
        }}
        onEdited={onServerEdited}
      />
      {exportOpen && <ExportDialog projectId={id} title={tree.title} chapterId={cur?.c.id} sectionId={cur?.s.id} onClose={() => setExportOpen(false)} onOpenChecks={() => setDialog({ kind: "checks" })} />}
    </div>
  );
}

/** 상단 작업 표시 — 쓰는 중 글자 수가 250ms마다 바뀌어도 이것만 다시 그린다 */
function JobChips({ onGo }: { onGo: (sid: string) => void }) {
  const running = useAiJobs().filter((j) => j.state === "running");
  const proofing = useProofJobs().filter((j) => j.state === "running");
  return (
    <>
      {running.map((j) => (
        <span key={j.sectionId} className="flex items-center gap-1.5 rounded-md bg-amber-600/20 px-2 py-1 text-xs text-amber-100" title={j.status}>
          <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-amber-300 border-t-transparent" />
          <button className="max-w-40 truncate hover:underline" onClick={() => onGo(j.sectionId)} title="이 절로 가기">
            AI 집필 {j.batch ? `${j.batch.i}/${j.batch.n} ` : ""}· {j.label}
          </button>
          <span className="text-amber-300">{j.chars ? `${j.chars.toLocaleString()}자` : "구상 중"}</span>
          <button
            className="ml-0.5 text-amber-200 hover:text-white"
            aria-label="집필 중지"
            title={j.auto ? "중지 (자동 집필이 일시 정지됩니다 · 쓴 데까지 저장)" : "중지 (쓴 데까지 저장)"}
            onClick={() => void stopWriting(j)}
          >
            ■
          </button>
        </span>
      ))}
      {proofing.map((j) => (
        <span key={j.sectionId} className="flex items-center gap-1.5 rounded-md bg-sky-600/20 px-2 py-1 text-xs text-sky-100" title="교정 중 — 다른 절로 옮겨도 계속됩니다">
          <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-sky-300 border-t-transparent" />
          <button className="max-w-40 truncate hover:underline" onClick={() => onGo(j.sectionId)} title="이 절로 가기">
            교정 · {j.label}
          </button>
          <button className="ml-0.5 text-sky-200 hover:text-white" aria-label="교정 중지" title="교정 중지 (고친 것은 넣지 않고 잠금을 풉니다)" onClick={() => stopProof(j.sectionId)}>
            ■
          </button>
        </span>
      ))}
    </>
  );
}

/** 상단 저장 표시 — 열려 있지 않은 절까지 모든 절의 저장 큐를 모아 본다. 실패·충돌한 절은 이름을 보여 주고 누르면 그 절로 간다 */
function SaveIndicator({ onGo }: { onGo: (sid: string) => void }) {
  const save = useSaveSummary();
  const f = save.failing[0];
  const more = save.failing.length > 1 ? ` 외 ${save.failing.length - 1}개 절` : "";
  if (f)
    return (
      <button className="max-w-72 truncate text-left text-xs text-red-300 hover:underline" onClick={() => onGo(f.id)} title={save.failing.map((x) => `${x.label}: ${x.msg ?? ""}`).join("\n")}>
        {f.kind === "conflict" ? `저장 충돌 — 「${f.label}」${more} (눌러서 고르기)` : f.kind === "offline" ? `오프라인 — 「${f.label}」${more} 브라우저에 보관 중` : `저장 실패 — 「${f.label}」${more}: ${f.msg ?? "재시도합니다"}`}
      </button>
    );
  const label = save.kind === "saving" ? "저장 중…" : save.kind === "saved" && save.at ? `저장됨 ${fmtTime(save.at)}` : save.kind === "dirty" ? "입력 중…" : "";
  return <span className="text-xs text-stone-400">{label}</span>;
}

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label="단축키" className="w-full max-w-sm rounded-xl bg-white p-5 shadow-2xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">단축키</h2>
          <button className="btn-ghost" aria-label="닫기" onClick={onClose}>
            ✕
          </button>
        </div>
        <dl className="space-y-1.5 text-sm">
          {SHORTCUTS.map(([k, v]) => (
            <div key={k} className="flex gap-3">
              <dt className="w-36 shrink-0">
                <kbd className="rounded border border-stone-300 bg-stone-50 px-1.5 py-0.5 font-mono text-xs">{k}</kbd>
              </dt>
              <dd className="text-stone-600">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
