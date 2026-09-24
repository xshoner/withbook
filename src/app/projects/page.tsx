"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import LogoutButton from "@/components/LogoutButton";
import { api, fmtDate } from "@/lib/client";
import { attachFile } from "@/lib/upload-client";

type P = {
  id: string;
  title: string;
  subtitle: string;
  author: string;
  targetPages: number;
  estPages: number;
  sections: number;
  written: number;
  updatedAt: string;
  deletedAt: string | null;
};

export default function ProjectList() {
  const router = useRouter();
  const [list, setList] = useState<P[] | null>(null);
  const [style, setStyle] = useState<any>(null);
  const [showTrash, setShowTrash] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const load = () => api<P[]>("/api/projects").then(setList);
  useEffect(() => {
    load();
    api("/api/style/global").then(setStyle).catch(() => {});
  }, []);

  const active = list?.filter((p) => !p.deletedAt) ?? [];
  const trash = list?.filter((p) => p.deletedAt) ?? [];

  const act = async (p: P, kind: "dup" | "del" | "restore" | "purge") => {
    if (kind === "del" && !confirm(`「${p.title}」을(를) 휴지통으로 옮길까요? 30일 뒤 자동 삭제됩니다.`)) return;
    if (kind === "purge" && !confirm(`「${p.title}」을(를) 영구 삭제할까요? 되돌릴 수 없습니다.`)) return;
    if (kind === "dup") await api(`/api/projects/${p.id}/duplicate`, { method: "POST" });
    if (kind === "del") await api(`/api/projects/${p.id}`, { method: "DELETE" });
    if (kind === "restore") await api(`/api/projects/${p.id}`, { method: "PATCH", json: { restore: true } });
    if (kind === "purge") await api(`/api/projects/${p.id}?permanent=1`, { method: "DELETE" });
    load();
  };

  const importBackup = async (f: File) => {
    const fd = new FormData();
    try {
      await attachFile(fd, "file", f);
      const r = await api<{ id: string }>("/api/projects/import", { method: "POST", body: fd });
      router.push(`/projects/${r.id}`);
    } catch (e: any) {
      alert(e.message);
    }
  };

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-8 flex items-end justify-between">
        <div>
          <h1 className="font-bookhead text-3xl text-stone-900">
            with<span className="text-amber-700">book</span>
          </h1>
          <p className="mt-1 text-sm text-stone-500">프로젝트 선택 · 스케치를 작가의 문체로, 부크크 A5 규격 그대로</p>
        </div>
        <div className="flex gap-2">
          <Link href="/settings" className="btn">
            설정 · AI 사용량
          </Link>
          <button className="btn" onClick={() => fileRef.current?.click()}>
            백업 불러오기
          </button>
          <input ref={fileRef} type="file" accept=".zip" hidden onChange={(e) => e.target.files?.[0] && importBackup(e.target.files[0])} />
          <Link href="/projects/new" className="btn-primary">
            + 새 프로젝트
          </Link>
          <LogoutButton />
        </div>
      </header>

      {style && (
        <div className={`mb-6 rounded-lg border px-4 py-3 text-sm ${style.global ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-800"}`}>
          {style.global ? (
            <>
              <b>문체 학습 완료</b> — style reference 폴더의 글 {style.global.files.length}편으로 학습한 문체가 새 프로젝트에 자동 적용됩니다.{" "}
              <Link className="underline" href="/settings#style">
                자세히
              </Link>
            </>
          ) : (
            <>
              <b>문체 학습 전</b> — style reference 폴더({style.files.length}개 파일)로 작가 문체를 먼저 학습하세요.{" "}
              <Link className="underline" href="/settings#style">
                학습하러 가기
              </Link>
            </>
          )}
        </div>
      )}

      {list === null ? (
        <p className="text-stone-400">불러오는 중…</p>
      ) : active.length === 0 ? (
        <div className="card flex flex-col items-center gap-3 px-6 py-16 text-center">
          <p className="font-bookhead text-xl">첫 책을 시작해 볼까요?</p>
          <p className="text-sm text-stone-500">책 정보를 입력하면 AI가 목차를 설계해 보고합니다.</p>
          <Link href="/projects/new" className="btn-primary mt-2">
            + 새 프로젝트
          </Link>
        </div>
      ) : (
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
                    <span>
                      약 {p.estPages}/{p.targetPages}쪽
                    </span>
                  </div>
                </Link>
                <div className="mt-4 flex items-center justify-between border-t border-stone-100 pt-3 text-xs text-stone-400">
                  <span>{fmtDate(p.updatedAt)}</span>
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
