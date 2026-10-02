/**
 * Items are newest first. Resolve only context that can still fit the prompt.
 * deadline(epoch ms): stop waiting for context at this time — a summary still being generated is left out
 * (it keeps running and is cached for the next request), so writing can start within the request's time limit.
 */
export async function collectRecentContext(
  items: Array<() => Promise<string>>,
  budget = 2500,
  signal?: AbortSignal,
  deadline?: number,
) {
  let text = "";
  for (const resolve of items) {
    signal?.throwIfAborted();
    const remaining = budget - text.length - (text ? 1 : 0);
    if (remaining <= 0) break;
    let raw: string;
    if (deadline === undefined) raw = await resolve();
    else {
      const left = deadline - Date.now();
      if (left <= 0) break;
      const got = await beforeDeadline(resolve(), left);
      if (!got.done) break;
      raw = got.value;
    }
    signal?.throwIfAborted();
    const chunk = raw.trim();
    if (!chunk) continue;
    // Keep even an oversized nearest summary instead of returning no context.
    const fitted = chunk.length <= remaining ? chunk : chunk.slice(0, Math.max(0, remaining - 1)) + "…";
    text = fitted + (text ? "\n" + text : "");
    if (chunk.length >= remaining) break;
  }
  return text;
}

async function beforeDeadline<T>(promise: Promise<T>, ms: number): Promise<{ done: true; value: T } | { done: false }> {
  const settled = promise.then((value) => ({ done: true as const, value }));
  settled.catch(() => {}); // a late item that fails afterwards must not become an unhandled rejection
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ done: false }>((r) => {
    timer = setTimeout(() => r({ done: false }), ms);
  });
  try {
    return await Promise.race([settled, late]);
  } finally {
    clearTimeout(timer);
  }
}
