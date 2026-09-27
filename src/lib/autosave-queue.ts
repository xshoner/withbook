export type Patch = { content?: string; sketch?: string; status?: string };
export type SaveResult = { charCount: number; status: string; updatedAt: string; contentHash?: string };
export type SaveState = { kind: "idle" | "dirty" | "saving" | "saved" | "offline" | "error" | "conflict"; at?: Date; msg?: string };
/** baseHash: 이 입력이 기준으로 삼은 서버 본문의 해시 — 오래된 복구본이 더 새 서버 원고를 덮지 않게 함께 보관한다 */
export type Draft = Patch & { ts: number; token: string; baseHash?: string | null };
/** 저장 충돌 — 서버에 있는 지금 본문 */
export type Conflict = { content: string; hash: string; updatedAt?: string };

/** 저장 요청 실패 — status로 서버 응답 코드를 알린다 (404 = 절이 지워짐, 409 = 다른 곳에서 먼저 고침) */
export class SaveError extends Error {
  status: number;
  conflict?: Conflict;
  constructor(message: string, status: number, conflict?: Conflict) {
    super(message);
    this.status = status;
    this.conflict = conflict;
  }
}

/** 다시 보내도 결과가 같은 요청 오류(4xx) — 시간 초과(408)·요청 과다(429)만 다시 보낸다 */
const retryable = (status: number) => status < 400 || status >= 500 || status === 408 || status === 429;

/** One serialized writer per section, including across editor unmounts. */
export class AutosaveQueue {
  draft: Draft | null = null;
  state: SaveState = { kind: "idle" };
  /** 서버가 마지막으로 확인해 준 본문의 해시 (모르면 null — 이때는 충돌을 확인하지 않고 저장한다) */
  base: string | null = null;
  /** 저장 충돌 중이면 서버 본문 — 사용자가 고를 때까지 다시 보내지 않는다 */
  conflict: Conflict | null = null;
  private running: Promise<boolean> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private lastPersist = 0;
  private firstDirty = 0;
  private storage: Promise<void> = Promise.resolve();
  private listeners = new Set<(state: SaveState, result?: SaveResult) => void>();
  private io: {
    save: (patch: Patch & { baseHash?: string }) => Promise<SaveResult>;
    persist: (draft: Draft) => Promise<void>;
    acknowledge: (token: string) => Promise<void>;
    offline: () => boolean;
    /** 본문 해시 (없으면 충돌 확인을 하지 않는다) */
    hash?: (content: string) => string;
    /** 상태가 바뀔 때마다 (상단 저장 표시가 모든 절의 큐를 모아 본다) */
    changed?: () => void;
    /** 브라우저 복구본은 이 간격(ms)에 한 번만 쓴다 (기본 1초) */
    persistDelay?: number;
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
    this.io.changed?.();
  }

  /** 편집기가 서버에서 원고를 새로 읽었거나 서버가 원고를 고친 뒤 — 보낼 입력이 없을 때만 기준을 바꾼다 */
  setBase(hash: string | null) {
    if (this.draft || this.conflict) return;
    this.base = hash;
  }

  mark(patch: Patch) {
    this.draft = { ...this.draft, ...patch, ts: Date.now(), token: crypto.randomUUID(), baseHash: this.draft ? this.draft.baseHash : this.base };
    this.schedulePersist();
    if (this.conflict) return; // 고를 때까지 보내지 않는다 (입력은 브라우저에 보관)
    if (!this.firstDirty) this.firstDirty = Date.now();
    // 같은 상태를 입력마다 다시 알리지 않는다 — 상단 표시·목차가 글자마다 다시 그려지지 않게
    if (this.state.kind !== "dirty") this.emit({ kind: "dirty" });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), Math.max(0, Math.min(1000, 5000 - (Date.now() - this.firstDirty))));
  }

  /** 브라우저 복구본(IndexedDB) 쓰기는 persistDelay에 한 번으로 묶는다 — 긴 원고를 입력마다 직렬화하지 않게 */
  private schedulePersist() {
    if (this.persistTimer !== undefined) return;
    const wait = Math.max(0, this.lastPersist + (this.io.persistDelay ?? 1000) - Date.now());
    if (!wait) void this.persistNow();
    else this.persistTimer = setTimeout(() => void this.persistNow(), wait);
  }

  /** 밀린 복구본을 지금 쓴다 (창을 숨기거나 닫기 직전·저장 요청 직전) */
  persistNow(): Promise<void> {
    clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    const draft = this.draft;
    if (!draft) return this.storage;
    this.lastPersist = Date.now();
    this.storage = this.storage.then(() => this.io.persist(draft)).catch(() => {
      this.emit({ kind: "error", msg: "브라우저 복구본 저장 실패. 서버 저장이 끝날 때까지 창을 닫지 마세요." });
    });
    return this.storage;
  }

  flush(): Promise<boolean> {
    clearTimeout(this.timer);
    if (this.conflict) return Promise.resolve(false);
    if (this.running) return this.running;
    this.running = this.drain().finally(() => { this.running = null; });
    return this.running;
  }

  private async drain(): Promise<boolean> {
    while (this.draft) {
      const sent = this.draft;
      this.emit({ kind: "saving" });
      // 보내는 입력은 먼저 복구본에 둔다 — 저장 확인(acknowledge)이 이 복구본을 지울 수 있게
      if (this.persistTimer !== undefined) await this.persistNow();
      try {
        const baseHash = sent.content !== undefined && sent.baseHash ? sent.baseHash : undefined;
        const result = await this.io.save({ content: sent.content, sketch: sent.sketch, status: sent.status, ...(baseHash ? { baseHash } : {}) });
        await this.storage;
        if (sent.content !== undefined && this.io.hash) this.base = result.contentHash ?? this.io.hash(sent.content);
        if (this.draft?.token === sent.token) {
          this.draft = null;
          this.firstDirty = 0;
          clearTimeout(this.persistTimer);
          this.persistTimer = undefined;
          await this.io.acknowledge(sent.token).catch(() => {});
        } else if (this.draft) {
          // 요청하는 동안 더 친 입력 — 방금 저장한 본문을 기준으로 삼는다
          this.draft = { ...this.draft, baseHash: this.base };
          this.schedulePersist();
        }
        this.emit({ kind: this.draft ? "dirty" : "saved", at: new Date() }, result);
      } catch (error) {
        const status = error instanceof SaveError ? error.status : 0;
        if (status === 404) {
          // 절이 지워졌다 — 다시 보내도 소용없으니 보관본까지 버리고 멈춘다
          await this.storage;
          const last = this.draft;
          this.draft = null;
          this.firstDirty = 0;
          if (last) await this.io.acknowledge(last.token).catch(() => {});
          this.emit({ kind: "idle", msg: "삭제된 절이라 저장하지 않았습니다." });
          clearTimeout(this.timer);
          return true;
        }
        clearTimeout(this.timer);
        if (status === 409 && error instanceof SaveError && error.conflict) {
          // 다른 창·서버 작업이 먼저 고쳤다 — 덮어쓰지 않고 멈춘다. 입력은 복구본에 남는다
          this.conflict = error.conflict;
          await this.persistNow();
          this.emit({ kind: "conflict", msg: error.message });
          return false;
        }
        const msg = error instanceof Error ? error.message : "저장 실패";
        this.emit({ kind: this.io.offline() ? "offline" : "error", msg });
        // 입력 형식 오류 같은 4xx는 다시 보내도 같다 — 다음 입력이나 직접 저장(Ctrl+S) 때 다시 보낸다
        if (!status || retryable(status)) this.timer = setTimeout(() => void this.flush(), 5000);
        return false;
      }
    }
    clearTimeout(this.timer);
    return true;
  }

  /** 충돌: 내 원고로 덮어쓴다 (서버 본문은 부른 쪽이 먼저 버전으로 남긴다) */
  keepMine(): Promise<boolean> {
    const c = this.conflict;
    if (!c) return this.flush();
    this.conflict = null;
    this.base = c.hash;
    if (this.draft) this.draft = { ...this.draft, baseHash: c.hash };
    this.emit({ kind: this.draft ? "dirty" : "idle" });
    return this.flush();
  }

  /** 충돌: 서버 본문을 받아들인다 — 내 입력은 버린다 (부른 쪽이 먼저 버전으로 남긴다) */
  async takeServer() {
    const c = this.conflict;
    this.conflict = null;
    const last = this.draft;
    this.draft = null;
    this.firstDirty = 0;
    clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    if (c) this.base = c.hash;
    await this.storage;
    if (last) await this.io.acknowledge(last.token).catch(() => {});
    this.emit({ kind: "idle" });
  }

  stopTimer() { clearTimeout(this.timer); }

  /** 보낼 것도, 보는 편집기도 없으면 버려도 된다 */
  idle() { return !this.draft && !this.running && !this.conflict && this.listeners.size === 0; }
}
