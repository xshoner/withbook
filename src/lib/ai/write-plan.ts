/** Conservative initial limits: retain reasoning headroom and the existing 32k cap. */
export const MAX_SINGLE_WRITE_CHARS = 5000;
export const writeTokens = (chars: number) => Math.min(Math.round(chars * 2.2 + 6000), 32000);
export function singleWriteLimit(maxOutputTokens = 32000) {
  return Math.max(300, Math.min(MAX_SINGLE_WRITE_CHARS, Math.floor((Math.min(maxOutputTokens, 32000) * 0.9 - 6000) / 2.2)));
}
export type WritePart = { heading: string; points: string[]; sketchItems: string[]; chars: number; continuation?: boolean };

/** Scale the outline to the requested length, split oversized parts and pack adjacent ones. */
export function groupWriteParts(parts: WritePart[], targetChars: number, limit: number): WritePart[][] {
  const safeLimit = Math.max(300, Math.floor(limit));
  const input = parts.length ? parts : [{ heading: "", points: [], sketchItems: [], chars: targetChars }];
  const weight = input.reduce((sum, p) => sum + (Number.isFinite(p.chars) && p.chars > 0 ? p.chars : 1), 0);
  const pieces: WritePart[] = [];
  let cumulativeWeight = 0;
  let allocated = 0;
  input.forEach((part, index) => {
    cumulativeWeight += Number.isFinite(part.chars) && part.chars > 0 ? part.chars : 1;
    const boundary = index === input.length - 1 ? targetChars : Math.floor(targetChars * cumulativeWeight / weight);
    const chars = boundary - allocated;
    allocated += chars;
    const count = Math.max(1, Math.ceil(chars / safeLimit));
    for (let i = 0; i < count; i++) {
      const divide = (items: string[]) => items.slice(Math.floor(i * items.length / count), Math.floor((i + 1) * items.length / count));
      pieces.push({ ...part, heading: i === 0 ? part.heading : "", continuation: i > 0,
        points: divide(part.points), sketchItems: divide(part.sketchItems),
        chars: Math.floor(chars / count) + (i < chars % count ? 1 : 0),
      });
    }
  });
  const groups: WritePart[][] = [];
  for (const part of pieces) {
    const last = groups.at(-1);
    if (last && last.reduce((sum, p) => sum + p.chars, 0) + part.chars <= safeLimit) last.push(part);
    else groups.push([part]);
  }
  return groups;
}
