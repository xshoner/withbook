import { z } from "zod";

export const writeInput = z.object({
  targetPages: z.coerce.number().finite().min(0.5).max(60).default(3),
  mode: z.enum(["overwrite", "continue", "newVersion"]).default("overwrite"),
  extraInstruction: z.string().max(20000).optional(),
  /**
   * 긴 절 자동 이어 쓰기 — 한 요청의 시간 한도로 멈춘 뒤, 같은 개요(parts)로 fromPart부터 계속한다.
   * written: 지금까지 쓴 마크다운(다음 파트가 앞 파트 마지막 문단에 이어지도록). 품질은 한 번에 쓸 때와 같은 프롬프트다.
   */
  resume: z
    .object({
      fromPart: z.number().int().min(1).max(20),
      written: z.string().max(200000),
      parts: z
        .array(z.object({ heading: z.string(), points: z.array(z.string()).default([]), sketchItems: z.array(z.string()).default([]), chars: z.coerce.number() }))
        .min(1)
        .max(20),
    })
    .optional(),
});
