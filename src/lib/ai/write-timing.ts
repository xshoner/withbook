export type WriteTiming = {
  loadMs: number;
  summaryMs: number;
  outlineMs: number;
  generationMs: number;
  firstTextMs: number | null;
  totalMs: number;
  outlineCached: boolean;
};

export class WriteClock {
  private started: number;
  private generationStarted: number | null = null;
  private firstText: number | null = null;
  loadMs = 0;
  summaryMs = 0;
  outlineMs = 0;
  outlineCached = false;
  private now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; this.started = now(); }
  startGeneration() { this.generationStarted ??= this.now(); }
  text() { this.firstText ??= this.now(); }
  snapshot(): WriteTiming {
    const end = this.now();
    return {
      loadMs: this.loadMs, summaryMs: this.summaryMs, outlineMs: this.outlineMs,
      generationMs: this.generationStarted === null ? 0 : end - this.generationStarted,
      firstTextMs: this.firstText === null ? null : this.firstText - this.started,
      totalMs: end - this.started, outlineCached: this.outlineCached,
    };
  }
}
