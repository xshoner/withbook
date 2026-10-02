"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import LogoutButton from "@/components/LogoutButton";
import { api, fmtDate } from "@/lib/client";
import { attachFile } from "@/lib/upload-client";
import { confirmDialog, toast, toastError } from "@/components/ui/feedback";
import { deadlinePlan, type DeadlinePlan } from "@/lib/progress";

type P = {
  id: string;
  title: string;
  subtitle: string;
  author: string;
  targetPages: number;
  estPages: number;
  /** 집필 화면이 잰 실제 조판 쪽수 그대로 (false면 글자 수로 어림) */
  pagesExact?: boolean;
  sections: number;
  written: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  /** 마지막으로 고친 절 · 다음 빈 절 (이어 쓰기) */
  last?: { sectionId: string; title: string } | null;
  next?: { sectionId: string; title: string } | null;
  /** 남은 [확인 필요]·[이미지 제안] 표시 수 (팩트체크) */
  checks?: number;
  /** 마감일 (YYYY-MM-DD)과 하루 분량 */
  deadline?: string | null;
  plan?: DeadlinePlan | null;
};

type Sort = "updated" | "created" | "createdAsc" | "title";
const SORTS: [Sort, string][] = [
  ["updated", "최근 수정순"],
  ["created", "최근 생성순"],
  ["createdAsc", "오래된 생성순"],
  ["title", "제목순"],
];
const SORT_KEY = "withbook:projects-sort";
const time = (s: string) => new Date(s).getTime() || 0;

export default function ProjectList() {
  const router = useRouter();
  const [list, setList] = useState<P[] | null>(null);
  const [style, setStyle] = useState<any>(null);
  const [showTrash, setShowTrash] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [loadErr, setLoadErr] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSortState] = useState<Sort>("updated");
  useEffect(() => {
    try {
      const s = localStorage.getItem(SORT_KEY) as Sort | null;
      if (s && SORTS.some(([k]) => k === s)) setSortState(s);
    } catch {}
  }, []);
  const setSort = (s: Sort) => {
    setSortState(s);
    try {
      localStorage.setItem(SORT_KEY, s);
    } catch {}
  };
  const load = () => api<P[]>("/api/projects").then((r) => {
    setList(r);
    setLoadErr("");
  });
  useEffect(() => {
    load().catch((e) => setLoadErr(e?.message ?? String(e)));
    api("/api/style/global").then(setStyle).catch(() => {});
  }, []);

  const allActive = list?.filter((p) => !p.deletedAt) ?? [];
  const q = query.trim().toLowerCase();
  const active = allActive
    .filter((p) => !q || [p.title, p.subtitle, p.author].some((t) => t?.toLowerCase().includes(q)))
    .toSorted((a, b) =>
      sort === "title"
        ? a.title.localeCompare(b.title, "ko")
        : sort === "created"
          ? time(b.createdAt) - time(a.createdAt)
          : sort === "createdAsc"
            ? time(a.createdAt) - time(b.createdAt)
            : time(b.updatedAt) - time(a.updatedAt),
    );
  const trash = list?.filter((p) => p.deletedAt) ?? [];

  /** 마감일 정하기·지우기 — 목록을 다시 받지 않고 이 카드만 고친다 */
  const setDeadline = async (p: P, date: string | null) => {
    try {
      await api(`/api/projects/${p.id}/deadline`, { method: "PUT", json: { date } });
      setList((l) => l?.map((x) => (x.id === p.id ? { ...x, deadline: date, plan: date ? deadlinePlan(date, x.estPages, x.targetPages) : null } : x)) ?? l);
    } catch (e) {
      toastError(e, "마감일을 저장하지 못했습니다: ");
    }
  };

  const act = async (p: P, kind: "dup" | "del" | "restore" | "purge") => {
    if (kind === "del" && !(await confirmDialog(`「${p.title}」을(를) 휴지통으로 옮길까요? 30일 뒤 자동 삭제됩니다.`, { okLabel: "휴지통으로" }))) return;
    if (kind === "purge" && !(await confirmDialog(`「${p.title}」을(를) 영구 삭제할까요? 되돌릴 수 없습니다.`, { danger: true, okLabel: "영구 삭제" }))) return;
    try {
      if (kind === "dup") await api(`/api/projects/${p.id}/duplicate`, { method: "POST" });
      if (kind === "del") await api(`/api/projects/${p.id}`, { method: "DELETE" });
      if (kind === "restore") await api(`/api/projects/${p.id}`, { method: "PATCH", json: { restore: true } });
      if (kind === "purge") await api(`/api/projects/${p.id}?permanent=1`, { method: "DELETE" });
      toast.success({ dup: `「${p.title}」을(를) 복제했습니다.`, del: `「${p.title}」을(를) 휴지통으로 옮겼습니다.`, restore: `「${p.title}」을(를) 복원했습니다.`, purge: `「${p.title}」을(를) 영구 삭제했습니다.` }[kind]);
    } catch (e) {
      toastError(e, { dup: "복제하지 못했습니다: ", del: "삭제하지 못했습니다: ", restore: "복원하지 못했습니다: ", purge: "영구 삭제하지 못했습니다: " }[kind]);
    }
    load().catch((e) => toastError(e, "목록을 새로 고치지 못했습니다: "));
  };

  const importBackup = async (f: File) => {
    const fd = new FormData();
    try {
      await attachFile(fd, "file", f);
      const r = await api<{ id: string; warnings?: string[] }>("/api/projects/import", { method: "POST", body: fd });
      for (const w of r.warnings ?? []) toast(w, { sticky: true });
      router.push(`/projects/${r.id}`);
    } catch (e: any) {
      toastError(e);
    }
  };

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-8 flex items-end justify-between">
        <div>
          <h1 className="font-bookhead text-3xl text-stone-900">
            with<span className="text-amber-700">book</span>
          </h1>
          <p className="mt-1 text-sm text-stone-500">책 선택 · 스케치를 작가의 문체로, A5 인쇄 규격 그대로</p>
        </div>
        <div className="flex gap-2">
          <Link href="/settings" className="btn">
            설정 · AI 사용량
          </Link>
          <button className="btn" onClick={() => fileRef.current?.click()}>
            백업 불러오기
          </button>
          <input ref={fileRef} type="file" accept=".zip" hidden onChange={(e) => e.target.files?.[0] && importBackup(e.target.files[0])} />
          <Link href="/projects/new/import" className="btn" title="써 둔 원고(docx·hwpx·pdf·txt·md)를 장·절로 나눠 새 책으로 만듭니다">
            원고 가져오기
          </Link>
          <Link href="/projects/new" className="btn-primary">
            + 새 책
          </Link>
          <LogoutButton />
        </div>
      </header>

      {style && (
        <div className={`mb-6 rounded-lg border px-4 py-3 text-sm ${style.global ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-800"}`}>
          {style.global ? (
            <>
              <b>문체 학습 완료</b> — 설정에 올린 학습 자료 {style.global.files.length}편으로 학습한 기본 문체가 새 책에 자동 적용됩니다.{" "}
              <Link className="underline" href="/settings#style">
                자세히
              </Link>
            </>
          ) : (
            <>
              <b>문체 학습 전</b> — {style.files.length ? `설정에 올린 학습 자료 ${style.files.length}개로` : "설정에서 작가의 글을 올려"} 기본 문체를 먼저 학습하세요.{" "}
              <Link className="underline" href="/settings#style">
                학습하러 가기
              </Link>
            </>
          )}
        </div>
      )}

      {list === null ? (
        loadErr ? (
          <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
            책 목록을 불러오지 못했습니다: {loadErr}{" "}
            <button className="underline" onClick={() => load().catch((e) => setLoadErr(e?.message ?? String(e)))}>
              다시 시도
            </button>
          </p>
        ) : (
          <p className="text-stone-400">불러오는 중…</p>
        )
      ) : allActive.length === 0 ? (
        <div className="card flex flex-col items-center gap-3 px-6 py-16 text-center">
          <p className="font-bookhead text-xl">첫 책을 시작해 볼까요?</p>
          <p className="text-sm text-stone-500">책 정보를 입력하면 AI가 목차를 설계해 보고합니다. 써 둔 원고가 있으면 가져와서 시작할 수도 있습니다.</p>
          <div className="mt-2 flex gap-2">
            <Link href="/projects/new" className="btn-primary">
              + 새 책
            </Link>
            <Link href="/projects/new/import" className="btn">
              원고 가져오기
            </Link>
          </div>
        </div>
      ) : (
        <>
        {allActive.length > 1 && (
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <input className="input w-60 py-1.5 text-sm" placeholder="제목·부제·지은이로 찾기" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="책 찾기" />
            <select className="input w-auto py-1.5 text-sm" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="정렬">
              {SORTS.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
            <span className="text-xs text-stone-400">{q ? `${active.length} / ${allActive.length}권` : `${allActive.length}권`}</span>
          </div>
        )}
        {active.length === 0 && <p className="py-8 text-center text-sm text-stone-500">「{query}」에 맞는 책이 없습니다.</p>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {active.map((p) => {
            const pct = p.sections ? Math.round((p.written / p.sections) * 100) : 0;
            return (
              <div key={p.id} className="card group flex flex-col p-5">
                <Link href={`/projects/${p.id}`} className="flex-1">
                  <div className="font-bookhead text-lg leading-snug">{p.title}</div>
                  {p.subtitle && <div className="mt-0.5 text-sm text-stone-500">{p.subtitle}</div>}
                  <div className="mt-1 text-xs text-stone-400">{p.author}</div>
                  <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-stone-100">
                    <div className="h-full bg-amber-600" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="mt-1.5 flex justify-between text-xs text-stone-500">
                    <span>
                      절 {p.written}/{p.sections} 작성
                    </span>
                    <span title={p.pagesExact ? "집필 화면의 실제 조판 쪽수" : "마지막으로 잰 조판 쪽수에 그 뒤 바뀐 글자 수를 더해 어림한 값 — 책을 열면 다시 잽니다"}>
                      {p.pagesExact ? "" : "약 "}
                      {p.estPages}/{p.targetPages}쪽
                    </span>
                  </div>
                </Link>
                <Progress p={p} onDeadline={(d) => void setDeadline(p, d)} />
                {(p.last || p.next) && (
                  <div className="mt-3 space-y-1 text-xs">
                    {p.last && (
                      <Link href={`/projects/${p.id}?s=${p.last.sectionId}`} className="flex items-center gap-1.5 rounded bg-amber-50 px-2 py-1 text-amber-900 hover:bg-amber-100" title="마지막으로 고친 절에서 이어 씁니다">
                        <span className="shrink-0 font-semibold">이어 쓰기</span>
                        <span className="truncate">{p.last.title}</span>
                      </Link>
                    )}
                    {p.next && p.next.sectionId !== p.last?.sectionId && (
                      <Link href={`/projects/${p.id}?s=${p.next.sectionId}`} className="flex items-center gap-1.5 rounded px-2 py-1 text-stone-600 hover:bg-stone-100" title="본문에서 아직 쓰지 않은 첫 절">
                        <span className="shrink-0 font-semibold">다음 빈 절</span>
                        <span className="truncate">{p.next.title}</span>
                      </Link>
                    )}
                  </div>
                )}
                <div className="mt-4 flex items-center justify-between border-t border-stone-100 pt-3 text-xs text-stone-400">
                  <span className="leading-4">
                    <span className="block" title="마지막으로 고친 때">수정 {fmtDate(p.updatedAt)}</span>
                    <span className="block text-stone-400/80" title="책을 처음 만든 때">생성 {fmtDate(p.createdAt)}</span>
                  </span>
                  <span className="flex gap-1 opacity-0 transition group-hover:opacity-100">
                    <button className="btn-ghost text-xs" onClick={() => act(p, "dup")}>
                      복제
                    </button>
                    <button className="btn-ghost text-xs text-red-600" onClick={() => act(p, "del")}>
                      삭제
                    </button>
                  </span>
                </div>
              </div>
            );
          })}
        </div>
        </>
      )}

      {trash.length > 0 && (
        <section className="mt-10">
          <button className="btn-ghost" onClick={() => setShowTrash(!showTrash)}>
            {showTrash ? "▾" : "▸"} 휴지통 ({trash.length}) — 30일 뒤 자동 삭제
          </button>
          {showTrash && (
            <ul className="mt-2 divide-y divide-stone-200 rounded-lg border border-stone-200 bg-white">
              {trash.map((p) => (
                <li key={p.id} className="flex items-center justify-between px-4 py-2 text-sm">
                  <span>
                    {p.title} <span className="text-xs text-stone-400">· 삭제 {fmtDate(p.deletedAt!)}</span>
                  </span>
                  <span className="flex gap-1">
                    <button className="btn-ghost text-xs" onClick={() => act(p, "restore")}>
                      복원
                    </button>
                    <button className="btn-ghost text-xs text-red-600" onClick={() => act(p, "purge")}>
                      영구 삭제
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}

/** 책 진행 현황 — 마감일·하루 분량·남은 팩트체크 */
function Progress({ p, onDeadline }: { p: P; onDeadline: (date: string | null) => void }) {
  const plan = p.plan;
  const d = p.deadline;
  const tone = !plan ? "text-stone-500" : plan.pagesLeft === 0 ? "text-emerald-700" : plan.daysLeft <= 0 ? "text-red-700" : plan.daysLeft <= 7 ? "text-amber-800" : "text-stone-600";
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      {d && plan ? (
        <span className={tone}>
          <b>{plan.daysLeft > 0 ? `D-${plan.daysLeft - 1 || "day"}` : "마감 지남"}</b>
          {" · "}
          {plan.pagesLeft === 0 ? "목표 분량 달성" : plan.perDay ? `하루 약 ${plan.perDay}쪽` : `${plan.pagesLeft}쪽 남음`}
        </span>
      ) : null}
      <label className="flex cursor-pointer items-center gap-1 rounded px-1 text-stone-500 hover:bg-stone-100" title="마감일을 정하면 하루에 쓸 분량을 알려 줍니다">
        {d ? `마감 ${d.slice(5).replace("-", "/")}` : "+ 마감일"}
        <input
          type="date"
          className="w-0 opacity-0"
          value={d ?? ""}
          onChange={(e) => onDeadline(e.target.value || null)}
          onClick={(e) => {
            try {
              (e.currentTarget as HTMLInputElement).showPicker?.();
            } catch {}
          }}
        />
      </label>
      {d && (
        <button className="text-stone-300 hover:text-red-600" aria-label="마감일 지우기" title="마감일 지우기" onClick={() => onDeadline(null)}>
          ✕
        </button>
      )}
      {!!p.checks && (
        <Link href={`/projects/${p.id}?checks=1`} className="ml-auto rounded bg-red-50 px-1.5 py-0.5 font-semibold text-red-700 hover:bg-red-100" title="AI가 남긴 [확인 필요]·[이미지 제안] 표시 — 책을 열고 [팩트체크]에서 처리합니다">
          팩트체크 {p.checks}
        </Link>
      )}
    </div>
  );
}
