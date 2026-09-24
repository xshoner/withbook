import "server-only";
import fs from "node:fs";
import path from "node:path";
import { getSetting } from "../app-settings";

/** prompts/ 폴더의 템플릿과 instruction.md를 mtime 기준으로 캐시해 읽는다 */
const cache = new Map<string, { mtime: number; text: string }>();

function readCached(file: string): string {
  const stat = fs.statSync(file);
  const hit = cache.get(file);
  if (hit && hit.mtime === stat.mtimeMs) return hit.text;
  const text = fs.readFileSync(file, "utf8");
  cache.set(file, { mtime: stat.mtimeMs, text });
  return text;
}

export function instructionPath() {
  return path.resolve(/* turbopackIgnore: true */ process.cwd(), process.env.INSTRUCTION_PATH ?? "./instruction.md");
}

/** 서술 규칙 — 앱에서 저장한 값(DB)이 있으면 그것, 없으면 instruction.md 파일 */
export async function loadInstruction(): Promise<string> {
  const saved = await getSetting<string>("instruction");
  if (typeof saved === "string" && saved.trim()) return saved;
  try {
    return readCached(instructionPath());
  } catch {
    return "";
  }
}

export function loadPrompt(name: string, part: "system" | "user"): string {
  return readCached(path.resolve(process.cwd(), "prompts", `${name}.${part}.md`));
}

/** {{var}} 치환 + {{#if flag}}…{{else}}…{{/if}} (중첩 없음). 빈 값은 "(없음)" */
export function render(tpl: string, vars: Record<string, unknown>): string {
  let out = tpl.replace(/\{\{#if (\w+)\}\}([\s\S]*?)(?:\{\{else\}\}([\s\S]*?))?\{\{\/if\}\}/g, (_, k, a, b) =>
    vars[k] ? a : (b ?? ""),
  );
  out = out.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    const v = vars[k];
    if (v === undefined || v === null || (typeof v === "string" && !v.trim())) return "(없음)";
    return typeof v === "string" ? v : typeof v === "number" ? String(v) : JSON.stringify(v, null, 2);
  });
  return out;
}

export async function buildMessages(name: string, vars: Record<string, unknown>) {
  const instruction = await loadInstruction();
  const all = { ...vars, instruction_md: instruction };
  const system = render(loadPrompt(name, "system"), all);
  const user = render(loadPrompt(name, "user"), all);
  return {
    messages: [
      { role: "system" as const, content: system },
      { role: "user" as const, content: user },
    ],
    instructionIncluded: instruction.length > 0 && system.includes(instruction),
  };
}
