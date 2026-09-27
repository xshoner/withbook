import "server-only";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { buildReferencesBlock, cleanRefName, cleanRefText, REF_MAX_COUNT, refKey, refPrefix, type RefItem, type RefRow } from "./ai/section-refs";
import { editedOutlineKey, outlineCacheKey } from "./ai/outline-text";

/** 절 참고 자료 저장소 — AppSetting `ref:{절 id}:{자료 id}` (규칙은 ai/section-refs.ts) */

type Db = Prisma.TransactionClient | typeof prisma;

/** 목록 (본문 없이, 올린 순서) */
export async function listRefs(sectionId: string): Promise<RefItem[]> {
  const prefix = refPrefix(sectionId);
  const rows = await prisma.$queryRaw<{ meta: RefItem | null }[]>`
    SELECT (value::jsonb - 'text') AS meta FROM "AppSetting" WHERE starts_with(key, ${prefix})`;
  return rows
    .map((r) => r.meta)
    .filter((m): m is RefItem => !!m && typeof m.id === "string")
    .map((m) => ({ id: m.id, name: String(m.name ?? ""), chars: Number(m.chars) || 0, createdAt: String(m.createdAt ?? "") }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** 본문까지 (집필 프롬프트용) */
export async function loadRefRows(sectionId: string): Promise<RefRow[]> {
  const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: refPrefix(sectionId) } } });
  const out: RefRow[] = [];
  for (const r of rows) {
    try {
      const v = JSON.parse(r.value) as RefRow;
      if (v && typeof v.text === "string") out.push(v);
    } catch {}
  }
  return out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

/** 집필 프롬프트에 넣을 참고 자료 묶음과 자료 id (개요 입력 해시용) */
export async function loadSectionReferences(sectionId: string): Promise<{ block: string; ids: string[] }> {
  const rows = await loadRefRows(sectionId).catch((e) => {
    console.warn("[refs] 참고 자료를 읽지 못함", e?.message);
    return [] as RefRow[];
  });
  return { block: buildReferencesBlock(rows), ids: rows.map((r) => r.id) };
}

export async function addRef(sectionId: string, name: string, text: string): Promise<{ item: RefItem; truncated: boolean }> {
  const n = cleanRefName(name);
  if (!n) throw Object.assign(new Error("자료 이름을 입력하세요."), { status: 400 });
  const t = cleanRefText(text);
  if (!t.text) throw Object.assign(new Error("자료에서 글을 찾지 못했습니다. 스캔한 PDF라면 글자를 인식할 수 없습니다."), { status: 400 });
  const count = await prisma.appSetting.count({ where: { key: { startsWith: refPrefix(sectionId) } } });
  if (count >= REF_MAX_COUNT) throw Object.assign(new Error(`참고 자료는 절마다 ${REF_MAX_COUNT}개까지 붙일 수 있습니다. 쓰지 않는 자료를 먼저 빼세요.`), { status: 400 });
  const item: RefItem = { id: randomUUID().replace(/-/g, "").slice(0, 16), name: n, chars: t.text.length, createdAt: new Date().toISOString() };
  const key = refKey(sectionId, item.id);
  await prisma.appSetting.create({ data: { key, value: JSON.stringify({ ...item, text: t.text } satisfies RefRow) } });
  return { item, truncated: t.truncated };
}

export async function deleteRef(sectionId: string, refId: string) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(refId)) throw Object.assign(new Error("자료를 찾을 수 없습니다."), { status: 404 });
  await prisma.appSetting.deleteMany({ where: { key: refKey(sectionId, refId) } });
}

/**
 * 절에 딸린 AppSetting 행(참고 자료·작가가 고친 개요·개요 캐시)을 지운다 — 책을 영구 삭제할 때.
 * (장·절 휴지통은 trash.ts가 이 행들을 휴지통 항목에 담아 옮긴다)
 */
export async function clearSectionExtras(db: Db, sectionIds: string[]) {
  for (let i = 0; i < sectionIds.length; i += 200) {
    const ids = sectionIds.slice(i, i + 200);
    await db.appSetting.deleteMany({
      where: {
        OR: [
          ...ids.map((id) => ({ key: { startsWith: refPrefix(id) } })),
          { key: { in: ids.flatMap((id) => [editedOutlineKey(id), outlineCacheKey(id)]) } },
        ],
      },
    });
  }
}
