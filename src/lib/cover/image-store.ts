import "server-only";
import type { Sharp } from "sharp";
import { prisma } from "../db";
import { assetKey } from "../backup";
import { setSetting } from "../app-settings";
import { getObject, putObject, removeObjects } from "../storage";
import { addCoverHistory, loadCover } from "./store";
import type { Region } from "./spec";

/** 인쇄용 JPEG (품질 92, 색 번짐 없는 4:4:4, 300 DPI 표시) */
export const printJpeg = (img: Sharp, bg: string) =>
  img.flatten({ background: bg }).jpeg({ quality: 92, chromaSubsampling: "4:4:4", mozjpeg: true }).withMetadata({ density: 300 }).toBuffer();

/** AI로 만든·고친 표지 그림을 이 책의 이미지로 저장하고 [만든 그림] 기록에 더한다 */
export async function storeCoverImage(projectId: string, jpeg: Buffer, w: number, h: number, region: Region, edit = false) {
  const a = await prisma.asset.create({ data: { projectId, filename: `cover-ai-${edit ? "edit-" : ""}${region}.jpg`, mime: "image/jpeg", widthPx: w, heightPx: h, path: "" } });
  const key = assetKey(projectId, a.id, ".jpg");
  try {
    await putObject("assets", key, jpeg, "image/jpeg");
  } catch (e) {
    await prisma.asset.delete({ where: { id: a.id } });
    throw e;
  }
  await prisma.asset.update({ where: { id: a.id }, data: { path: key } });
  const item = { assetId: a.id, widthPx: w, heightPx: h, region, at: new Date().toISOString(), ...(edit ? { edit: true } : {}) };
  const history = await addCoverHistory(projectId, item);
  return { ...item, src: `/api/assets/${a.id}`, history };
}

/** 이 책의 이미지 원본 바이트 */
export async function readProjectAsset(projectId: string, assetId: string) {
  const a = await prisma.asset.findFirst({ where: { id: assetId, projectId }, select: { path: true, widthPx: true, heightPx: true } });
  if (!a?.path) throw Object.assign(new Error("수정할 그림을 찾을 수 없습니다. 그림을 다시 올리거나 만드세요."), { status: 404 });
  const buf = await getObject("assets", a.path);
  if (!buf) throw Object.assign(new Error("그림 파일을 찾을 수 없습니다."), { status: 404 });
  return { buffer: buf, widthPx: a.widthPx, heightPx: a.heightPx };
}

/**
 * [만든 그림] 삭제 — AI로 만든·고친 그림만 지울 수 있다(올린 사진·원고 이미지는 건드리지 않는다).
 * 저장된 표지 디자인에서 빼고, 저장소 파일과 DB 이미지 행을 지운다.
 */
export async function deleteCoverImage(projectId: string, assetId: string) {
  const { design, saved } = await loadCover(projectId);
  if (!design.ai.history.some((h) => h.assetId === assetId)) throw Object.assign(new Error("[만든 그림]에 없는 이미지는 여기서 지울 수 없습니다."), { status: 400 });
  const a = await prisma.asset.findFirst({ where: { id: assetId, projectId }, select: { id: true, path: true } });
  design.ai.history = design.ai.history.filter((h) => h.assetId !== assetId);
  for (const [r, img] of Object.entries(design.images)) if (img?.assetId === assetId) delete design.images[r as Region];
  if (saved) await setSetting(`cover:${projectId}`, design);
  if (a) {
    await removeObjects("assets", [a.path]).catch((e) => console.warn("[cover] 저장소 파일 삭제 실패", e?.message));
    await prisma.asset.delete({ where: { id: a.id } });
  }
  return { history: design.ai.history };
}
