import type { LayoutSettings } from "@/lib/layout";

export type TreeSection = {
  id: string;
  title: string;
  order: number;
  gist: string;
  hook: string;
  targetPages: number;
  status: string;
  charCount: number;
  updatedAt: string;
};
export type TreeChapter = { id: string; title: string; order: number; kind: "front" | "body" | "back"; promise: string; sections: TreeSection[] };
export type ProjectTree = {
  id: string;
  title: string;
  subtitle: string;
  author: string;
  targetPages: number;
  charsPerPage: number;
  styleProfile: string | null;
  layout: LayoutSettings;
  chapters: TreeChapter[];
  glossary: { id: string; term: string; preferred: string; note: string }[];
  _count: { tocReports: number };
};

export type SectionPageInfo = {
  start: number;
  end: number;
  startIdx: number;
  endIdx: number;
  side: "left" | "right";
  pages: number;
  startFrac: number;
  chars: number;
  fig: number;
};
export type PagedInfo = {
  total: number;
  bodyStart: number;
  /** 쪽 번호가 보이기 시작하는 면(머리말, 없으면 본문 시작) — 쪽 번호 = 면 번호 (예전 조판 결과에는 없다) */
  numStart?: number;
  fontOk: boolean;
  /** 조판 중 불러오지 못한 그림 수 (예전 조판 결과에는 없다) */
  missingImages?: number;
  sections: Record<string, SectionPageInfo>;
  chapters: Record<string, { start: number }>;
  pages: { i: number; n: number; side: string; blank: boolean }[];
};
