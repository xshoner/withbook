/**
 * AI 응답에서 JSON 객체 하나를 뽑아낸다.
 * 후보 순서: ```json 코드 블록 → 본문 전체 → 괄호 짝이 맞는 { … } 구간(문자열·이스케이프 안의 괄호는 무시). 처음 파싱되는 객체를 돌려준다.
 */
export function extractJson(text: string): any {
  const candidates: string[] = [];
  for (const m of text.matchAll(/```[ \t]*(?:json|JSON)?[ \t]*\r?\n?([\s\S]*?)```/g)) candidates.push(m[1].trim());
  candidates.push(text.trim());
  for (const src of [...candidates]) candidates.push(...balancedObjects(src));
  // 예전 방식: 첫 { ~ 마지막 }
  const cleaned = text.replace(/```(?:json)?/g, "");
  const s = cleaned.indexOf("{");
  const e = cleaned.lastIndexOf("}");
  if (s >= 0 && e > s) candidates.push(cleaned.slice(s, e + 1));
  for (const c of candidates) {
    if (!c.startsWith("{")) continue;
    try {
      const v = JSON.parse(c);
      if (v && typeof v === "object" && !Array.isArray(v)) return v;
    } catch {}
  }
  throw new Error("JSON을 찾을 수 없습니다.");
}

/** 최상위 { … } 구간들 (큰 것부터) */
function balancedObjects(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      if (depth > 0) inStr = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(s.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out.sort((a, b) => b.length - a.length);
}
