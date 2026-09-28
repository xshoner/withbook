"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/client";
import { type BiblioConfig, type IndexConfig, type IndexTerm, groupIndex } from "@/lib/back-matter";
import { confirmDialog, toast, toastError } from "@/components/ui/feedback";

type Data = { index: IndexConfig; biblio: BiblioConfig };

/**
 * 책 설정 → [색인·참고문헌] — 책 끝에 '참고문헌'과 '찾아보기'를 붙인다.
 * 찾아보기 쪽 번호는 미리보기·PDF 조판 때 쪽마다 글에서 용어를 찾아 자동으로 매긴다(원고에는 아무 표시도 넣지 않는다).
 */
export default function BackMatterTab({ projectId }: { projectId: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [saved, setSaved] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<"" | "save" | "suggest" | "collect">("");
  const [suggest, setSuggest] = useState<{ terms: IndexTerm[]; dropped: number; picked: Set<string> } | null>(null);
  const [newTerm, setNewTerm] = useState("");
  const [bibText, setBibText] = useState("");

  const load = () =>
    api<Data>(`/api/projects/${projectId}/back-matter`)
      .then((d) => {
        setData(d);
        setBibText(d.biblio.entries.map((e) => e.text).join("\n"));
        setSaved(JSON.stringify(d));
        setErr("");
      })
      .catch((e) => setErr(e?.message ?? String(e)));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const current = useMemo<Data | null>(
    () => (data ? { index: data.index, biblio: { ...data.biblio, entries: bibText.split("\n").map((t) => t.trim()).filter(Boolean).map((text, i) => ({ id: data.biblio.entries.find((e) => e.text === text)?.id ?? `n${i}`, text })) } } : null),
    [data, bibText],
  );
  const dirty = current ? JSON.stringify(current) !== saved : false;

  if (err) return <p className="card p-6 text-sm text-red-700">불러오지 못했습니다: {err}</p>;
  if (!data || !current) return <p className="card p-6 text-sm text-stone-400">불러오는 중…</p>;

  const setIndex = (fn: (ix: IndexConfig) => IndexConfig) => setData({ ...data, index: fn(data.index) });
  const addTerms = (terms: IndexTerm[]) =>
    setIndex((ix) => {
      const have = new Set(ix.terms.map((t) => t.term));
      return { ...ix, terms: [...ix.terms, ...terms.filter((t) => t.term.trim() && !have.has(t.term.trim()))] };
    });

  const save = async () => {
    setBusy("save");
    try {
      const d = await api<Data>(`/api/projects/${projectId}/back-matter`, { method: "PUT", json: current });
      setData(d);
      setBibText(d.biblio.entries.map((e) => e.text).join("\n"));
      setSaved(JSON.stringify(d));
      toast.success("저장했습니다. 미리보기·PDF에서 책 끝에 들어갑니다.");
    } catch (e) {
      toastError(e, "저장하지 못했습니다: ");
    } finally {
      setBusy("");
    }
  };
  const runSuggest = async () => {
    setBusy("suggest");
    try {
      const r = await api<{ terms: IndexTerm[]; dropped: number }>(`/api/projects/${projectId}/back-matter`, { method: "POST", json: { action: "suggest-index" }, timeoutMs: 290_000 });
      setSuggest({ ...r, picked: new Set(r.terms.map((t) => t.term)) });
      if (!r.terms.length) toast("새로 추천할 용어가 없습니다.");
    } catch (e) {
      toastError(e, "추천받지 못했습니다: ");
    } finally {
      setBusy("");
    }
  };
  const fromGlossary = async () => {
    try {
      const g = await api<{ term: string; preferred: string }[]>(`/api/projects/${projectId}/glossary`);
      if (!g.length) return toast("용어집이 비어 있습니다.");
      addTerms(g.map((x) => ({ term: x.preferred, aliases: x.term && x.term !== x.preferred ? [x.term] : [], see: "" })));
      toast.success(`용어집에서 ${g.length}개를 가져왔습니다(이미 있는 것은 뺐습니다). 저장을 누르세요.`);
    } catch (e) {
      toastError(e, "용어집을 불러오지 못했습니다: ");
    }
  };
  const collect = async () => {
    if (bibText.trim() && !(await confirmDialog("원고의 각주·그림 출처·참고 자료에서 모아 정리한 목록으로 지금 목록을 바꿀까요? (저장하기 전까지는 되돌릴 수 있습니다)", { okLabel: "모아서 바꾸기" }))) return;
    setBusy("collect");
    try {
      const r = await api<{ entries: string[]; candidates: number; formatted: boolean }>(`/api/projects/${projectId}/back-matter`, { method: "POST", json: { action: "collect-biblio" }, timeoutMs: 290_000 });
      if (!r.candidates) return toast("원고에서 출처로 보이는 각주·그림 캡션·참고 자료를 찾지 못했습니다.");
      setBibText(r.entries.join("\n"));
      toast.success(r.formatted ? `후보 ${r.candidates}개를 참고문헌 ${r.entries.length}개로 정리했습니다. 확인하고 저장하세요.` : `AI 정리를 못 해 모은 후보 ${r.candidates}개를 그대로 넣었습니다. 다듬고 저장하세요.`);
    } catch (e) {
      toastError(e, "모으지 못했습니다: ");
    } finally {
      setBusy("");
    }
  };

  const groups = groupIndex(data.index.terms);
  return (
    <div className="space-y-6">
      <p className="text-sm text-stone-500">
        책 끝(판권면 앞)에 <b>참고문헌</b>과 <b>찾아보기</b>를 붙입니다. 찾아보기의 쪽 번호는 미리보기·PDF 조판 때 쪽마다 글에서 용어를 찾아 <b>자동으로</b> 매깁니다 — 원고를 고쳐도 다시 조판하면 맞춰집니다. HWPX에는 참고문헌만 들어갑니다.
      </p>

      <section className="card space-y-3 p-6">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">참고문헌</h2>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={data.biblio.enabled} onChange={(e) => setData({ ...data, biblio: { ...data.biblio, enabled: e.target.checked } })} />
            책에 넣기
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn text-xs" disabled={!!busy} onClick={collect} title="출처처럼 보이는 각주, 그림 캡션의 출처·라이선스, 절 참고 자료 이름을 모아 AI가 참고문헌 형식으로 정리합니다">
            {busy === "collect" ? "모으는 중… (1분 안팎)" : "원고에서 모아 정리 (AI)"}
          </button>
        </div>
        <textarea
          className="input h-56 font-book text-sm leading-6"
          placeholder={"한 줄에 하나씩 — 예:\n홍길동, 『배움의 과학』, 가나출판사, 2021.\n통계청, 「2025 인구동향조사」, 2025, https://kostat.go.kr"}
          value={bibText}
          onChange={(e) => setBibText(e.target.value)}
        />
        <p className="text-xs text-stone-400">{current.biblio.entries.length}개 · 적은 순서대로 들어갑니다. 원고에 없는 정보를 AI가 지어내지 않도록 했지만, 저자·연도·쪽수는 꼭 확인하세요.</p>
      </section>

      <section className="card space-y-3 p-6">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">찾아보기 (색인)</h2>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={data.index.enabled} onChange={(e) => setIndex((ix) => ({ ...ix, enabled: e.target.checked }))} />
            책에 넣기
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn text-xs" disabled={!!busy} onClick={runSuggest} title="장·절 요지와 원고에 자주 나오는 말을 보고 핵심 용어를 추천합니다. 원고에 실제로 나오는 용어만 남깁니다">
            {busy === "suggest" ? "고르는 중… (1분 안팎)" : "용어 추천 (AI)"}
          </button>
          <button className="btn text-xs" disabled={!!busy} onClick={fromGlossary}>
            용어집에서 가져오기
          </button>
          <form
            className="ml-auto flex gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (!newTerm.trim()) return;
              addTerms([{ term: newTerm.trim(), aliases: [], see: "" }]);
              setNewTerm("");
            }}
          >
            <input className="input w-40 py-1 text-sm" placeholder="용어 직접 추가" value={newTerm} onChange={(e) => setNewTerm(e.target.value)} />
            <button className="btn text-xs">추가</button>
          </form>
        </div>

        {suggest && suggest.terms.length > 0 && (
          <div className="rounded-lg border border-violet-200 bg-violet-50/50 p-3">
            <div className="mb-2 flex items-center justify-between text-xs">
              <span className="text-violet-900">
                추천 {suggest.terms.length}개{suggest.dropped ? ` · 원고에 없어 뺀 것 ${suggest.dropped}개` : ""}
              </span>
              <span className="flex gap-2">
                <button className="underline" onClick={() => setSuggest({ ...suggest, picked: new Set(suggest.terms.map((t) => t.term)) })}>
                  모두
                </button>
                <button className="underline" onClick={() => setSuggest({ ...suggest, picked: new Set() })}>
                  해제
                </button>
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {suggest.terms.map((t) => {
                const on = suggest.picked.has(t.term);
                return (
                  <button
                    key={t.term}
                    className={`rounded-full border px-2 py-0.5 text-xs ${on ? "border-violet-400 bg-white text-violet-900" : "border-stone-200 text-stone-400 line-through"}`}
                    onClick={() => {
                      const picked = new Set(suggest.picked);
                      if (on) picked.delete(t.term);
                      else picked.add(t.term);
                      setSuggest({ ...suggest, picked });
                    }}
                    title={t.aliases.length ? `다른 표기: ${t.aliases.join(", ")}` : undefined}
                  >
                    {t.term}
                    {t.aliases.length ? <span className="text-stone-400"> · {t.aliases.join(", ")}</span> : null}
                  </button>
                );
              })}
            </div>
            <button
              className="btn-primary mt-3 px-3 py-1 text-xs"
              disabled={!suggest.picked.size}
              onClick={() => {
                addTerms(suggest.terms.filter((t) => suggest.picked.has(t.term)));
                setSuggest(null);
              }}
            >
              고른 {suggest.picked.size}개 넣기
            </button>
          </div>
        )}

        {data.index.terms.length === 0 ? (
          <p className="py-4 text-center text-sm text-stone-400">아직 용어가 없습니다. [용어 추천]이나 [용어집에서 가져오기]로 시작하세요.</p>
        ) : (
          <div className="max-h-[28rem] overflow-auto rounded border border-stone-200">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-stone-50 text-left text-xs text-stone-500">
                <tr>
                  <th className="px-2 py-1.5">용어</th>
                  <th className="px-2 py-1.5" title="본문에서 함께 찾을 다른 표기 — 쉼표로 구분">다른 표기(함께 찾기)</th>
                  <th className="px-2 py-1.5" title="쪽 번호 대신 '→ ○○' 참조만 보입니다">참조(→)</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => [
                  <tr key={`h-${g.head}`}>
                    <td colSpan={4} className="bg-stone-100/70 px-2 py-0.5 text-xs font-semibold text-stone-500">
                      {g.head}
                    </td>
                  </tr>,
                  ...g.terms.map((t) => (
                    <tr key={t.term} className="border-t border-stone-100">
                      <td className="px-2 py-1 font-medium">{t.term}</td>
                      <td className="px-2 py-1">
                        <input
                          className="input py-0.5 text-xs"
                          value={t.aliases.join(", ")}
                          onChange={(e) => setIndex((ix) => ({ ...ix, terms: ix.terms.map((x) => (x.term === t.term ? { ...x, aliases: e.target.value.split(",").map((a) => a.trim()) } : x)) }))}
                        />
                      </td>
                      <td className="px-2 py-1">
                        <input
                          className="input py-0.5 text-xs"
                          placeholder="없음"
                          value={t.see}
                          onChange={(e) => setIndex((ix) => ({ ...ix, terms: ix.terms.map((x) => (x.term === t.term ? { ...x, see: e.target.value } : x)) }))}
                        />
                      </td>
                      <td className="px-1 text-right">
                        <button className="btn-ghost px-1 text-xs text-stone-400 hover:text-red-600" title="빼기" onClick={() => setIndex((ix) => ({ ...ix, terms: ix.terms.filter((x) => x.term !== t.term) }))}>
                          ✕
                        </button>
                      </td>
                    </tr>
                  )),
                ])}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-stone-400">{data.index.terms.length}개 · 가나다순으로 자동 정렬 · 본문에 나오지 않는 용어는 쪽 번호 없이 들어갑니다(미리보기에서 확인하세요).</p>
      </section>

      <div className="sticky bottom-4 flex justify-end">
        <button className="btn-primary shadow-lg" disabled={!dirty || busy === "save"} onClick={save}>
          {busy === "save" ? "저장 중…" : dirty ? "색인·참고문헌 저장" : "저장됨"}
        </button>
      </div>
    </div>
  );
}
