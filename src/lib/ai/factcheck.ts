import "server-only";
import { z } from "zod";
import { prisma } from "../db";
import { parseDoc } from "../doc/doc";
import { applyFactCheck, factCheckTarget, withoutMarkers, type FactTarget } from "../doc/edit";
import { editSections } from "../section-edit";
import { buildMessages } from "./prompts";
import { chatJson } from "./tasks";

/* 팩트체크 — [확인 필요] 표시가 붙은 문장을 최신 자료로 판정·보완한다 */

const factSchema = z.object({
  verdict: z.string(),
  issue: z.string().default(""),
  reason: z.string().default(""),
  evidence: z
    .array(z.union([z.string().transform((source) => ({ source, date: "", url: "" })), z.object({ source: z.string().default(""), date: z.string().default(""), url: z.string().default("") })]))
    .default([]),
  revised: z.string().default(""),
});

export type FactCheckResult = {
  verdict: "pass" | "revise";
  issue: string;
  reason: string;
  evidence: { source: string; date: string; url: string }[];
  before: string;
  after: string;
  applied: boolean;
};

/**
 * 표시 하나를 최신 자료로 판정한다. 통과: 표시만 지운다. 보완: 문장을 근거에 맞게 고친 문장으로 바꾼다.
 * 원고 수정은 판정 전 읽은 문장이 그대로일 때만 — 바꾸기 전 원고는 버전(factcheck)으로 남는다.
 */
export async function factCheckMarker(projectId: string, sectionId: string, target: FactTarget): Promise<FactCheckResult> {
  const sec = await prisma.section.findFirst({
    where: { id: sectionId, chapter: { projectId } },
    select: { title: true, content: true, chapter: { select: { project: { select: { title: true } } } } },
  });
  if (!sec) throw Object.assign(new Error("절을 찾을 수 없습니다."), { status: 404 });
  const found = factCheckTarget(parseDoc(sec.content), target);
  if (!found) throw Object.assign(new Error("원고가 그사이 바뀌어 이 표시를 찾지 못했습니다."), { status: 409 });
  const { messages } = await buildMessages("factcheck", {
    today: new Date().toISOString().slice(0, 10),
    title: sec.chapter.project.title,
    sectionTitle: sec.title,
    paragraph: found.paragraph.slice(0, 3000),
    sentence: found.sentence,
  });
  const r = await chatJson(factSchema, { purpose: "factcheck", projectId, messages, temperature: null, maxTokens: 16000, webSearch: true });
  if (!r.value) throw Object.assign(new Error("팩트체크 응답을 해석하지 못했습니다. 다시 시도하세요."), { expose: true, httpStatus: 502 });
  const v = r.value;
  const clean = withoutMarkers(found.sentence);
  const revised = withoutMarkers(v.revised);
  const verdict = /보완|revise|fail/i.test(v.verdict) && revised ? "revise" : "pass";
  // 통과여도 AI가 판정 문구를 잘못 줬을 수 있으니, 보완 문장이 없으면 표시만 지운다
  const after = verdict === "revise" ? revised : clean;
  const changed = await editSections([sectionId], "factcheck", (doc) => applyFactCheck(doc, target, found.sentence, after));
  return {
    verdict,
    issue: v.issue.slice(0, 40),
    reason: v.reason.slice(0, 1000),
    evidence: v.evidence.filter((e) => e.source.trim()).slice(0, 5),
    before: clean,
    after,
    applied: changed.length > 0,
  };
}
