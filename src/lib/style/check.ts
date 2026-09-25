/**
 * 문체 점검 (규칙 기반, AI 없음) — 종결어미 체계, 반복 표현, 접속부사 과다, 문단 안 같은 단어 반복.
 * 순수 함수 (테스트가 확장자 없이 불러오도록 값 import를 두지 않는다).
 * paragraphs[i]는 textblocks()의 i번째 블록 텍스트 — 문단 번호(1부터)가 편집기 위치와 맞아야 한다. 제목 블록은 ""로 넘긴다.
 */

export type StyleInput = {
  sectionId: string;
  label: string;
  title: string;
  paragraphs: string[];
}[];
export type Ending = "da" | "yo" | "sumnida" | "other";
export type Counts = Record<Ending, number>;
export type Loc = { sectionId: string; paragraph: number; text: string };

export type StyleReport = {
  sections: {
    sectionId: string;
    label: string;
    title: string;
    counts: Counts;
  }[];
  endings: {
    dominant: Exclude<Ending, "other"> | null;
    total: Counts;
    mismatchTotal: number;
    mismatches: {
      sectionId: string;
      label: string;
      title: string;
      items: {
        paragraph: number;
        sentence: string;
        style: Ending;
        text: string;
      }[];
    }[];
  };
  sentenceTotal: number;
  repeats: { gram: string; n: number; count: number; locations: Loc[] }[];
  connectives: {
    word: string;
    count: number;
    perThousand: number;
    flagged: boolean;
    locations: Loc[];
  }[];
  inParagraph: {
    sectionId: string;
    label: string;
    title: string;
    paragraph: number;
    word: string;
    count: number;
    text: string;
  }[];
};

const MISMATCH_CAP = 200;
const TOP_GRAMS = 20;
const GRAM_MIN = 3;
const LOC_CAP = 5;
const IN_PARA_CAP = 50;
const IN_PARA_MIN = 3;
const CONN_THRESHOLD = 30; // 1,000문장당
const CONN_MIN = 5;
const SHORT = 5;

const FILL = "";
const OPEN: Record<string, string> = { "“": "”", "‘": "’", '"': '"' };

/** 따옴표 안(대화·인용)을 같은 길이의 채움 문자로 가린다 — 위치는 그대로 */
export function maskQuotes(t: string): string {
  const out = t.split("");
  let i = 0;
  while (i < t.length) {
    const close = OPEN[t[i]];
    if (close) {
      const end = t.indexOf(close, i + 1);
      if (end > 0) {
        for (let k = i; k <= end; k++) out[k] = FILL;
        i = end + 1;
        continue;
      }
    }
    i++;
  }
  return out.join("");
}

const ENDER = /[.!?…]/;
const CLOSER = /[)\]'"’”」』》〉]/;

/** 문장 나누기 — [시작, 끝) 오프셋 목록 */
export function splitSentences(t: string): [number, number][] {
  const out: [number, number][] = [];
  let start = 0;
  let i = 0;
  const push = (end: number) => {
    const s = t.slice(start, end);
    const lead = s.length - s.trimStart().length;
    if (s.trim()) out.push([start + lead, start + s.trimEnd().length]);
    start = end;
  };
  while (i < t.length) {
    if (t[i] === "\n") {
      push(i);
      i++;
      start = i;
      continue;
    }
    if (ENDER.test(t[i])) {
      let j = i + 1;
      while (j < t.length && (ENDER.test(t[j]) || CLOSER.test(t[j]))) j++;
      if (j >= t.length || /\s/.test(t[j])) {
        push(j);
        i = j;
        continue;
      }
      i = j;
      continue;
    }
    i++;
  }
  push(t.length);
  return out;
}

/** 문장 끝 어미 분류 (가린 문장 기준) */
export function classifyEnding(masked: string): Ending {
  // 문장 끝의 [확인 필요]·[이미지 제안: …] 표시는 어미가 아니다 ("필요]."를 '-요'로 세지 않게)
  const unmarked = masked.replace(/\s*\[(확인 필요|이미지 제안)[^\]]*\]/g, "");
  const core = unmarked.replace(new RegExp(`[\\s.!?…,~\\-)\\]'"’”」』》〉${FILL}]+$`, "u"), "");
  if (!core) return "other";
  const last = core[core.length - 1];
  const prev = core[core.length - 2] ?? "";
  // '-니다'체는 받침 ㅂ 뒤의 '니다'(합니다·입니다·습니다)만 — '아니다'는 '-다'체
  const beforeNi = core[core.length - 3] ?? "";
  const code = beforeNi.charCodeAt(0) - 0xac00;
  const formal = prev === "니" && code >= 0 && code < 11172 && code % 28 === 17;
  if (last === "다") return formal ? "sumnida" : "da";
  if (last === "까" && formal) return "sumnida";
  if (last === "요" || last === "죠") return "yo";
  return "other";
}

const PARTICLES = [
  "에서는",
  "으로는",
  "에게서",
  "이라는",
  "이라고",
  "까지는",
  "부터는",
  "에서",
  "에게",
  "으로",
  "까지",
  "부터",
  "보다",
  "처럼",
  "마저",
  "조차",
  "라는",
  "라고",
  "이나",
  "이다",
  "에는",
  "와의",
  "과의",
  "로는",
  "하고",
  "을",
  "를",
  "이",
  "가",
  "은",
  "는",
  "의",
  "에",
  "로",
  "와",
  "과",
  "도",
  "만",
  "나",
];

const STOP = new Set(
  (
    "것 수 등 및 때 중 더 또 그 이 저 나 너 우리 저희 그녀 그들 자신 " +
    "것은 것을 것이 것이다 것도 것과 것으로 것에 것처럼 수도 수가 수는 때문 때문에 때는 때도 " +
    "있다 있는 있고 있어 있을 있으며 있었다 있습니다 있어요 없다 없는 없고 없이 없었다 " +
    "하다 한다 하는 하고 하여 해서 했다 했고 한 할 합니다 해요 된다 되는 되고 되어 됐다 된 될 " +
    "아니다 아닌 않는다 않고 않은 않는 않아 않았다 않습니다 이다 였다 이었다 입니다 이며 " +
    "그리고 하지만 그러나 또한 즉 결국 사실 물론 게다가 따라서 그래서 그런데 " +
    "매우 가장 아주 너무 정말 모든 어떤 이런 그런 저런 이것 그것 저것 여기 거기 " +
    "경우 위해 위한 통해 대한 대해 같은 같이 같다 정도 다른 많은 많이 가지 우리는 우리가 우리의 " +
    "지금 이제 다시 바로 먼저 하나 두 세"
  ).split(/\s+/),
);

const norm = (w: string) => w.replace(/[^\p{L}\p{N}]/gu, "");

/** 어절에서 흔한 조사 떼기 (남은 말이 2글자 이상일 때만) */
export function stem(w: string): string {
  for (const p of PARTICLES) if (w.endsWith(p) && w.length - p.length >= 2) return w.slice(0, -p.length);
  return w;
}

const CONNECTIVES: [string, string[]][] = [
  ["그리고", ["그리고"]],
  ["하지만", ["하지만"]],
  ["그러나", ["그러나"]],
  ["또한", ["또한"]],
  ["즉", ["즉"]],
  ["결국", ["결국", "결국은"]],
  ["사실", ["사실", "사실은"]],
  ["물론", ["물론"]],
  ["게다가", ["게다가"]],
  ["따라서", ["따라서"]],
];
const CONN_OF = new Map<string, string>();
for (const [w, forms] of CONNECTIVES) for (const f of forms) CONN_OF.set(f, w);

const snip = (s: string, n = 40) => (s.length > n ? s.slice(0, n) : s);
const zero = (): Counts => ({ da: 0, yo: 0, sumnida: 0, other: 0 });

export function checkStyle(input: StyleInput): StyleReport {
  const total = zero();
  const sections: StyleReport["sections"] = [];
  const classified: {
    sec: StyleInput[number];
    paragraph: number;
    sentence: string;
    style: Ending;
  }[] = [];
  const grams = new Map<string, { n: number; count: number; locations: Loc[] }>();
  const conn = new Map<string, { count: number; locations: Loc[] }>();
  const inParagraph: StyleReport["inParagraph"] = [];
  let sentenceTotal = 0;

  for (const sec of input) {
    const counts = zero();
    sec.paragraphs.forEach((text, idx) => {
      if (!text.trim()) return;
      const paragraph = idx + 1;
      const loc = (t: string): Loc => ({
        sectionId: sec.sectionId,
        paragraph,
        text: snip(t),
      });

      // 1. 종결어미
      const masked = maskQuotes(text);
      for (const [s, e] of splitSentences(masked)) {
        const m = masked.slice(s, e);
        if (m.replace(new RegExp(FILL, "g"), "").trim()) sentenceTotal++;
        if (m.replace(/[\s.!?…,]/g, "").length < SHORT) continue;
        const style = classifyEnding(m);
        counts[style]++;
        total[style]++;
        if (style !== "other")
          classified.push({
            sec,
            paragraph,
            sentence: text.slice(s, e),
            style,
          });
      }

      // 2. 반복 표현 (문장을 넘지 않는 어절 2·3-gram) · 접속부사
      const words = text.split(/\s+/).filter(Boolean);
      const keys = words.map(norm);
      for (let i = 0; i < words.length; i++) {
        const c = CONN_OF.get(keys[i]);
        if (c) {
          const r = conn.get(c) ?? { count: 0, locations: [] };
          r.count++;
          if (r.locations.length < LOC_CAP) r.locations.push(loc(words[i]));
          conn.set(c, r);
        }
        for (const n of [2, 3]) {
          if (i + n > words.length) continue;
          const ks = keys.slice(i, i + n);
          if (ks.some((k) => !k)) continue;
          // 문장 끝 어절 뒤로는 잇지 않는다
          if (words.slice(i, i + n - 1).some((w) => /[.!?…]["'’”)]*$/.test(w))) continue;
          if (ks.every((k) => STOP.has(k) || STOP.has(stem(k)))) continue;
          const g = ks.join(" ");
          const r = grams.get(g) ?? { n, count: 0, locations: [] };
          r.count++;
          if (r.locations.length < LOC_CAP) r.locations.push(loc(words.slice(i, i + n).join(" ")));
          grams.set(g, r);
        }
      }

      // 3. 문단 안 같은 단어 반복
      const byStem = new Map<string, { count: number; first: string }>();
      for (let i = 0; i < words.length; i++) {
        const k = keys[i];
        if (k.length < 2 || STOP.has(k) || /^\p{N}+$/u.test(k)) continue;
        const st = stem(k);
        if (st.length < 2 || STOP.has(st)) continue;
        const r = byStem.get(st) ?? { count: 0, first: words[i] };
        r.count++;
        byStem.set(st, r);
      }
      for (const [word, r] of byStem)
        if (r.count >= IN_PARA_MIN && inParagraph.length < IN_PARA_CAP)
          inParagraph.push({
            sectionId: sec.sectionId,
            label: sec.label,
            title: sec.title,
            paragraph,
            word,
            count: r.count,
            text: snip(r.first),
          });
    });
    sections.push({
      sectionId: sec.sectionId,
      label: sec.label,
      title: sec.title,
      counts,
    });
  }

  // 책 전체 우세 어미
  const cand = (["da", "yo", "sumnida"] as const).filter((k) => total[k] > 0).sort((a, b) => total[b] - total[a]);
  const dominant = cand[0] ?? null;
  const mm = new Map<string, StyleReport["endings"]["mismatches"][number]>();
  let mismatchTotal = 0;
  if (dominant)
    for (const c of classified) {
      if (c.style === dominant) continue;
      mismatchTotal++;
      if (mismatchTotal > MISMATCH_CAP) continue;
      const g = mm.get(c.sec.sectionId) ?? {
        sectionId: c.sec.sectionId,
        label: c.sec.label,
        title: c.sec.title,
        items: [],
      };
      g.items.push({
        paragraph: c.paragraph,
        sentence: c.sentence,
        style: c.style,
        text: snip(c.sentence),
      });
      mm.set(c.sec.sectionId, g);
    }

  // 반복 표현 상위 — 같은 횟수의 3-gram에 들어 있는 2-gram은 뺀다
  const sorted = [...grams.entries()].filter(([, r]) => r.count >= GRAM_MIN).sort((a, b) => b[1].count - a[1].count || b[1].n - a[1].n);
  const repeats: StyleReport["repeats"] = [];
  for (const [gram, r] of sorted) {
    if (repeats.length >= TOP_GRAMS) break;
    if (r.n === 2 && repeats.some((x) => x.n === 3 && x.count === r.count && ` ${x.gram} `.includes(` ${gram} `))) continue;
    repeats.push({ gram, n: r.n, count: r.count, locations: r.locations });
  }

  const per = (n: number) => (sentenceTotal ? Math.round((n * 10000) / sentenceTotal) / 10 : 0);
  const connectives = CONNECTIVES.map(([word]) => conn.get(word) && { word, ...conn.get(word)! })
    .filter((x): x is { word: string; count: number; locations: Loc[] } => !!x)
    .map((x) => ({
      ...x,
      perThousand: per(x.count),
      flagged: x.count >= CONN_MIN && per(x.count) > CONN_THRESHOLD,
    }))
    .sort((a, b) => b.count - a.count);

  return {
    sections,
    endings: { dominant, total, mismatchTotal, mismatches: [...mm.values()] },
    sentenceTotal,
    repeats,
    connectives,
    inParagraph,
  };
}
