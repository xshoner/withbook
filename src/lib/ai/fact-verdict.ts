/**
 * 사실 확인 판정 정리 (DB·AI 없이 테스트한다).
 * - revise: 판정이 보완이고 고친 문장이 있고 근거가 하나 이상 → 문장을 고친 문장으로 바꾼다
 * - pass:   판정이 통과이고 근거가 하나 이상 → [확인 필요] 표시만 지운다
 * - unsure: 그 밖 모두(근거 없음·판정 문구가 애매함·보완인데 고친 문장 없음) → 원고를 건드리지 않고 표시를 남긴다
 * 근거 없이 표시가 사라지면 작가는 확인됐다고 믿게 된다 — 모를 때는 남기는 쪽이 안전하다.
 */
export type FactVerdict = "pass" | "revise" | "unsure";

export function decideFactVerdict(v: { verdict: string; revised: string; evidence: { source: string }[] }): FactVerdict {
  const evidence = v.evidence.some((e) => e.source.trim());
  const verdict = v.verdict.trim();
  if (!evidence) return "unsure";
  if (/보완|revise|fail|오류/i.test(verdict)) return v.revised.trim() ? "revise" : "unsure";
  if (/^(통과|pass|verified|사실|일치)/i.test(verdict)) return "pass";
  return "unsure";
}
