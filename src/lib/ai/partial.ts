/**
 * AI 집필 부분 원고 보관 — 스트림이 끊겨도(탭 닫힘·네트워크·서버 시간 한도) 받은 글을 되살릴 수 있게.
 *   key: ai-partial:{절 id}   value: { text, mode, chars, startedAt, updatedAt }
 *   집필 중 약 5초마다, 끊기거나 멈출 때 마지막으로 한 번 저장.
 *   정상으로 끝나도(done) 지우지 않고 다 쓴 글을 complete로 남긴다 — done을 보내기 *전에* 저장해,
 *   브라우저가 본문에 넣은 뒤 지우는 요청(DELETE /partial)보다 늦게 덮어쓰지 않게 한다.
 *   본문 저장·후보 선택이 끝나면 브라우저가 지운다. 그 전에 탭이 닫히면 다음에 열 때 [중단된 AI 집필]로 되찾는다.
 *   7일이 지나면 없는 것으로 보고, 일일 정리 작업이 지운다.
 * 저장 흐름(withPartialSave)은 저장소를 넘겨받아 DB 없이 테스트한다.
 */

export const PARTIAL_PREFIX = "ai-partial:";
export const PARTIAL_KEEP_DAYS = 7;
export const PARTIAL_SAVE_EVERY_MS = 5_000;

export type AiPartial = { text: string; mode: string; chars: number; startedAt: string; updatedAt: string; complete?: boolean };
export type PartialStore = { save: (p: AiPartial) => Promise<void>; clear: () => Promise<void> };

export const partialKey = (sectionId: string) => `${PARTIAL_PREFIX}${sectionId}`;

/** 7일 넘은 것·손상된 것은 null */
export function parsePartial(raw: string | null | undefined, now = Date.now()): AiPartial | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as AiPartial;
    if (typeof p?.text !== "string" || !p.updatedAt) return null;
    if (now - Date.parse(p.updatedAt) > PARTIAL_KEEP_DAYS * 86_400_000) return null;
    return p;
  } catch {
    return null;
  }
}

type Event = { t: string; v?: unknown };

/**
 * 집필 이벤트를 그대로 흘려보내면서 받은 본문(delta)을 모아 둔다.
 * done → 다 쓴 글을 complete로 저장한 뒤 done을 흘려보낸다(지우는 것은 브라우저가 저장을 마친 뒤).
 * 오류·중단(끝까지 못 감) 또는 "partial"(서버 시간 한도로 이어 쓰기 필요) → 쓴 데까지 남김.
 * 저장 실패는 집필을 막지 않는다(로그만).
 */
export async function* withPartialSave<E extends Event>(
  gen: AsyncGenerator<E>,
  store: PartialStore,
  opts: { mode: string; initialText?: string; startedAt?: string; everyMs?: number; now?: () => number },
): AsyncGenerator<E> {
  const now = opts.now ?? Date.now;
  const every = opts.everyMs ?? PARTIAL_SAVE_EVERY_MS;
  const startedAt = opts.startedAt ?? new Date(now()).toISOString();
  let text = opts.initialText ?? "";
  let savedLen = text.length;
  let lastSave = now();
  let finished = false;
  let needsResume = false;
  const save = async (complete = false) => {
    if ((text.length === savedLen && !complete) || !text.trim()) return;
    savedLen = text.length;
    lastSave = now();
    await store
      .save({ text, mode: opts.mode, chars: text.length, startedAt, updatedAt: new Date(now()).toISOString(), ...(complete ? { complete: true } : {}) })
      .catch((e) => console.warn("[ai-partial] 부분 원고 저장 실패", e?.message ?? e));
  };
  try {
    for await (const e of gen) {
      if (e.t === "delta" && typeof e.v === "string") {
        text += e.v;
        if (now() - lastSave >= every) await save();
      } else if (e.t === "status" && e.v === "partial") needsResume = true;
      else if (e.t === "done") {
        finished = true;
        await save(!needsResume);
      }
      yield e;
    }
  } finally {
    if (!finished) await save();
  }
}

/* ───────── DB ───────── */

const db = async () => (await import("../db")).prisma;

export function partialStore(sectionId: string): PartialStore {
  const key = partialKey(sectionId);
  return {
    save: async (p) => {
      const prisma = await db();
      const value = JSON.stringify(p);
      await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
    },
    clear: async () => {
      const prisma = await db();
      await prisma.appSetting.deleteMany({ where: { key } });
    },
  };
}

export async function loadPartial(sectionId: string): Promise<AiPartial | null> {
  const prisma = await db();
  const row = await prisma.appSetting.findUnique({ where: { key: partialKey(sectionId) } });
  return parsePartial(row?.value);
}

/** 오래된 부분 원고 비우기 (저장 시각 = updatedAt) */
export async function purgePartials(olderThanDays = PARTIAL_KEEP_DAYS) {
  const prisma = await db();
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
  const r = await prisma.appSetting.deleteMany({ where: { key: { startsWith: PARTIAL_PREFIX }, updatedAt: { lt: cutoff } } });
  return r.count;
}
