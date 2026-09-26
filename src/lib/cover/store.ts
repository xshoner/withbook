import "server-only";
import { prisma } from "../db";
import { getSetting, setSetting } from "../app-settings";
import { type CoverDesign, coverAssetIds, defaultCover, normalizeCover } from "./spec";

/** 표지 디자인은 책마다 AppSetting `cover:{책 id}`에 JSON으로 둔다 (스키마 변경 없음) */
const key = (projectId: string) => `cover:${projectId}`;

async function project(projectId: string) {
  const p = await prisma.project.findFirst({ where: { id: projectId, deletedAt: null }, select: { id: true, title: true, subtitle: true, author: true, targetPages: true } });
  if (!p) throw Object.assign(new Error("프로젝트를 찾을 수 없습니다."), { status: 404 });
  return p;
}

export async function loadCover(projectId: string): Promise<{ design: CoverDesign; saved: boolean }> {
  const p = await project(projectId);
  const raw = await getSetting<unknown>(key(projectId));
  if (!raw) return { design: defaultCover(p), saved: false };
  return { design: normalizeCover(raw), saved: true };
}

/** 저장 — 다른 책의 이미지는 넣을 수 없고, 이미지 픽셀 크기는 DB 값으로 맞춘다(해상도 점검이 정확하게) */
export async function saveCover(projectId: string, input: unknown) {
  await project(projectId);
  const d = normalizeCover(input);
  const ids = [...coverAssetIds(d)];
  const rows = ids.length ? await prisma.asset.findMany({ where: { id: { in: ids }, projectId }, select: { id: true, widthPx: true, heightPx: true } }) : [];
  const dims = new Map(rows.map((r) => [r.id, r]));
  if (rows.length !== ids.length) throw Object.assign(new Error("이 책에 없는 이미지가 들어 있습니다. 이미지를 다시 올려주세요."), { status: 400 });
  const fix = <T extends { assetId: string; widthPx: number; heightPx: number }>(v: T): T => {
    const r = dims.get(v.assetId)!;
    return { ...v, widthPx: r.widthPx, heightPx: r.heightPx };
  };
  for (const [k, img] of Object.entries(d.images)) if (img) d.images[k as keyof typeof d.images] = fix(img);
  d.elements = d.elements.map((e) => (e.kind === "image" ? fix(e) : e));
  d.ai.history = d.ai.history.map(fix);
  d.updatedAt = new Date().toISOString();
  await setSetting(key(projectId), d);
  return d;
}

/** AI로 만든 그림을 기록에 더한다 (편집기가 저장하기 전에도 다시 고를 수 있게) */
export async function addCoverHistory(projectId: string, item: CoverDesign["ai"]["history"][number]) {
  const { design } = await loadCover(projectId);
  design.ai.history = [...design.ai.history, item].slice(-24);
  await setSetting(key(projectId), design);
  return design.ai.history;
}
