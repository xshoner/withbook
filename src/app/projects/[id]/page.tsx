"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import BookSearchDialog from "@/components/BookSearchDialog";
import ChecksDialog from "@/components/ChecksDialog";
import ExportDialog from "@/components/ExportDialog";
import Paginator from "@/components/Paginator";
import PreviewPane from "@/components/PreviewPane";
import TocPanel from "@/components/TocPanel";
import SectionEditor from "@/components/editor/SectionEditor";
import type { SaveState } from "@/components/editor/useAutosave";
import { flushAllPending } from "@/components/editor/useAutosave";
import type { PagedInfo, ProjectTree, TreeSection } from "@/components/types";
import { api, fmtTime } from "@/lib/client";
import { numberChapters } from "@/lib/layout";

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        go(e.key === "ArrowUp" ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

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
        alert(e.message);
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
   * 저장마다 책 전체를 다시 조판하지 않는다 — 마지막 조판 때보다 분량이 3%(최소 150자) 넘게 바뀌었을 때만 다시 잰다.
   * 작은 변화는 절을 옮길 때 한 번에 반영한다.
   */
  const staleRef = useRef(false);
  const infoRef = useRef<PagedInfo | null>(null);
  infoRef.current = info;
  const onSaved = useCallback((sid: string, chars: number) => {
    const measured = infoRef.current?.sections[sid]?.chars;
    if (measured === undefined || Math.abs(chars - measured) > Math.max(150, measured * 0.03)) {
      staleRef.current = false;
      setMeasureKey((k) => k + 1);
    } else staleRef.current = true;
  }, []);
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
          </div>
        </div>
        <span className={`text-xs ${save.kind === "error" || save.kind === "offline" ? "text-red-300" : "text-stone-400"}`}>{saveLabel}</span>
        <div className="flex overflow-hidden rounded-md border border-stone-500 text-sm">
          <button className={`px-3 py-1 ${view === "edit" ? "bg-amber-600 text-white" : "bg-stone-700 text-stone-200 hover:bg-stone-600"}`} onClick={() => setView("edit")}>
            편집
          </button>
          <button
            className={`px-3 py-1 ${view === "preview" ? "bg-amber-600 text-white" : "bg-stone-700 text-stone-200 hover:bg-stone-600"}`}
            onClick={async () => {
              if (!await flushAllPending()) return alert("저장을 완료하지 못했습니다. 연결을 확인하고 다시 시도하세요.");
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
          if (!await flushAllPending()) return alert("저장을 완료하지 못했습니다. 연결을 확인하고 다시 시도하세요.");
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
                .catch((e) => alert("조판 설정 저장 실패: " + e.message));
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
      {view === "edit" && <Paginator projectId={id} trigger={measureKey} onInfo={onInfo} />}
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
