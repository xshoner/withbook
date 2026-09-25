/**
 * AI 초안 ↔ 작가 수정본 비교 (순수 함수) — 작가 수정률 지표와 문체 학습 자료를 만든다.
 * 문장 단위 LCS: 바뀌지 않은 문장 글자 비율로 수정률을 잰다. 바뀐 구간은 (AI 문장들 → 작가 문장들) 짝으로 모은다.
 */

export function sentences(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((p) => p.split(/(?<=[.!?。…])\s+(?=\S)/))
    .map((s) => s.trim())
    .filter(Boolean);
}

export type EditPair = { ai: string; author: string };

export function editStats(aiText: string, authorText: string): { rate: number; pairs: EditPair[] } {
  const a = sentences(aiText);
  const b = sentences(authorText);
  const n = a.length;
  const m = b.length;
  const total = a.join("").length + b.join("").length;
  if (!total) return { rate: 0, pairs: [] };
  // LCS 표 (문장 수가 수백 개 수준이라 충분히 가볍다)
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let same = 0;
  const pairs: EditPair[] = [];
  let del: string[] = [];
  let add: string[] = [];
  const close = () => {
    if (del.length || add.length) pairs.push({ ai: del.join(" "), author: add.join(" ") });
    del = [];
    add = [];
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      close();
      same += a[i].length * 2;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) del.push(a[i++]);
    else add.push(b[j++]);
  }
  while (i < n) del.push(a[i++]);
  while (j < m) add.push(b[j++]);
  close();
  return { rate: Math.round((1 - same / total) * 1000) / 10, pairs };
}

/** 학습에 쓸 짝 고르기 — 표현을 고친 짝(양쪽 다 있고 길이가 비슷한 것)을 우선, 전체 글자 수 상한 */
export function pickLearningPairs(pairs: EditPair[], maxChars = 8000): EditPair[] {
  const rewrites = pairs.filter((p) => p.ai && p.author && p.ai.length >= 15 && p.author.length / p.ai.length > 0.4 && p.author.length / p.ai.length < 2.5);
  rewrites.sort((x, y) => y.ai.length + y.author.length - (x.ai.length + x.author.length));
  const out: EditPair[] = [];
  let len = 0;
  for (const p of rewrites) {
    const ai = p.ai.slice(0, 600);
    const author = p.author.slice(0, 600);
    if (len + ai.length + author.length > maxChars) continue;
    out.push({ ai, author });
    len += ai.length + author.length;
  }
  return out;
}
