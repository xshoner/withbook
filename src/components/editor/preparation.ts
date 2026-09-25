"use client";
import { IdleWork } from "@/lib/idle-work";
import { api } from "@/lib/client";

const work = new IdleWork();
export const cancelSummaryPreparation = (id: string) => work.cancel(`summary:${id}`);
export function scheduleSummaryPreparation(id: string, ready: () => boolean = () => true, delay = 20_000) {
  work.schedule(`summary:${id}`, () => {
    if (!navigator.onLine || !ready()) return Promise.resolve();
    return api(`/api/sections/${id}/summarize`, { method: "POST" });
  }, delay);
}
export function scheduleOutlinePreparation(id: string, body: { targetPages: number; extraInstruction: string }) {
  const key = `outline:${id}`;
  work.schedule(key, () => {
    if (!navigator.onLine) return Promise.resolve();
    return api(`/api/sections/${id}/prepare`, { method: "POST", json: { ...body, mode: "overwrite" } });
  });
  return () => work.cancel(key);
}
