import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma, rawTable } from "../db";
import { loadPageCount } from "../print/page-count";
import { type CoverDesign, coverAssetIds, defaultCover, normalizeCover, syncActualPages } from "./spec";

/**
 * 표지 디자인은 책마다 AppSetting `cover:{책 id}`에 JSON으로 둔다 (스키마 변경 없음)
 * 여러 서버가 같은 값을 고치므로 설정 캐시(app-settings, 5초)를 쓰지 않고 늘 DB에서 읽는다.
 * 읽고-고치고-쓰는 곳(만든 그림 기록·삭제)은 트랜잭션 안에서 행을 잠그고 고친다.
 */
export const coverKey = (projectId: string) => `cover:${projectId}`;

type ProjectInfo = { id: string; title: string; subtitle: string; author: string; targetPages: number };

async function project(projectId: string): Promise<ProjectInfo> {
  const p = await prisma.project.findFirst({ where: { id: projectId, deletedAt: null }, select: { id: true, title: true, subtitle: true, author: true, targetPages: true } });
  if (!p) throw Object.assign(new Error("책을 찾을 수 없습니다."), { status: 404 });
  return p;
}

const parse = (value: string | null | undefined): unknown => {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

/**
 * 저장본 → 디자인. 쪽수를 직접 고쳤는지(pagesManual) 기록이 없는 예전 저장본은
 * 목표 쪽수(예전 기본값)와 다르면 작가가 고친 것으로 본다.
 */
export function designFromRaw(raw: any, p: Pick<ProjectInfo, "targetPages">): CoverDesign {
  const d = normalizeCover(raw);
  if (raw && raw.pagesManual === undefined) d.pagesManual = d.pages !== defaultCover(p).pages;
  return d;
}

/**
 * 불러오기 — 저장한 적 없으면 책 정보로 만든 기본 디자인.
 * 쪽수를 직접 고치지 않았으면 책의 실제 조판 쪽수(actualPages)로 맞춰 돌려준다(책등 폭이 자동으로 따라간다).
 */
export async function loadCover(projectId: string): Promise<{ design: CoverDesign; saved: boolean; actualPages: number | null }> {
  const [p, row, count] = await Promise.all([
    project(projectId),
    prisma.appSetting.findUnique({ where: { key: coverKey(projectId) } }),
    loadPageCount(projectId),
  ]);
  const actualPages = count?.total ?? null;
  const raw = parse(row?.value);
  if (!raw) return { design: defaultCover(p, actualPages), saved: false, actualPages };
  return { design: syncActualPages(designFromRaw(raw, p), actualPages), saved: true, actualPages };
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
  const key = coverKey(projectId);
  const value = JSON.stringify(d);
  await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  return d;
}

/**
 * 저장본을 잠그고 읽어 고친다 (다른 요청이 방금 저장한 디자인을 옛 값으로 되돌리지 않게).
 * fn이 null을 돌려주면 쓰지 않는다. saved: 저장본이 있었는지
 */
export async function updateCover<R>(projectId: string, fn: (design: CoverDesign, saved: boolean) => { design: CoverDesign | null; result: R }): Promise<R> {
  const p = await project(projectId);
  const key = coverKey(projectId);
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const rows = await tx.$queryRaw<{ value: string }[]>`SELECT value FROM ${rawTable("AppSetting")} WHERE key = ${key} FOR UPDATE`;
    const raw = parse(rows[0]?.value);
    const { design, result } = fn(raw ? designFromRaw(raw, p) : defaultCover(p), Boolean(raw));
    if (design) {
      const value = JSON.stringify(design);
      await tx.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
    }
    return result;
  });
}

/** AI로 만든 그림을 기록에 더한다 (편집기가 저장하기 전에도 다시 고를 수 있게) */
export async function addCoverHistory(projectId: string, item: CoverDesign["ai"]["history"][number]) {
  return updateCover(projectId, (design) => {
    design.ai.history = [...design.ai.history, item].slice(-24);
    return { design, result: design.ai.history };
  });
}
