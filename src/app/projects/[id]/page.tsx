"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ExportDialog from "@/components/ExportDialog";
import Paginator from "@/components/Paginator";
import PreviewPane from "@/components/PreviewPane";
import TocPanel from "@/components/TocPanel";
import SectionEditor from "@/components/editor/SectionEditor";
import type { SaveState } from "@/components/editor/useAutosave";
import { flushAllPending } from "@/components/editor/useAutosave";
import type { PagedInfo, ProjectTree, TreeSection } from "@/components/types";
import { api, fmtTime } from "@/lib/client";
import { chapterLabel, sectionLabel } from "@/lib/layout";

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
    const order = { front: 0, body: 1, back: 2 } as const;
    const sorted = [...tree.chapters].sort((a, b) => order[a.kind] - order[b.kind] || a.order - b.order);
    let n = 0;
    return sorted.map((c) => {
      const no = c.kind === "body" ? ++n : 0;
      return {
        ...c,
        label: no ? chapterLabel(tree.layout.numberFormat, no) : "",
        sections: c.sections.map((s, i) => ({ ...s, label: no ? sectionLabel(tree.layout.numberFormat, no, i + 1) : "" })),
      };
    });
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

  const onSaved = useCallback(() => setMeasureKey((k) => k + 1), []);
  const onSaveState = useCallback((s: SaveState) => setSave(s), []);

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
          onSelect={(sid) => {
            setCurrent(sid);
            if (view === "preview") setPreviewKey((k) => k + 1);
          }}
          onOp={onOp}
        />
        {view === "preview" ? (
          <PreviewPane projectId={id} focus={current} reloadKey={previewKey} onInfo={onInfo} />
        ) : cur ? (
          <SectionEditor
            key={cur.s.id}
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
      {exportOpen && <ExportDialog projectId={id} title={tree.title} chapterId={cur?.c.id} sectionId={cur?.s.id} onClose={() => setExportOpen(false)} />}
    </div>
  );
}
