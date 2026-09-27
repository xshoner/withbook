/**
 * 본문 그림 [직접 만들기] 프롬프트 — 서버(그림 생성)와 편집기(프롬프트 안 표시)가 같이 쓴다 (순수 함수).
 * 표지 디자인 AI와 같은 연결(Images API)로 그린다. 받은 그림은 원고 이미지로 저장해 본문 폭에 맞춰 넣는다.
 */

export type FigureStyle = "diagram" | "infographic" | "illustration" | "photo";

export const FIGURE_STYLES: { v: FigureStyle; label: string; en: string }[] = [
  { v: "diagram", label: "개념 도식", en: "a clean conceptual diagram (boxes, arrows, flow) that explains the idea at a glance" },
  { v: "infographic", label: "그래프·인포그래픽", en: "a clear data-style infographic or chart that visualises the trend, comparison or numbers described" },
  { v: "illustration", label: "삽화", en: "an editorial book illustration with a calm, restrained palette" },
  { v: "photo", label: "사진풍", en: "a realistic documentary-style photograph" },
];

export type FigurePromptInput = {
  bookTitle: string;
  sectionTitle: string;
  paragraph: string;
  style: FigureStyle;
  instruction: string;
  /** 그림 안에 짧은 한글 라벨을 허용 (끄면 글자 없이 — 캡션은 본문에서 붙는다) */
  withText: boolean;
};

export function buildFigurePrompt(x: FigurePromptInput): string {
  const style = FIGURE_STYLES.find((s) => s.v === x.style) ?? FIGURE_STYLES[0];
  const lines = [
    `You are a professional book figure designer. Create ${style.en} to be printed inside a Korean non-fiction book (A5 page, body text width about 110 mm).`,
    `Book: 『${x.bookTitle}』 · Section: ${x.sectionTitle}`,
    "",
    "Illustrate exactly what this passage explains:",
    `"""${x.paragraph.slice(0, 1200)}"""`,
    "",
    "Requirements:",
    "- Plain white background, generous margins, one clear focal composition that reads well in print at small size.",
    "- Accurate to the passage — do not invent facts, numbers or data not stated in it.",
    x.withText
      ? "- Short labels are allowed; write them in correct Korean (Hangul), large and legible. Keep text to a minimum."
      : "- No text, letters, numbers, labels, captions or watermarks anywhere in the image (the caption is added by the book).",
    "- No page borders, frames, logos or signatures.",
  ];
  if (x.instruction.trim()) lines.push("", `Author's additional direction: ${x.instruction.trim().slice(0, 600)}`);
  return lines.join("\n");
}

export type FigureAspect = "landscape" | "portrait" | "square";
export const FIGURE_ASPECTS: { v: FigureAspect; label: string; size: string }[] = [
  { v: "landscape", label: "가로", size: "1536x1024" },
  { v: "portrait", label: "세로", size: "1024x1536" },
  { v: "square", label: "정사각", size: "1024x1024" },
];

/** 요청 크기 — "auto"면 비율의 기본 크기, 아니면 가로x세로(256~4096, 16의 배수로) */
export function figureRequestSize(aspect: FigureAspect, custom = "auto"): string {
  const base = (FIGURE_ASPECTS.find((a) => a.v === aspect) ?? FIGURE_ASPECTS[0]).size;
  const m = /^(\d{3,4})\s*[x×]\s*(\d{3,4})$/i.exec(custom.trim());
  if (!m) return base;
  const fit = (n: number) => Math.min(4096, Math.max(256, Math.round(n / 16) * 16));
  return `${fit(Number(m[1]))}x${fit(Number(m[2]))}`;
}

/** 모델이 크기를 거부하면 다시 요청할 크기 */
export const figureFallbackSize = (aspect: FigureAspect) => (aspect === "portrait" ? "1024x1536" : aspect === "square" ? "1024x1024" : "1536x1024");
