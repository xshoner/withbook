import { Prisma, PrismaClient } from "@prisma/client";

const g = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = g.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") g.prisma = prisma;

/** 접속 주소의 schema= 값 (없거나 이상하면 public) */
export function dbSchema(url = process.env.DATABASE_URL ?? ""): string {
  const s = /[?&]schema=([^&#]+)/.exec(url)?.[1];
  const name = s ? decodeURIComponent(s) : "";
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : "public";
}

/**
 * 원시 SQL($queryRaw)에 쓰는 표 이름 — 스키마까지 붙인다.
 * Prisma 쿼리는 스키마를 알아서 붙이지만 원시 SQL은 search_path를 따르는데, Supabase 풀러(pgbouncer)를 거치면 public으로 잡혀
 * 운영에서만 `relation "Section" does not exist`가 났다. 원시 SQL에는 표 이름을 직접 쓰지 말고 이것을 쓴다.
 */
export const rawTable = (name: "Section" | "Chapter" | "AppSetting") => Prisma.raw(`"${dbSchema()}"."${name}"`);
