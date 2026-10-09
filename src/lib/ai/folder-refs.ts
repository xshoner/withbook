/**
 * 내 폴더 자료 — 자동 집필에서 작가 PC의 폴더를 브라우저가 직접 읽어(서버에 올리지 않음) 절마다 가까운 대목만 집필 AI에 보낸다.
 * 여기는 순수 계산(조각 나누기·색인·고르기). 폴더 읽기는 components/editor/localFolder.ts.
 * 브라우저·서버·테스트 공용 (다른 앱 모듈을 불러오지 않는다).
 */

/** 읽는 파일 수 · 전체 글자 수 (넘으면 그만 읽는다) */
export const FOLDER_MAX_FILES = 300;
export const FOLDER_MAX_CHARS = 3_000_000;
/** 파일 하나 크기 */
export const FOLDER_MAX_BYTES = 30 * 1024 * 1024;
/** 조각 크기(자) · 절 하나에 보내는 조각 수 · 글자 수 (절 참고 자료 예산에 더해진다) */
export const FOLDER_CHUNK = 1500;
export const FOLDER_PICK_MAX = 6;
export const FOLDER_PROMPT_BUDGET = 8000;

export type FolderChunk = { file: string; part: number; text: string };
/** postings: 두 글자 조각 → 그 조각이 나오는 조각 번호들 */
export type FolderIndex = { chunks: FolderChunk[]; postings: Map<string, number[]> };

/** 글자·숫자로 된 낱말의 두 글자 조각 (한국어는 띄어쓰기 단위가 길어 낱말보다 잘 맞는다) */
function grams(s: string): string[] {
  const out: string[] = [];
  for (const w of s.toLowerCase().split(/[^\p{L}\p{N}]+/u)) for (let i = 0; i + 1 < w.length; i++) out.push(w.slice(i, i + 2));
  return out;
}

/** 문단 경계로 약 size자씩 나눈다 (긴 문단은 잘라서) */
export function chunkText(text: string, size = FOLDER_CHUNK): string[] {
  const out: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur) out.push(cur);
    cur = "";
  };
  for (let p of text.split(/\n+/)) {
    p = p.trim();
    if (!p) continue;
    while (p.length > size) {
      flush();
      out.push(p.slice(0, size));
      p = p.slice(size);
    }
    if (cur.length + p.length + 1 > size) flush();
    cur = cur ? `${cur}\n${p}` : p;
  }
  flush();
  return out;
}

export function buildFolderIndex(files: { name: string; text: string }[]): FolderIndex {
  const chunks: FolderChunk[] = [];
  const postings = new Map<string, number[]>();
  let total = 0;
  for (const f of files) {
    const text = f.text.replace(/\r\n?/g, "\n").replace(/[ \t ]+/g, " ").slice(0, Math.max(0, FOLDER_MAX_CHARS - total));
    total += text.length;
    chunkText(text).forEach((t, part) => {
      const i = chunks.push({ file: f.name, part, text: t }) - 1;
      // 파일 이름도 찾는 말에 넣는다 (예: '1장 사례.docx')
      for (const g of new Set(grams(`${f.name} ${t}`))) {
        const list = postings.get(g);
        if (list) list.push(i);
        else postings.set(g, [i]);
      }
    });
  }
  return { chunks, postings };
}

/**
 * 찾는 글(절 제목·요지·스케치)과 가까운 조각 — 드문 두 글자 조각이 많이 겹칠수록 높다(IDF).
 * 가장 높은 조각 점수의 30% 아래는 버린다(흔한 말만 겹치는 조각). 책 순서(파일·조각 순)로 돌려준다.
 */
export function pickFolderRefs(index: FolderIndex, query: string, budget = FOLDER_PROMPT_BUDGET): { name: string; text: string }[] {
  const n = index.chunks.length;
  if (!n || budget <= 0) return [];
  const tf = new Map<string, number>();
  for (const g of grams(query)) tf.set(g, (tf.get(g) ?? 0) + 1);
  const score = new Float64Array(n);
  for (const [g, k] of tf) {
    const list = index.postings.get(g);
    if (!list) continue;
    const idf = Math.log(1 + n / list.length);
    for (const i of list) score[i] += k * idf;
  }
  const ranked = [...score.keys()].filter((i) => score[i] > 0).sort((a, b) => score[b] - score[a]);
  const floor = score[ranked[0]] * 0.3;
  const picked: number[] = [];
  let used = 0;
  for (const i of ranked) {
    if (score[i] < floor || picked.length >= FOLDER_PICK_MAX || used >= budget) break;
    picked.push(i);
    used += index.chunks[i].text.length;
  }
  const parts = (file: string) => index.chunks.filter((c) => c.file === file).length;
  return picked
    .sort((a, b) => a - b)
    .map((i) => {
      const c = index.chunks[i];
      return { name: `내 폴더 · ${c.file}${parts(c.file) > 1 ? ` (${c.part + 1}번째 대목)` : ""}`, text: c.text };
    });
}
