import { z } from "zod";

export const writeInput = z.object({
  targetPages: z.coerce.number().finite().min(0.5).max(60).default(3),
  mode: z.enum(["overwrite", "continue", "newVersion"]).default("overwrite"),
  extraInstruction: z.string().max(20000).optional(),
});
