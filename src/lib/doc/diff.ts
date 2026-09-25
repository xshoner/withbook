/**
 * 문장·글자 단위 비교 — 버전 비교, 새 버전 후보 vs 현재 본문.
 * 순수 함수 (테스트가 확장자 없이 불러오도록 값 import를 두지 않는다).
 */

export type WordDiff = { type: "same" | "add" | "del"; text: string };
export type ParaDiffRow = { type: "same" | "add" | "del"; text: string } | { type: "change"; before: string; after: string; words: WordDiff[] };

const MAX_TOKENS = 3000;

/** 어절 · 공백 · 문장부호(한 글자씩)로 쪼갠다 — 이어 붙이면 원문 그대로 */
export function tokenize(s: string): string[] {
  return s.match(/\s+|[\p{L}\p{N}\p{M}_]+|[^\s\p{L}\p{N}\p{M}_]/gu) ?? [];
}

/** 같은 종류끼리 붙이고, 바뀐 곳 사이에 낀 공백은 양쪽 바뀜에 흡수해 del→add 순으로 정리 */
function tidy(parts: WordDiff[]): WordDiff[] {
  const src = parts.filter((p) => p.text);
  // 바뀜 사이의 공백만 있는 same → del+add
  const exp: WordDiff[] = [];
  src.forEach((p, i) => {
    if (p.type === "same" && !p.text.trim() && i > 0 && i < src.length - 1 && src[i - 1].type !== "same" && src[i + 1].type !== "same") {
      exp.push({ type: "del", text: p.text }, { type: "add", text: p.text });
    } else exp.push(p);
  });
  const out: WordDiff[] = [];
  let del = "";
  let add = "";
  const flush = () => {
    if (del) out.push({ type: "del", text: del });
    if (add) out.push({ type: "add", text: add });
    del = add = "";
  };
  for (const p of exp) {
    if (p.type === "del") del += p.text;
    else if (p.type === "add") add += p.text;
    else {
      flush();
      const last = out[out.length - 1];
      if (last?.type === "same") last.text += p.text;
      else out.push({ type: "same", text: p.text });
    }
  }
  flush();
  return out;
}

/** 어절 단위 LCS diff. 토큰이 너무 많으면 통째로 del+add */
export function diffWords(a: string, b: string): WordDiff[] {
  if (a === b) return a ? [{ type: "same", text: a }] : [];
  const ta = tokenize(a);
  const tb = tokenize(b);
  // 앞뒤 공통 부분은 LCS에서 뺀다
  let p = 0;
  while (p < ta.length && p < tb.length && ta[p] === tb[p]) p++;
  let s = 0;
  while (s < ta.length - p && s < tb.length - p && ta[ta.length - 1 - s] === tb[tb.length - 1 - s]) s++;
  const head = ta.slice(0, p).join("");
  const tail = ta.slice(ta.length - s).join("");
  const xa = ta.slice(p, ta.length - s);
  const xb = tb.slice(p, tb.length - s);
  const parts: WordDiff[] = [{ type: "same", text: head }];
  if (xa.length > MAX_TOKENS || xb.length > MAX_TOKENS) {
    parts.push({ type: "del", text: xa.join("") }, { type: "add", text: xb.join("") });
  } else {
    const n = xa.length;
    const m = xb.length;
    const w = m + 1;
    const dp = new Uint16Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i * w + j] = xa[i] === xb[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (xa[i] === xb[j]) {
        parts.push({ type: "same", text: xa[i] });
        i++;
        j++;
      } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) parts.push({ type: "del", text: xa[i++] });
      else parts.push({ type: "add", text: xb[j++] });
    }
    while (i < n) parts.push({ type: "del", text: xa[i++] });
    while (j < m) parts.push({ type: "add", text: xb[j++] });
  }
  parts.push({ type: "same", text: tail });
  return tidy(parts);
}

/** 두 문단이 같은 문단을 고친 것인지 — 겹치는 어절 비율(0~1) */
export function similarity(a: string, b: string): number {
  const wa = tokenize(a).filter((t) => t.trim());
  const wb = tokenize(b).filter((t) => t.trim());
  if (!wa.length || !wb.length) return 0;
  const bag = new Map<string, number>();
  for (const t of wa) bag.set(t, (bag.get(t) ?? 0) + 1);
  let shared = 0;
  for (const t of wb) {
    const c = bag.get(t);
    if (c) {
      shared++;
      bag.set(t, c - 1);
    }
  }
  return (2 * shared) / (wa.length + wb.length);
}

const PAIR_MIN = 0.3;

/** 문단 LCS 후, 이어진 del/add 묶음에서 비슷한 문단끼리 change로 짝짓는다 */
export function diffDocParagraphs(a: string[], b: string[]): ParaDiffRow[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const rows: { type: "same" | "add" | "del"; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: "same", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) rows.push({ type: "del", text: a[i++] });
    else rows.push({ type: "add", text: b[j++] });
  }
  while (i < n) rows.push({ type: "del", text: a[i++] });
  while (j < m) rows.push({ type: "add", text: b[j++] });

  const out: ParaDiffRow[] = [];
  let k = 0;
  while (k < rows.length) {
    if (rows[k].type === "same") {
      out.push(rows[k++]);
      continue;
    }
    // same이 나올 때까지의 바뀜 묶음
    const dels: string[] = [];
    const adds: string[] = [];
    while (k < rows.length && rows[k].type !== "same") (rows[k].type === "del" ? dels : adds).push(rows[k++].text);
    let q = 0;
    for (const d of dels) {
      let hit = -1;
      for (let x = q; x < adds.length; x++)
        if (similarity(d, adds[x]) >= PAIR_MIN) {
          hit = x;
          break;
        }
      if (hit < 0) {
        out.push({ type: "del", text: d });
        continue;
      }
      while (q < hit) out.push({ type: "add", text: adds[q++] });
      out.push({
        type: "change",
        before: d,
        after: adds[hit],
        words: diffWords(d, adds[hit]),
      });
      q = hit + 1;
    }
    while (q < adds.length) out.push({ type: "add", text: adds[q++] });
  }
  return out;
}
