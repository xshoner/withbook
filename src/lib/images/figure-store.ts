import "server-only";
import sharp from "sharp";
import { prisma } from "../db";
import { getSetting, setSetting } from "../app-settings";
import { editImage, generateImage } from "../ai/image";
import { saveProjectImage } from "../assets";
import { readProjectAsset } from "../cover/image-store";
import { removeObjects } from "../storage";
import { buildFigurePrompt, figureFallbackSize, figureRequestSize, type FigureAspect, type FigurePromptInput } from "./figure-prompt";

/**
 * 본문 그림 [직접 만들기] — 표지 디자인 AI와 같은 연결로 그리고, 원고 이미지로 저장한다.
 * 절마다 [만든 그림] 기록을 AppSetting `figure-ai:{절 id}`에 두어(최근 20장) 새로 고친 뒤에도 다시 넣거나 지울 수 있다.
 */
export type MadeFigure = { assetId: string; src: string; widthPx: number; heightPx: number; prompt: string; paragraph: string; at: string; edit?: boolean };

const key = (sectionId: string) => `figure-ai:${sectionId}`;
const MAX_HISTORY = 20;

export async function loadFigureHistory(sectionId: string): Promise<MadeFigure[]> {
  return (await getSetting<MadeFigure[]>(key(sectionId), { fresh: true })) ?? [];
}

async function sectionProject(sectionId: string) {
  const sec = await prisma.section.findUnique({
    where: { id: sectionId },
    select: { title: true, chapter: { select: { project: { select: { id: true, title: true, deletedAt: true } } } } },
  });
  const project = sec?.chapter.project;
  if (!sec || !project || project.deletedAt) throw Object.assign(new Error("절을 찾을 수 없습니다."), { status: 404 });
  return { title: sec.title, project };
}

export type MakeInput = Omit<FigurePromptInput, "bookTitle" | "sectionTitle"> & { aspect: FigureAspect; requestSize?: string };

/** 새로 그리기, 또는 editOf(이 절에서 만든 그림)를 editPrompt대로 고치기 */
export async function makeFigure(sectionId: string, input: MakeInput & { editOf?: string; editPrompt?: string; customPrompt?: string }, signal?: AbortSignal) {
  const { title, project } = await sectionProject(sectionId);
  const size = figureRequestSize(input.aspect, input.requestSize);
  const fallbackSize = figureFallbackSize(input.aspect);
  let buffer: Buffer;
  let prompt: string;
  if (input.editOf) {
    const history = await loadFigureHistory(sectionId);
    if (!history.some((h) => h.assetId === input.editOf)) throw Object.assign(new Error("이 절에서 만든 그림만 고칠 수 있습니다."), { status: 400 });
    const editPrompt = (input.editPrompt ?? "").trim();
    if (!editPrompt) throw Object.assign(new Error("무엇을 고칠지 적어 주세요."), { status: 400 });
    const src = await readProjectAsset(project.id, input.editOf);
    prompt = `Edit this book figure. Keep everything else exactly as it is and change only this: ${editPrompt.slice(0, 800)}${input.withText ? "" : "\nDo not add any text, letters or numbers."}`;
    const gen = await editImage({
      prompt,
      size,
      fallbackSize,
      projectId: project.id,
      signal,
      purpose: "figure",
      edit: {
        prepare: async (sz) => {
          const [w, h] = sz.split("x").map(Number);
          // 비율이 달라도 그림이 늘어나지 않게 흰 여백으로 맞춘다
          return { image: await sharp(src.buffer).resize(w, h, { fit: "contain", background: "#ffffff" }).png().toBuffer() };
        },
      },
    });
    buffer = gen.buffer;
  } else {
    if (input.paragraph.trim().length < 10) throw Object.assign(new Error("그림으로 만들 문단을 고르세요(본문에서 문단을 클릭)."), { status: 400 });
    // 작가가 프롬프트 안을 직접 고쳤으면 그 글을 그대로 보낸다
    prompt = input.customPrompt?.trim() || buildFigurePrompt({ ...input, bookTitle: project.title, sectionTitle: title });
    buffer = (await generateImage({ prompt, size, fallbackSize, projectId: project.id, signal, purpose: "figure" })).buffer;
  }
  // 흰 바탕으로 굳혀 인쇄용 JPEG (투명 PNG가 인쇄에서 검게 나오지 않게)
  const jpeg = await sharp(buffer, { limitInputPixels: 100_000_000 }).flatten({ background: "#ffffff" }).jpeg({ quality: 92, chromaSubsampling: "4:4:4", mozjpeg: true }).withMetadata({ density: 300 }).toBuffer();
  const saved = await saveProjectImage(project.id, jpeg, `figure-ai-${input.editOf ? "edit-" : ""}${Date.now()}.jpg`);
  const item: MadeFigure = { assetId: saved.id, src: saved.src, widthPx: saved.widthPx, heightPx: saved.heightPx, prompt, paragraph: input.paragraph.slice(0, 80), at: new Date().toISOString(), ...(input.editOf ? { edit: true } : {}) };
  const history = [item, ...(await loadFigureHistory(sectionId))].slice(0, MAX_HISTORY);
  await setSetting(key(sectionId), history);
  return { item, history };
}

/** [만든 그림] 삭제 — 본문에 이미 넣은 그림은 지우지 않는다(기록에서만 뺀다) */
export async function deleteFigure(sectionId: string, assetId: string) {
  const { project } = await sectionProject(sectionId);
  const history = await loadFigureHistory(sectionId);
  if (!history.some((h) => h.assetId === assetId)) throw Object.assign(new Error("[만든 그림]에 없는 이미지는 여기서 지울 수 없습니다."), { status: 400 });
  const next = history.filter((h) => h.assetId !== assetId);
  await setSetting(key(sectionId), next);
  const used = await prisma.section.count({ where: { chapter: { projectId: project.id }, content: { contains: assetId } } });
  if (!used) {
    const a = await prisma.asset.findFirst({ where: { id: assetId, projectId: project.id }, select: { id: true, path: true } });
    if (a) {
      await removeObjects("assets", [a.path]).catch((e) => console.warn("[figure-ai] 저장소 파일 삭제 실패", e?.message));
      await prisma.asset.delete({ where: { id: a.id } });
    }
  }
  return { history: next, kept: used > 0 };
}
