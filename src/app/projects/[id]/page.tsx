"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Paginator from "@/components/Paginator";
import TocPanel from "@/components/TocPanel";
import SectionEditor from "@/components/editor/SectionEditor";
import type { SaveState } from "@/components/editor/useAutosave";
import { flushAllPending } from "@/components/editor/useAutosave";
import { stopBatch, stopJob, useAiJobs } from "@/components/editor/aiJobs";
import { useProofJobs } from "@/components/editor/proofJobs";
import type { PagedInfo, ProjectTree, SectionPageInfo, TreeSection } from "@/components/types";
import { api, fmtTime } from "@/lib/client";
import { toast, toastError } from "@/components/ui/feedback";
import { numberChapters } from "@/lib/layout";

// 열 때만 필요한 화면은 따로 불러온다 (편집 화면 첫 로딩을 가볍게)
const BookSearchDialog = dynamic(() => import("@/components/BookSearchDialog"));
const ChecksDialog = dynamic(() => import("@/components/ChecksDialog"));
const ExportDialog = dynamic(() => import("@/components/ExportDialog"));
const PreviewPane = dynamic(() => import("@/components/PreviewPane"));

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
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
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

  const load = useCallback(async () => {
    try {
      const t = await api<ProjectTree>(`/api/projects/${id}`);
      setTree(t);
      cppRef.current = t.charsPerPage;
      return t;
    } catch (e: any) {
      setErr(e.message);
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
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "ArrowDown") {
        e.preventDefault();
        if (nextEmpty) setCurrent(nextEmpty.s.id);
        else toast("아직 쓰지 않은 절이 없습니다.");
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        go(e.key === "ArrowUp" ? -1 : 1);
      }
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
    setTree((t) =>
      t ? { ...t, chapters: t.chapters.map((c) => ({ ...c, sections: c.sections.map((s) => (s.id === sid ? { ...s, ...patch } : s)) })) } : t,
    );
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
  const onSaved = useCallback((sid: string, chars: number) => {
    staleRef.current = true;
    const measured = infoRef.current?.sections[sid]?.chars;
    if (measured === undefined) setMeasureKey((k) => k + 1);
    else if (Math.abs(chars - measured) > Math.max(150, measured * 0.03)) setSectionMeasure({ sid, n: Date.now() });
  }, []);
  const onSectionInfo = useCallback((sid: string, m: SectionPageInfo) => setInfo((i) => (i ? shiftSection(i, sid, m) : i)), []);
  useEffect(() => {
    if (!staleRef.current) return;
    staleRef.current = false;
    setMeasureKey((k) => k + 1);
  }, [current]);
  const onSaveState = useCallback((s: SaveState) => setSave(s), []);

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

  // AI 집필은 편집기 밖에서 돈다 — 끝나면(작업 수가 줄면) 목차 상태·글자 수를 새로 받는다
  const jobs = useAiJobs();
  const running = jobs.filter((j) => j.state === "running");
  const proofing = useProofJobs().filter((j) => j.state === "running");
  const runningCount = useRef(0);
  const busyCount = running.length + proofing.length;
  useEffect(() => {
    if (busyCount < runningCount.current) {
      load();
      setMeasureKey((k) => k + 1);
    }
    runningCount.current = busyCount;
  }, [busyCount, load]);

  const gotoText = useCallback((sid: string, paragraph: number, text: string) => {
    setView("edit");
    setCurrent(sid);
    setLocate({ sid, paragraph, text, nonce: Date.now() });
  }, []);

  if (err) return <div className="p-10 text-red-600">{err}</div>;
  if (!tree) return <div className="p-10 text-stone-400">불러오는 중…</div>;

  const saveLabel =
    save.kind === "saving"
      ? "저장 중…"
      : save.kind === "saved"
        ? `저장됨 ${fmtTime(save.at!)}`
        : save.kind === "dirty"
          ? "입력 중…"
          : save.kind === "offline"
            ? "오프라인 — 브라우저에 보관 중"
            : save.kind === "error"
              ? `저장 실패 — ${save.msg ?? "재시도합니다"}`
              : "";

  return (
    <div className="flex h-screen flex-col">
      {/* 상단 바 */}
      <header className="menubar-dark flex items-center gap-3 border-b border-stone-900 bg-stone-800 px-3 py-2 text-stone-100">
        <Link href="/projects" className="btn-ghost" title="프로젝트 목록">
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
            <button className="btn-ghost px-1.5" disabled={idx <= 0} onClick={() => go(-1)} title="이전 절 (Ctrl+↑)">
              ◀
            </button>
            <button className="btn-ghost px-1.5" disabled={idx < 0 || idx >= flat.length - 1} onClick={() => go(1)} title="다음 절 (Ctrl+↓)">
              ▶
            </button>
            <button
              className="btn-ghost whitespace-nowrap px-1.5 text-xs"
              disabled={!nextEmpty}
              onClick={() => nextEmpty && setCurrent(nextEmpty.s.id)}
              title={nextEmpty ? `아직 본문이 없는 다음 절: ${nextEmpty.s.label} ${nextEmpty.s.title} (Ctrl+Shift+↓)` : "모든 절에 본문이 있습니다"}
            >
              ⇥ 다음 빈 절
            </button>
          </div>
        </div>
        {running.map((j) => (
          <span key={j.sectionId} className="flex items-center gap-1.5 rounded-md bg-amber-600/20 px-2 py-1 text-xs text-amber-100" title={j.status}>
            <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-amber-300 border-t-transparent" />
            <button className="max-w-40 truncate hover:underline" onClick={() => setCurrent(j.sectionId)} title="이 절로 가기">
              AI 집필 {j.batch ? `${j.batch.i}/${j.batch.n} ` : ""}· {j.label}
            </button>
            <span className="text-amber-300">{j.chars ? `${j.chars.toLocaleString()}자` : "구상 중"}</span>
            <button
              className="ml-0.5 text-amber-200 hover:text-white"
              aria-label="집필 중지"
              title="중지 (쓴 데까지 저장)"
              onClick={() => {
                if (j.batch) stopBatch();
                stopJob(j.sectionId);
              }}
            >
              ■
            </button>
          </span>
        ))}
        {proofing.map((j) => (
          <span key={j.sectionId} className="flex items-center gap-1.5 rounded-md bg-sky-600/20 px-2 py-1 text-xs text-sky-100" title="교정 중 — 다른 절로 옮겨도 계속됩니다">
            <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-sky-300 border-t-transparent" />
            <button className="max-w-40 truncate hover:underline" onClick={() => setCurrent(j.sectionId)} title="이 절로 가기">
              교정 · {j.label}
            </button>
          </span>
        ))}
        <span className={`text-xs ${save.kind === "error" || save.kind === "offline" ? "text-red-300" : "text-stone-400"}`}>{saveLabel}</span>
        <div className="flex overflow-hidden rounded-md border border-stone-500 text-sm">
          <button className={`px-3 py-1 ${view === "edit" ? "bg-amber-600 text-white" : "bg-stone-700 text-stone-200 hover:bg-stone-600"}`} onClick={() => setView("edit")}>
            편집
          </button>
          <button
            className={`px-3 py-1 ${view === "preview" ? "bg-amber-600 text-white" : "bg-stone-700 text-stone-200 hover:bg-stone-600"}`}
            onClick={async () => {
              if (!await flushAllPending()) return toast.error("저장을 완료하지 못했습니다. 연결을 확인하고 다시 시도하세요.");
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
        <button className="btn" onClick={async () => {
          if (!await flushAllPending()) return toast.error("저장을 완료하지 못했습니다. 연결을 확인하고 다시 시도하세요.");
          setExportOpen(true);
        }}>
          내보내기
        </button>
        <Link className="btn" href={`/projects/${id}/settings`}>
          책 설정
        </Link>
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
          onReload={async () => {
            await load();
            setMeasureKey((k) => k + 1);
          }}
          collapsed={tocCollapsed}
          onToggleCollapse={() => setTocCollapsed((c) => !c)}
          writing={running.map((j) => j.sectionId)}
        />
        {view === "preview" ? (
          <PreviewPane projectId={id} focus={current} reloadKey={previewKey} onInfo={onInfo} />
        ) : cur ? (
          <SectionEditor
            key={`${cur.s.id}:${editorNonce}`}
            locate={locate?.sid === cur.s.id ? locate : null}
            onServerEdited={() => onServerEdited()}
            onBookSearch={(q) => setDialog({ kind: "search", q })}
            project={tree}
            chapter={cur.c}
            section={cur.s}
            pageInfo={info?.sections[cur.s.id]}
            onMeta={(p) => patchSection(cur.s.id, p)}
            onSaved={onSaved}
            onSaveState={onSaveState}
            allSections={flat.map(({ c, s }) => ({ id: s.id, title: s.title, label: s.label, chapterTitle: c.title, targetPages: s.targetPages, charCount: s.charCount, gist: s.gist }))}
            onTreeChanged={() => {
              load();
              setMeasureKey((k) => k + 1);
            }}
            onLayout={(patch) => {
              setTree((t) => (t ? { ...t, layout: { ...t.layout, ...patch } } : t));
              api(`/api/projects/${id}`, { method: "PATCH", json: { layout: patch } })
                .then(() => setMeasureKey((k) => k + 1))
                .catch((e) => toastError(e, "조판 설정 저장 실패: "));
            }}
            onRename={(title) => onOp({ op: "renameSection", sectionId: cur.s.id, title })}
            onRenameChapter={(title) => onOp({ op: "renameChapter", chapterId: cur.c.id, title })}
            onTargetPages={(n) => {
              if (n !== cur.s.targetPages) {
                patchSection(cur.s.id, { targetPages: n });
                api(`/api/projects/${id}/toc`, { method: "PATCH", json: { op: "updateSection", sectionId: cur.s.id, targetPages: n } }).catch(() => {});
              }
            }}
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
      {view === "edit" && <Paginator projectId={id} trigger={measureKey} section={sectionMeasure} onInfo={onInfo} onSection={onSectionInfo} />}
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
      {exportOpen && <ExportDialog projectId={id} title={tree.title} chapterId={cur?.c.id} sectionId={cur?.s.id} onClose={() => setExportOpen(false)} />}
    </div>
  );
}

/**
 * 절 하나를 다시 잰 결과를 책 전체 측정값에 합친다 — 그 절이 차지하는 쪽 수가 달라진 만큼 뒤 절·장의 쪽을 민다.
 * (오른쪽 시작 장의 빈 쪽 변화는 다음 전체 측정에서 맞춘다)
 */
function shiftSection(info: PagedInfo, sid: string, m: SectionPageInfo): PagedInfo {
  const old = info.sections[sid];
  if (!old) return info;
  const span = (x: SectionPageInfo) => x.endIdx - x.startIdx + 1;
  const d = span(m) - span(old);
  const sections: PagedInfo["sections"] = {};
  for (const [k, s] of Object.entries(info.sections)) {
    if (k === sid) {
      sections[k] = { ...old, pages: m.pages, chars: m.chars, fig: m.fig, endIdx: old.startIdx + span(m) - 1, end: old.start > 0 ? old.start + span(m) - 1 : old.end };
    } else if (d && s.startIdx > old.startIdx) {
      sections[k] = { ...s, startIdx: s.startIdx + d, endIdx: s.endIdx + d, start: s.start > 0 ? s.start + d : s.start, end: s.end > 0 ? s.end + d : s.end, side: (s.startIdx + d) % 2 === 1 ? "right" : "left" };
    } else sections[k] = s;
  }
  const chapters: PagedInfo["chapters"] = {};
  for (const [k, c] of Object.entries(info.chapters)) chapters[k] = d && old.start > 0 && c.start > old.start ? { start: c.start + d } : c;
  return { ...info, total: info.total + d, sections, chapters };
}

const SHORTCUTS: [string, string][] = [
  ["Ctrl+S", "지금 저장"],
  ["Ctrl+↑ / Ctrl+↓", "이전 / 다음 절"],
  ["Ctrl+Shift+↓", "아직 본문이 없는 다음 절"],
  ["Esc", "AI 집필 중지 (쓴 데까지 넣음) · 창 닫기"],
  ["Enter / Shift+Enter", "찾기 칸에서 다음 / 이전 결과"],
  ["Ctrl+Z / Ctrl+Y", "실행 취소 / 다시 실행"],
  ["F2", "목차에서 고른 절 이름 바꾸기"],
  ["Space + 화살표", "목차에서 ⋮⋮에 초점을 두고 순서 바꾸기"],
  ["?", "이 목록 열기·닫기"],
];

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
