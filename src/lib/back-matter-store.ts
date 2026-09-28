import "server-only";
import { prisma } from "./db";
import { type BiblioConfig, type IndexConfig, biblioKey, indexKey, normalizeBiblio, normalizeIndex } from "./back-matter";

async function read(key: string) {
  const row = await prisma.appSetting.findUnique({ where: { key } }).catch(() => null);
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

/** 찾아보기·참고문헌 설정 (없으면 꺼진 빈 설정) */
export async function readBackMatter(projectId: string): Promise<{ index: IndexConfig; biblio: BiblioConfig }> {
  const [ix, bib] = await Promise.all([read(indexKey(projectId)), read(biblioKey(projectId))]);
  return { index: normalizeIndex(ix), biblio: normalizeBiblio(bib) };
}

export async function writeBackMatter(projectId: string, patch: { index?: unknown; biblio?: unknown }) {
  const rows: { key: string; value: string }[] = [];
  if (patch.index !== undefined) rows.push({ key: indexKey(projectId), value: JSON.stringify(normalizeIndex(patch.index)) });
  if (patch.biblio !== undefined) rows.push({ key: biblioKey(projectId), value: JSON.stringify(normalizeBiblio(patch.biblio)) });
  for (const r of rows) await prisma.appSetting.upsert({ where: { key: r.key }, create: r, update: { value: r.value } });
  return readBackMatter(projectId);
}
