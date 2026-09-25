"use client";

import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { STATUS_LABEL, api } from "@/lib/client";
import { confirmDialog, toast, toastError } from "@/components/ui/feedback";
import TrashDialog from "./TrashDialog";
import type { PagedInfo, TreeChapter, TreeSection } from "./types";

type LabeledChapter = Omit<TreeChapter, "sections"> & { label: string; sections: (TreeSection & { label: string })[] };

type Props = {
  projectId: string;
  chapters: LabeledChapter[];
  current: string | null;
  cpp: number;
  info: PagedInfo | null;
  onSelect: (sid: string) => void;
  onOp: (body: Record<string, unknown>) => Promise<void>;
  targetPages: number;
  /** 목차 다시 읽기 (삭제·되돌리기 뒤). 없으면 onOp({op:"refresh"})로 대신한다 */
  onReload?: () => void | Promise<unknown>;
  /** 접힌 상태: 좁은 막대(w-10)에 펼치기 버튼만 */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  /** AI가 쓰고 있는 절 (목차에 표시) */
  writing?: string[];
};

/** 삭제·되돌리기 — 휴지통 id를 받아야 하므로 onOp 대신 직접 부른다 */
type Actions = {
  remove: (kind: "section" | "chapter", id: string, title: string, label: string) => Promise<void>;
};

type Filter = "all" | "empty" | "sketch" | "ai_draft" | "editing" | "proofread";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "전체" },
  { key: "empty", label: "비어 있음" },
  { key: "sketch", label: "스케치" },
  { key: "ai_draft", label: "AI 초안" },
  { key: "editing", label: "수정 중" },
  { key: "proofread", label: "교정 완료" },
];
const FILTER_KEY = "bookk-toc-filter";
const statusOf = (s: { status: string }) => (STATUS_LABEL[s.status] ? s.status : "empty");

/** 마우스를 올리거나 안쪽에 초점이 있을 때만 보이는 조작 버튼 */
const HOVER = "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100";

function Inline({
  value,
  onSave,
  className,
  edit,
  setEdit,
}: {
  value: string;
  onSave: (v: string) => void;
  className?: string;
  edit: boolean;
  setEdit: (v: boolean) => void;
}) {
  if (!edit)
    return (
      <span className={`block ${className ?? ""}`} onDoubleClick={() => setEdit(true)} title="더블클릭해서 이름 바꾸기">
        {value}
      </span>
    );
  return (
    <input
      autoFocus
      defaultValue={value}
      aria-label="이름"
      className="w-full rounded border border-amber-400 px-1 text-sm outline-none"
      onClick={(e) => e.stopPropagation()}
      onFocus={(e) => e.target.select()}
      onBlur={(e) => {
        setEdit(false);
        const v = e.target.value.trim();
        if (v && v !== value) onSave(v);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.nativeEvent.isComposing) (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setEdit(false);
      }}
    />
  );
}

/** ⋯ 메뉴: 바깥 클릭·Esc로 닫고, 닫으면 버튼으로 초점을 돌려준다 */
function useMenu() {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    box.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return { open, setOpen, box, trigger };
}

function SectionRow({
  s,
  active,
  range,
  chapters,
  chapterId,
  onSelect,
  onOp,
  actions,
  writing,
}: {
  s: TreeSection & { label: string };
  writing?: boolean;
  active: boolean;
  range?: { start: number; end: number };
  chapters: LabeledChapter[];
  chapterId: string;
  onSelect: () => void;
  onOp: Props["onOp"];
  actions: Actions;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: s.id });
  const menu = useMenu();
  const [renaming, setRenaming] = useState(false);
  const st = STATUS_LABEL[s.status] ?? STATUS_LABEL.empty;
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      className={`group relative flex cursor-pointer items-start gap-1 rounded-md py-1.5 pl-1 pr-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${active ? "bg-amber-50 text-stone-900 ring-1 ring-amber-400" : "hover:bg-stone-100"}`}
      tabIndex={0}
      aria-current={active ? "true" : undefined}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter") onSelect();
        if (e.key === "F2") setRenaming(true);
      }}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`「${s.title}」 순서 바꾸기 (스페이스로 집고 화살표로 옮긴 뒤 스페이스)`}
        className={`mt-0.5 cursor-grab rounded px-0.5 text-stone-300 ${HOVER}`}
        onClick={(e) => e.stopPropagation()}
        title="끌어서 순서 바꾸기"
      >
        ⋮⋮
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5" title={s.title}>
          {s.label && <span className="shrink-0 text-xs text-stone-400">{s.label}</span>}
          <Inline className="min-w-0 break-words" value={s.title} edit={renaming} setEdit={setRenaming} onSave={(title) => onOp({ op: "renameSection", sectionId: s.id, title })} />
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-stone-400">
          {writing ? (
            <span className="flex items-center gap-1 rounded bg-amber-100 px-1 text-amber-800" title="AI가 이 절을 쓰는 중입니다">
              <span className="h-2 w-2 animate-spin rounded-full border border-amber-700 border-t-transparent" />
              AI 집필 중
            </span>
          ) : (
            <span className={`rounded px-1 ${st.cls}`}>{st.label}</span>
          )}
          {range && range.start > 0 && (
            <span title="인쇄 쪽 번호">
              p.{range.start}
              {range.end !== range.start && `–${range.end}`}
            </span>
          )}
        </div>
      </div>
      <button
        type="button"
        ref={menu.trigger}
        aria-label={`「${s.title}」 메뉴`}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        className={`rounded px-1 text-stone-400 hover:bg-stone-200 ${menu.open ? "opacity-100" : HOVER}`}
        onClick={(e) => {
          e.stopPropagation();
          menu.setOpen(!menu.open);
        }}
      >
        ⋯
      </button>
      {menu.open && (
        <div
          ref={menu.box}
          role="menu"
          className="absolute right-0 top-8 z-20 w-44 rounded-md border border-stone-200 bg-white py-1 text-xs shadow-lg"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          onMouseLeave={() => menu.setOpen(false)}
        >
          <button
            role="menuitem"
            className="block w-full px-3 py-1.5 text-left hover:bg-stone-100 focus:bg-stone-100 focus:outline-none"
            onClick={() => {
              menu.setOpen(false);
              setRenaming(true);
            }}
          >
            이름 바꾸기
          </button>
          <button
            role="menuitem"
            className="block w-full px-3 py-1.5 text-left hover:bg-stone-100 focus:bg-stone-100 focus:outline-none"
            onClick={() => {
              menu.setOpen(false);
              onOp({ op: "addSection", chapterId, afterId: s.id, title: "새 절" });
            }}
          >
            아래에 절 추가
          </button>
          <div className="border-t border-stone-100 px-3 py-1 text-stone-400">다른 장으로 옮기기</div>
          {chapters
            .filter((c) => c.id !== chapterId)
            .map((c) => (
              <button
                key={c.id}
                role="menuitem"
                className="block w-full truncate px-4 py-1 text-left hover:bg-stone-100 focus:bg-stone-100 focus:outline-none"
                onClick={() => {
                  menu.setOpen(false);
                  onOp({ op: "moveSection", sectionId: s.id, toChapterId: c.id });
                }}
              >
                → {c.label || ""} {c.title}
              </button>
            ))}
          <button
            role="menuitem"
            className="mt-1 block w-full border-t border-stone-100 px-3 py-1.5 text-left text-red-600 hover:bg-red-50 focus:bg-red-50 focus:outline-none"
            onClick={async () => {
              menu.setOpen(false);
              const ok = await confirmDialog(
                s.charCount ? `「${s.title}」에 본문 ${s.charCount.toLocaleString()}자가 있습니다. 삭제할까요?\n(삭제한 장·절에서 30일 안에 되돌릴 수 있습니다)` : `「${s.title}」을(를) 삭제할까요?`,
                { danger: true, okLabel: "삭제" },
              );
              if (ok) actions.remove("section", s.id, s.title, s.label);
            }}
          >
            삭제
          </button>
        </div>
      )}
    </li>
  );
}

function ChapterBlock({ c, props, actions, filter }: { c: LabeledChapter; props: Props; actions: Actions; filter: Filter }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: c.id });
  const [open, setOpen] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const written = c.sections.reduce((s, x) => s + x.charCount, 0);
  const visible = filter === "all" ? c.sections : c.sections.filter((s) => statusOf(s) === filter);
  const dim = filter !== "all" && visible.length === 0;
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const ids = c.sections.map((s) => s.id);
    const next = arrayMove(ids, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id)));
    props.onOp({ op: "reorderSections", chapterId: c.id, ids: next });
  };
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : dim ? 0.45 : 1 }} className="mb-2">
      <div className="group flex items-center gap-1 rounded-md px-1 py-1 hover:bg-stone-100">
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`「${c.title}」 장 순서 바꾸기 (스페이스로 집고 화살표로 옮긴 뒤 스페이스)`}
          className={`cursor-grab rounded px-0.5 text-stone-300 ${HOVER}`}
          title="끌어서 장 순서 바꾸기"
        >
          ⋮⋮
        </button>
        <button type="button" className="w-4 text-xs text-stone-400" aria-expanded={open && !dim} aria-label={open ? "장 접기" : "장 펼치기"} onClick={() => setOpen(!open)}>
          {open && !dim ? "▾" : "▸"}
        </button>
        <div className="flex min-w-0 flex-1 items-baseline gap-1 font-bookhead text-[13px]" title={c.title}>
          {c.label && <span className="shrink-0 text-stone-500">{c.label}</span>}
          <Inline className="min-w-0 truncate" value={c.title} edit={renaming} setEdit={setRenaming} onSave={(title) => props.onOp({ op: "renameChapter", chapterId: c.id, title })} />
        </div>
        {props.info?.chapters[c.id]?.start ? <span className="text-[10px] text-stone-400">p.{props.info.chapters[c.id].start}</span> : null}
        <button type="button" className={`rounded px-1 text-xs text-stone-400 hover:bg-stone-200 ${HOVER}`} title="이름 바꾸기" aria-label={`「${c.title}」 이름 바꾸기`} onClick={() => setRenaming(true)}>
          ✎
        </button>
        <button
          type="button"
          className={`rounded px-1 text-xs text-stone-400 hover:bg-stone-200 ${HOVER}`}
          title="절 추가"
          aria-label={`「${c.title}」에 절 추가`}
          onClick={() => props.onOp({ op: "addSection", chapterId: c.id, title: "새 절" })}
        >
          +
        </button>
        <button
          type="button"
          className={`rounded px-1 text-xs text-stone-400 hover:bg-red-100 hover:text-red-600 ${HOVER}`}
          title="장 삭제"
          aria-label={`「${c.title}」 장 삭제`}
          onClick={async () => {
            const ok = await confirmDialog(
              written ? `「${c.title}」의 모든 절(본문 ${written.toLocaleString()}자)이 삭제됩니다. 계속할까요?\n(삭제한 장·절에서 30일 안에 되돌릴 수 있습니다)` : `「${c.title}」을(를) 삭제할까요?`,
              { danger: true, okLabel: "삭제" },
            );
            if (ok) actions.remove("chapter", c.id, c.title, c.label);
          }}
        >
          ✕
        </button>
      </div>
      {open && !dim && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={visible.map((s) => s.id)} strategy={verticalListSortingStrategy}>
            <ul className="ml-4 border-l border-stone-200 pl-1">
              {visible.map((s) => (
                <SectionRow
                  key={s.id}
                  s={s}
                  active={props.current === s.id}
                  range={props.info?.sections[s.id]}
                  chapters={props.chapters}
                  chapterId={c.id}
                  onSelect={() => props.onSelect(s.id)}
                  onOp={props.onOp}
                  actions={actions}
                  writing={props.writing?.includes(s.id)}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
}

export default function TocPanel(props: Props) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const [filter, setFilterState] = useState<Filter>("all");
  const [trashOpen, setTrashOpen] = useState(false);

  useEffect(() => {
    try {
      const v = localStorage.getItem(FILTER_KEY) as Filter | null;
      if (v && FILTERS.some((f) => f.key === v)) setFilterState(v);
    } catch {}
  }, []);
  const setFilter = (f: Filter) => {
    setFilterState(f);
    try {
      localStorage.setItem(FILTER_KEY, f);
    } catch {}
  };

  const reload = async () => {
    if (props.onReload) await props.onReload();
    else await props.onOp({ op: "refresh" });
  };

  const restore = async (trashId: string, title: string, kind: "section" | "chapter") => {
    try {
      const r = await api<{ versionsDropped?: boolean }>(`/api/projects/${props.projectId}/toc`, { method: "PATCH", json: { op: "restoreTrash", trashId } });
      await reload();
      if (kind === "section") props.onSelect(trashId);
      toast.success(`「${title}」을(를) 되돌렸습니다${r.versionsDropped ? " (용량이 커서 버전 기록은 보관하지 않았습니다)" : ""}`);
    } catch (e) {
      toastError(e, "되돌리지 못했습니다: ");
    }
  };

  const actions: Actions = {
    remove: async (kind, id, title, label) => {
      // 지우는 것 안에 지금 연 절이 있으면 옆 절로 옮긴다
      const flat = props.chapters.flatMap((c) => c.sections.map((s) => ({ cid: c.id, sid: s.id })));
      const gone = (x: { cid: string; sid: string }) => (kind === "chapter" ? x.cid === id : x.sid === id);
      const curIdx = flat.findIndex((x) => x.sid === props.current);
      const fallback = curIdx >= 0 && gone(flat[curIdx]) ? ([...flat.slice(curIdx + 1), ...flat.slice(0, curIdx).reverse()].find((x) => !gone(x))?.sid ?? null) : null;
      try {
        const body = kind === "chapter" ? { op: "deleteChapter", chapterId: id, label } : { op: "deleteSection", sectionId: id, label };
        const r = await api<{ trashId?: string }>(`/api/projects/${props.projectId}/toc`, { method: "PATCH", json: body });
        await reload();
        if (fallback) props.onSelect(fallback);
        const tid = r.trashId;
        toast(`「${title}」을(를) 삭제했습니다`, tid ? { action: { label: "되돌리기", run: () => restore(tid, title, kind) } } : undefined);
      } catch (e) {
        toastError(e, "삭제하지 못했습니다: ");
      }
    },
  };

  if (props.collapsed)
    return (
      <aside className="flex w-10 shrink-0 flex-col items-center border-r border-stone-300 bg-white py-2">
        <button type="button" className="rounded p-1.5 text-stone-500 hover:bg-stone-100" aria-label="목차 펼치기" title="목차 펼치기" onClick={props.onToggleCollapse}>
          »
        </button>
      </aside>
    );

  const groups: { kind: TreeChapter["kind"]; label: string }[] = [
    { kind: "front", label: "앞붙이" },
    { kind: "body", label: "본문" },
    { kind: "back", label: "뒷붙이" },
  ];
  const onDragEnd = (kind: string) => (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const ids = props.chapters.filter((c) => c.kind === kind).map((c) => c.id);
    if (!ids.includes(String(e.over.id))) return;
    const moved = arrayMove(ids, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id)));
    const all = [...props.chapters.filter((c) => c.kind === "front").map((c) => c.id), ...props.chapters.filter((c) => c.kind === "body").map((c) => c.id), ...props.chapters.filter((c) => c.kind === "back").map((c) => c.id)];
    const next = all.filter((id) => !ids.includes(id));
    const insertAt = kind === "front" ? 0 : kind === "body" ? props.chapters.filter((c) => c.kind === "front").length : next.length;
    next.splice(insertAt, 0, ...moved);
    props.onOp({ op: "reorderChapters", ids: next });
  };
  const totalChars = props.chapters.reduce((s, c) => s + c.sections.reduce((a, x) => a + x.charCount, 0), 0);
  const estPages = props.info?.total ?? Math.round(totalChars / props.cpp);
  const counts: Record<string, number> = { all: 0 };
  for (const c of props.chapters)
    for (const s of c.sections) {
      counts.all++;
      counts[statusOf(s)] = (counts[statusOf(s)] ?? 0) + 1;
    }

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-stone-300 bg-white">
      <div className="flex items-center justify-between gap-1 border-b border-stone-200 px-3 py-2">
        <span className="text-xs font-bold tracking-wide text-stone-500">목차</span>
        <div className="flex items-center gap-1">
          <Link href={`/projects/${props.projectId}/toc`} className="btn-ghost text-xs">
            AI 설계 보고서
          </Link>
          {props.onToggleCollapse && (
            <button type="button" className="rounded px-1.5 py-0.5 text-stone-500 hover:bg-stone-100" aria-label="목차 접기" title="목차 접기" onClick={props.onToggleCollapse}>
              «
            </button>
          )}
        </div>
      </div>
      {counts.all > 0 && (
        <div className="flex flex-wrap gap-1 border-b border-stone-100 px-2 py-1.5" role="group" aria-label="상태로 거르기">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              aria-pressed={filter === f.key}
              className={`rounded-full border px-2 py-0.5 text-[11px] ${filter === f.key ? "border-stone-800 bg-stone-800 text-white" : "border-stone-200 text-stone-600 hover:bg-stone-50"} ${!counts[f.key] && filter !== f.key ? "opacity-50" : ""}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label} {counts[f.key] ?? 0}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
        {props.chapters.length === 0 && (
          <div className="p-4 text-center text-xs leading-5 text-stone-500">
            목차가 비어 있습니다.
            <br />
            <Link href={`/projects/${props.projectId}/toc?auto=1`} className="text-amber-700 underline">
              AI로 목차 설계하기
            </Link>{" "}
            또는 아래에서 장을 추가하세요.
          </div>
        )}
        {filter !== "all" && counts.all > 0 && !counts[filter] && (
          <div className="p-3 text-center text-xs text-stone-500">
            「{FILTERS.find((f) => f.key === filter)?.label}」 상태인 절이 없습니다.{" "}
            <button type="button" className="text-amber-700 underline" onClick={() => setFilter("all")}>
              전체 보기
            </button>
          </div>
        )}
        {groups.map((g) => {
          const list = props.chapters.filter((c) => c.kind === g.kind);
          if (!list.length) return null;
          return (
            <div key={g.kind} className="mb-2">
              {g.kind !== "body" && <div className="px-2 pb-1 text-[10px] font-semibold text-stone-400">{g.label}</div>}
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd(g.kind)}>
                <SortableContext items={list.map((c) => c.id)} strategy={verticalListSortingStrategy}>
                  {list.map((c) => (
                    <ChapterBlock key={c.id} c={c} props={props} actions={actions} filter={filter} />
                  ))}
                </SortableContext>
              </DndContext>
            </div>
          );
        })}
      </div>
      <div className="space-y-2 border-t border-stone-200 p-2">
        <div className="flex gap-1">
          <button className="btn flex-1 px-2 py-1 text-xs" onClick={() => props.onOp({ op: "addChapter", kind: "body" })}>
            + 장
          </button>
          <button className="btn px-2 py-1 text-xs" onClick={() => props.onOp({ op: "addChapter", kind: "front", title: "머리말" })}>
            + 앞붙이
          </button>
          <button className="btn px-2 py-1 text-xs" onClick={() => props.onOp({ op: "addChapter", kind: "back", title: "맺음말" })}>
            + 뒷붙이
          </button>
        </div>
        <div className="flex items-start gap-2 px-1 text-[11px] text-stone-500">
          <div className="min-w-0 flex-1">
            진행 {estPages}/{props.targetPages}쪽 · {totalChars.toLocaleString()}자
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-stone-200">
              <div className="h-full bg-amber-600" style={{ width: `${Math.min(100, (estPages / (props.targetPages || 1)) * 100)}%` }} />
            </div>
          </div>
          <button type="button" className="shrink-0 rounded px-1.5 py-0.5 text-stone-500 hover:bg-stone-100 hover:text-stone-800" title="삭제한 장·절 (30일 보관)" onClick={() => setTrashOpen(true)}>
            삭제한 장·절
          </button>
        </div>
      </div>
      {trashOpen && <TrashDialog projectId={props.projectId} onClose={() => setTrashOpen(false)} onRestored={reload} />}
    </aside>
  );
}
