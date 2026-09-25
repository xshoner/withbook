"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import BookInfoForm, { EMPTY_INFO } from "@/components/BookInfoForm";
import { api } from "@/lib/client";
import { toast, toastError } from "@/components/ui/feedback";

export default function NewProject() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <Link href="/projects" className="btn-ghost mb-4">
        ← 프로젝트 목록
      </Link>
      <h1 className="font-bookhead text-2xl">새 프로젝트</h1>
      <p className="mb-6 mt-1 text-sm text-stone-500">
        책 정보를 입력하면 AI가 해당 분야 전문가 관점에서 목차를 설계해 보고합니다. 판형은 부크크 A5(148×210mm)로 고정됩니다.
      </p>
      <div className="card p-6">
        <BookInfoForm
          initial={EMPTY_INFO}
          busy={busy}
          submitLabel="프로젝트 만들고 목차 설계하기 →"
          onSubmit={async (v) => {
            setBusy(true);
            try {
              const r = await api<{ id: string }>("/api/projects", { method: "POST", json: v });
              router.push(`/projects/${r.id}/toc?auto=1`);
            } catch (e: any) {
              toastError(e);
              setBusy(false);
            }
          }}
        />
      </div>
    </main>
  );
}
