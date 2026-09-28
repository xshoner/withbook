"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, fmtDate } from "@/lib/client";
import { attachFile } from "@/lib/upload-client";
import { confirmDialog, toast, toastError } from "../ui/feedback";

type RefItem = { id: string; name: string; chars: number; createdAt: string };
type BookRef = RefItem & { sectionId: string; sectionTitle: string };

const ACCEPT = ".txt,.md,.pdf,.docx,.hwpx";

/**
 * 이 절의 자료 — 파일(txt·md·pdf·docx·hwpx)을 올리거나 글을 붙여 넣는다.
 * AI 집필이 이 자료를 근거로 삼고, 자료에서 가져온 내용에 출처를 표시한다.
 */
export default function ReferencesPanel({ sectionId }: { sectionId: string }) {
  const [items, setItems] = useState<RefItem[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  // 책 자료실 — 같은 책 다른 절에 붙인 자료를 다시 올리지 않고 가져온다
  const [bookRefs, setBookRefs] = useState<BookRef[] | null>(null);
  const [bookOpen, setBookOpen] = useState(false);
  const openBook = async () => {
    setBookOpen((o) => !o);
    if (bookRefs) return;
    try {
      setBookRefs((await api<{ items: BookRef[] }>(`/api/sections/${sectionId}/references?scope=book`)).items);
    } catch (e) {
      toastError(e, "책 자료실을 불러오지 못했습니다: ");
      setBookRefs([]);
    }
  };
  async function takeFromBook(r: BookRef) {
    setBusy(`「${r.name}」 가져오는 중…`);
    try {
      const res = await api<{ item: RefItem }>(`/api/sections/${sectionId}/references`, { method: "POST", json: { copyFrom: { sectionId: r.sectionId, refId: r.id } } });
      setItems((xs) => [...(xs ?? []), res.item]);
      toast.success(`「${r.name}」을 이 절 자료로 붙였습니다.`);
    } catch (e) {
      toastError(e, "가져오지 못했습니다: ");
    } finally {
      setBusy(null);
    }
  }

  const load = useCallback(async () => {
    try {
      const r = await api<{ items: RefItem[] }>(`/api/sections/${sectionId}/references`);
      setItems(r.items);
      setUnavailable(false);
    } catch (e) {
      if (e instanceof Error && /\(404\)/.test(e.message)) setUnavailable(true);
      else toastError(e, "자료 목록을 불러오지 못했습니다: ");
      setItems([]);
    }
  }, [sectionId]);
  useEffect(() => {
    setItems(null);
    void load();
  }, [load]);

  async function upload(files: File[]) {
    for (const f of files) {
      setBusy(`${f.name} 올리는 중…`);
      try {
        const fd = new FormData();
        await attachFile(fd, "file", f);
        const r = await api<{ item: RefItem; truncated?: boolean }>(`/api/sections/${sectionId}/references`, { method: "POST", body: fd });
        setItems((xs) => [...(xs ?? []), r.item]);
        if (r.truncated) toast(`「${r.item.name}」은 길어서 앞부분(${r.item.chars.toLocaleString()}자)만 자료로 보관했습니다.`);
      } catch (e) {
        toastError(e, `「${f.name}」을 올리지 못했습니다: `);
      }
    }
    setBusy(null);
  }

  async function addText() {
    const t = text.trim();
    if (!t) return toast("붙여 넣을 글이 비어 있습니다.");
    setBusy("저장 중…");
    try {
      const r = await api<{ item: RefItem; truncated?: boolean }>(`/api/sections/${sectionId}/references`, { method: "POST", json: { name: name.trim() || `붙여 넣은 자료 ${new Date().toLocaleDateString("ko-KR")}`, text: t } });
      setItems((xs) => [...(xs ?? []), r.item]);
      if (r.truncated) toast(`길어서 앞부분(${r.item.chars.toLocaleString()}자)만 자료로 보관했습니다.`);
      setName("");
      setText("");
      setPasteOpen(false);
    } catch (e) {
      toastError(e, "자료를 저장하지 못했습니다: ");
    } finally {
      setBusy(null);
    }
  }

  async function remove(it: RefItem) {
    if (!(await confirmDialog(`자료 「${it.name}」을 지울까요? 다음 집필부터 근거로 쓰지 않습니다.`, { okLabel: "지우기", danger: true }))) return;
    setBusy("지우는 중…");
    try {
      await api(`/api/sections/${sectionId}/references?refId=${encodeURIComponent(it.id)}`, { method: "DELETE" });
      setItems((xs) => (xs ?? []).filter((x) => x.id !== it.id));
    } catch (e) {
      toastError(e, "자료를 지우지 못했습니다: ");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="h-full space-y-3 overflow-auto p-3 text-sm">
      <p className="rounded-lg bg-sky-50 p-2 text-[11px] leading-4 text-sky-900">
        이 절에 쓸 자료(기사·논문·메모 등)를 올리세요. <b>AI 집필이 자료를 근거로 삼고</b>, 자료에서 가져온 내용에는 출처를 표시합니다.
      </p>
      {unavailable ? (
        <p className="text-xs text-stone-500">자료 기능을 아직 쓸 수 없습니다 (서버 기능 준비 중).</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <button className="btn px-2 py-1 text-xs" disabled={!!busy} onClick={() => fileRef.current?.click()} title={`파일 올리기 (${ACCEPT.replaceAll(",", " ")})`}>
              파일 올리기
            </button>
            <button className="btn px-2 py-1 text-xs" disabled={!!busy} onClick={() => setPasteOpen((o) => !o)} aria-expanded={pasteOpen}>
              글 붙여 넣기
            </button>
            <button className="btn px-2 py-1 text-xs" disabled={!!busy} onClick={openBook} aria-expanded={bookOpen} title="같은 책의 다른 절에 올린 자료를 다시 올리지 않고 가져옵니다">
              책 자료실에서
            </button>
            <input
              ref={fileRef}
              type="file"
              accept={ACCEPT}
              multiple
              hidden
              onChange={(e) => {
                const fs = [...(e.target.files ?? [])];
                e.target.value = "";
                if (fs.length) void upload(fs);
              }}
            />
          </div>
          {pasteOpen && (
            <div className="space-y-1.5 rounded-lg border border-stone-200 bg-white p-2">
              <input className="input py-1 text-xs" placeholder="자료 이름 (예: 2025 교육부 보도자료)" value={name} onChange={(e) => setName(e.target.value)} />
              <textarea className="input min-h-[120px] text-xs leading-5" placeholder="자료 글을 붙여 넣으세요" value={text} onChange={(e) => setText(e.target.value)} />
              <div className="flex items-center gap-2">
                <button className="btn-primary px-2 py-1 text-xs" disabled={!!busy || !text.trim()} onClick={addText}>
                  자료로 저장
                </button>
                <span className="text-[11px] text-stone-400">{text.length.toLocaleString()}자</span>
              </div>
            </div>
          )}
          {bookOpen && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-2">
              <p className="mb-1 text-[11px] text-stone-500">같은 책 다른 절의 자료 — [가져오기]하면 이 절에도 붙습니다.</p>
              {bookRefs === null ? (
                <p className="text-xs text-stone-400">불러오는 중…</p>
              ) : bookRefs.length === 0 ? (
                <p className="text-xs text-stone-400">다른 절에 올린 자료가 없습니다.</p>
              ) : (
                <ul className="max-h-56 space-y-1 overflow-auto">
                  {bookRefs.map((r) => {
                    const here = items?.some((x) => x.name === r.name && x.chars === r.chars);
                    return (
                      <li key={`${r.sectionId}:${r.id}`} className="flex items-center gap-2 rounded bg-white px-2 py-1 text-xs">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-stone-800" title={r.name}>
                            {r.name}
                          </span>
                          <span className="block truncate text-[10px] text-stone-400">
                            {r.sectionTitle} · {r.chars.toLocaleString()}자
                          </span>
                        </span>
                        {here ? (
                          <span className="shrink-0 text-[11px] text-stone-400">붙어 있음</span>
                        ) : (
                          <button className="btn-ghost shrink-0 px-1.5 py-0.5 text-[11px] text-emerald-800" disabled={!!busy} onClick={() => takeFromBook(r)}>
                            가져오기
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
          {busy && <p className="text-xs text-sky-700">{busy}</p>}
          {items === null ? (
            <p className="text-xs text-stone-400">불러오는 중…</p>
          ) : items.length === 0 ? (
            <p className="text-xs text-stone-400">아직 자료가 없습니다.</p>
          ) : (
            <ul className="space-y-1">
              {items.map((it) => (
                <li key={it.id} className="flex items-center gap-2 rounded border border-stone-200 bg-white px-2 py-1.5 text-xs">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-stone-800" title={it.name}>
                      {it.name}
                    </span>
                    <span className="text-[11px] text-stone-400">
                      {it.chars.toLocaleString()}자 · {fmtDate(it.createdAt)}
                    </span>
                  </span>
                  <button className="shrink-0 text-stone-300 hover:text-red-600" aria-label={`자료 ${it.name} 지우기`} disabled={!!busy} onClick={() => remove(it)}>
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
