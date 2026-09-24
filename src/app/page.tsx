import { redirect } from "next/navigation";
import LoginForm from "@/components/LoginForm";

/** 첫 화면 — withbook 로고와 로그인 창만. 로컬 모드(로그인 없음)는 바로 프로젝트 선택 화면으로 */
export default function Home() {
  if (process.env.APP_ACCESS_MODE !== "web") redirect("/projects");
  return (
    <main className="flex min-h-screen items-center justify-center bg-stone-100 px-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-8 text-center font-bookhead text-5xl tracking-tight text-stone-900">
          with<span className="text-amber-700">book</span>
        </h1>
        <LoginForm />
      </div>
    </main>
  );
}
