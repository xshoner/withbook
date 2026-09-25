export type Patch = { content?: string; sketch?: string; status?: string };
export type SaveResult = { charCount: number; status: string; updatedAt: string };
export type SaveState = { kind: "idle" | "dirty" | "saving" | "saved" | "offline" | "error"; at?: Date; msg?: string };
export type Draft = Patch & { ts: number; token: string };

/** One serialized writer per section, including across editor unmounts. */
export class AutosaveQueue {
  draft: Draft | null = null;
  state: SaveState = { kind: "idle" };
  private running: Promise<boolean> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private firstDirty = 0;
  private storage: Promise<void> = Promise.resolve();
  private listeners = new Set<(state: SaveState, result?: SaveResult) => void>();
  private io: {
    save: (patch: Patch) => Promise<SaveResult>;
    persist: (draft: Draft) => Promise<void>;
    acknowledge: (token: string) => Promise<void>;
    offline: () => boolean;
  };

  constructor(io: AutosaveQueue["io"]) { this.io = io; }

  subscribe(listener: (state: SaveState, result?: SaveResult) => void) {
    this.listeners.add(listener);
    listener(this.state);
    return () => { this.listeners.delete(listener); };
  }

  private emit(state: SaveState, result?: SaveResult) {
    this.state = state;
    for (const listener of this.listeners) listener(state, result);
  }

  mark(patch: Patch) {
    this.draft = { ...this.draft, ...patch, ts: Date.now(), token: crypto.randomUUID() };
    const draft = this.draft;
    this.storage = this.storage.then(() => this.io.persist(draft)).catch(() => {
      this.emit({ kind: "error", msg: "브라우저 복구본 저장 실패. 서버 저장이 끝날 때까지 창을 닫지 마세요." });
    });
    if (!this.firstDirty) this.firstDirty = Date.now();
    this.emit({ kind: "dirty" });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), Math.max(0, Math.min(1000, 5000 - (Date.now() - this.firstDirty))));
  }

  flush(): Promise<boolean> {
    clearTimeout(this.timer);
    if (this.running) return this.running;
    this.running = this.drain().finally(() => { this.running = null; });
    return this.running;
  }

  private async drain(): Promise<boolean> {
    while (this.draft) {
      const sent = this.draft;
      this.emit({ kind: "saving" });
      try {
        const result = await this.io.save({ content: sent.content, sketch: sent.sketch, status: sent.status });
        await this.storage;
        if (this.draft?.token === sent.token) {
          this.draft = null;
          this.firstDirty = 0;
          await this.io.acknowledge(sent.token).catch(() => {});
        }
        this.emit({ kind: this.draft ? "dirty" : "saved", at: new Date() }, result);
      } catch (error) {
        this.emit({ kind: this.io.offline() ? "offline" : "error", msg: error instanceof Error ? error.message : "저장 실패" });
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.flush(), 5000);
        return false;
      }
    }
    clearTimeout(this.timer);
    return true;
  }

  stopTimer() { clearTimeout(this.timer); }

  /** 보낼 것도, 보는 편집기도 없으면 버려도 된다 */
  idle() { return !this.draft && !this.running && this.listeners.size === 0; }
}
