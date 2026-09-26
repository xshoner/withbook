"use client";

import { useParams } from "next/navigation";
import CoverEditor from "@/components/cover/CoverEditor";

/** 커버 디자인 에디터 — 편집 화면 상단 [커버 디자인]이 새 창으로 연다 */
export default function CoverPage() {
  const { id } = useParams<{ id: string }>();
  return <CoverEditor projectId={id} />;
}
