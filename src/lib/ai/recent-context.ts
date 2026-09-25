/** Items are newest first. Resolve only context that can still fit the prompt. */
export async function collectRecentContext(
  items: Array<() => Promise<string>>,
  budget = 2500,
  signal?: AbortSignal,
) {
  let text = "";
  for (const resolve of items) {
    signal?.throwIfAborted();
    const remaining = budget - text.length - (text ? 1 : 0);
    if (remaining <= 0) break;
    const chunk = (await resolve()).trim();
    if (!chunk) continue;
    // Keep even an oversized nearest summary instead of returning no context.
    const fitted = chunk.length <= remaining ? chunk : chunk.slice(0, Math.max(0, remaining - 1)) + "…";
    text = fitted + (text ? "\n" + text : "");
    if (chunk.length >= remaining) break;
  }
  return text;
}
