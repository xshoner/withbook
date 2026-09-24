"use client";

import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import Link from "next/link";
import { useState } from "react";
import { STATUS_LABEL } from "@/lib/client";
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
};

function Inline({ value, onSave, className }: { value: string; onSave: (v: string) => void; className?: string }) {
  const [edit, setEdit] = useState(false);
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
      className="w-full rounded border border-amber-400 px-1 text-sm outline-none"
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => {
        setEdit(false);
        const v = e.target.value.trim();
        if (v && v !== value) onSave(v);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setEdit(false);
      }}
    />
  );
}

function SectionRow({
  s,
  active,
  cpp,
  range,
  chapters,
  chapterId,
  onSelect,
  onOp,
}: {
  s: TreeSection & { label: string };
  active: boolean;
  cpp: number;
  range?: { start: number; end: number };
  chapters: LabeledChapter[];
  chapterId: string;
  onSelect: () => void;
  onOp: Props["onOp"];
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: s.id });
  const [menu, setMenu] = useState(false);
  const st = STATUS_LABEL[s.status] ?? STATUS_LABEL.empty;
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      className={`group relative flex cursor-pointer items-start gap-1 rounded-md py-1.5 pl-1 pr-1.5 text-sm ${active ? "bg-amber-50 text-stone-900 ring-1 ring-amber-400" : "hover:bg-stone-100"}`}
      onClick={onSelect}
    >
      <span {...attributes} {...listeners} className="mt-0.5 cursor-grab px-0.5 text-stone-300 opacity-0 group-hover:opacity-100" onClick={(e) => e.stopPropagation()} title="끌어서 순서 바꾸기">
        ⋮⋮
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5" title={s.title}>
          {s.label && <span className="shrink-0 text-xs text-stone-400">{s.label}</span>}
          <Inline className="min-w-0 break-words" value={s.title} onSave={(title) => onOp({ op: "renameSection", sectionId: s.id, title })} />
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-stone-400">
          <span className={`rounded px-1 ${st.cls}`}>{st.label}</span>
          {range && range.start > 0 && (
            <span title="인쇄 쪽 번호">
              p.{range.start}
              {range.end !== range.start && `–${range.end}`}
            </span>
          )}
        </div>
      </div>
      <button
        className="rounded px-1 text-stone-400 opacity-0 hover:bg-stone-200 group-hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          setMenu(!menu);
        }}
      >
        ⋯
      </button>
      {menu && (
        <div className="absolute right-0 top-8 z-20 w-44 rounded-md border border-stone-200 bg-white py-1 text-xs shadow-lg" onClick={(e) => e.stopPropagation()} onMouseLeave={() => setMenu(false)}>
          <button
            className="block w-full px-3 py-1.5 text-left hover:bg-stone-100"
            onClick={() => {
              setMenu(false);
              const t = prompt("절 제목", s.title);
              if (t?.trim()) onOp({ op: "renameSection", sectionId: s.id, title: t });
            }}
          >
            이름 바꾸기
          </button>
          <button
            className="block w-full px-3 py-1.5 text-left hover:bg-stone-100"
            onClick={() => {
              setMenu(false);
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
                className="block w-full truncate px-4 py-1 text-left hover:bg-stone-100"
                onClick={() => {
                  setMenu(false);
                  onOp({ op: "moveSection", sectionId: s.id, toChapterId: c.id });
                }}
              >
                → {c.label || ""} {c.title}
              </button>
            ))}
          <button
            className="mt-1 block w-full border-t border-stone-100 px-3 py-1.5 text-left text-red-600 hover:bg-red-50"
            onClick={() => {
              setMenu(false);
              if (confirm(s.charCount ? `「${s.title}」에 본문 ${s.charCount.toLocaleString()}자가 있습니다. 정말 삭제할까요?` : `「${s.title}」을(를) 삭제할까요?`))
                onOp({ op: "deleteSection", sectionId: s.id });
            }}
          >
            삭제
          </button>
        </div>
      )}
    </li>
  );
}

function ChapterBlock({ c, props }: { c: LabeledChapter; props: Props }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: c.id });
  const [open, setOpen] = useState(true);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const written = c.sections.reduce((s, x) => s + x.charCount, 0);
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const ids = c.sections.map((s) => s.id);
    const next = arrayMove(ids, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id)));
    props.onOp({ op: "reorderSections", chapterId: c.id, ids: next });
  };
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }} className="mb-2">
      <div className="group flex items-center gap-1 rounded-md px-1 py-1 hover:bg-stone-100">
        <span {...attributes} {...listeners} className="cursor-grab px-0.5 text-stone-300 opacity-0 group-hover:opacity-100" title="끌어서 장 순서 바꾸기">
          ⋮⋮
        </span>
        <button className="w-4 text-xs text-stone-400" onClick={() => setOpen(!open)}>
          {open ? "▾" : "▸"}
        </button>
        <div className="flex min-w-0 flex-1 items-baseline gap-1 font-bookhead text-[13px]" title={c.title}>
          {c.label && <span className="shrink-0 text-stone-500">{c.label}</span>}
          <Inline className="min-w-0 truncate" value={c.title} onSave={(title) => props.onOp({ op: "renameChapter", chapterId: c.id, title })} />
        </div>
        {props.info?.chapters[c.id]?.start ? <span className="text-[10px] text-stone-400">p.{props.info.chapters[c.id].start}</span> : null}
        <button
          className="rounded px-1 text-xs text-stone-400 opacity-0 hover:bg-stone-200 group-hover:opacity-100"
          title="절 추가"
          onClick={() => props.onOp({ op: "addSection", chapterId: c.id, title: "새 절" })}
        >
          +
        </button>
        <button
          className="rounded px-1 text-xs text-stone-400 opacity-0 hover:bg-red-100 hover:text-red-600 group-hover:opacity-100"
          title="장 삭제"
          onClick={() => {
            if (confirm(written ? `「${c.title}」의 모든 절(본문 ${written.toLocaleString()}자)이 삭제됩니다. 계속할까요?` : `「${c.title}」을(를) 삭제할까요?`))
              props.onOp({ op: "deleteChapter", chapterId: c.id });
          }}
        >
          ✕
        </button>
      </div>
      {open && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={c.sections.map((s) => s.id)} strategy={verticalListSortingStrategy}>
            <ul className="ml-4 border-l border-stone-200 pl-1">
              {c.sections.map((s) => (
                <SectionRow
                  key={s.id}
                  s={s}
                  active={props.current === s.id}
                  cpp={props.cpp}
                  range={props.info?.sections[s.id]}
                  chapters={props.chapters}
                  chapterId={c.id}
                  onSelect={() => props.onSelect(s.id)}
                  onOp={props.onOp}
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
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
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

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-stone-300 bg-white">
      <div className="flex items-center justify-between border-b border-stone-200 px-3 py-2">
        <span className="text-xs font-bold tracking-wide text-stone-500">목차</span>
        <Link href={`/projects/${props.projectId}/toc`} className="btn-ghost text-xs">
          AI 설계 보고서
        </Link>
      </div>
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
        {groups.map((g) => {
          const list = props.chapters.filter((c) => c.kind === g.kind);
          if (!list.length) return null;
          return (
            <div key={g.kind} className="mb-2">
              {g.kind !== "body" && <div className="px-2 pb-1 text-[10px] font-semibold text-stone-400">{g.label}</div>}
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd(g.kind)}>
                <SortableContext items={list.map((c) => c.id)} strategy={verticalListSortingStrategy}>
                  {list.map((c) => (
                    <ChapterBlock key={c.id} c={c} props={props} />
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
        <div className="px-1 text-[11px] text-stone-500">
          진행 {estPages}/{props.targetPages}쪽 · {totalChars.toLocaleString()}자
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-stone-200">
            <div className="h-full bg-amber-600" style={{ width: `${Math.min(100, (estPages / (props.targetPages || 1)) * 100)}%` }} />
          </div>
        </div>
      </div>
    </aside>
  );
}
