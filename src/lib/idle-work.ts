/** Debounce by key and run at most one preparation request at a time. */
export class IdleWork {
  private pending = new Map<string, { at: number; run: () => Promise<unknown> }>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  schedule(key: string, run: () => Promise<unknown>, delay = 20_000) {
    this.pending.set(key, { at: Date.now() + delay, run });
    if (this.pending.size > 100) this.pending.delete(this.pending.keys().next().value!);
    this.arm();
  }
  cancel(key: string) { this.pending.delete(key); this.arm(); }
  private arm() {
    clearTimeout(this.timer);
    if (this.running || !this.pending.size) return;
    const [key, work] = [...this.pending].sort((a, b) => a[1].at - b[1].at)[0];
    this.timer = setTimeout(async () => {
      this.pending.delete(key);
      this.running = true;
      try { await work.run(); } catch { /* Preparation is optional; foreground requests retry. */ }
      finally { this.running = false; this.arm(); }
    }, Math.max(0, work.at - Date.now()));
  }
}
