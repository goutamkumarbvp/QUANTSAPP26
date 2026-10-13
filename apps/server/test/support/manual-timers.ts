/**
 * TEST-ONLY: a clock and timers that move only when the test says so. Callbacks run in time order;
 * between two callbacks pending promises and I/O get a chance to settle (setImmediate is real).
 */
export const flush = async (rounds = 10): Promise<void> => {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
};

interface Task {
  at: number;
  seq: number;
  fn: () => void;
  every?: number;
}

export class ManualTimers {
  private seq = 0;
  private readonly tasks = new Map<number, Task>();

  constructor(public t: number) {}

  readonly now = (): number => this.t;

  readonly setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.tasks.set(id, { at: this.t + Math.max(0, ms), seq: id, fn });
    return id;
  };

  readonly clearTimeout = (h: unknown): void => {
    this.tasks.delete(h as number);
  };

  readonly setInterval = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.tasks.set(id, { at: this.t + ms, seq: id, fn, every: Math.max(1, ms) });
    return id;
  };

  readonly clearInterval = (h: unknown): void => {
    this.tasks.delete(h as number);
  };

  readonly sleep = (ms: number): Promise<void> => new Promise((r) => this.setTimeout(r, ms));

  /** Timers due at or before now + ms (times of each, ascending). */
  pending(): { at: number; every?: number }[] {
    return [...this.tasks.values()].sort((a, b) => a.at - b.at || a.seq - b.seq).map((t) => ({ at: t.at, every: t.every }));
  }

  /** Move the clock forward, running every timer that falls due (in order), settling promises between. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      await flush(3);
      const due = [...this.tasks.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[1].seq - b[1].seq)[0];
      if (!due) break;
      const [id, task] = due;
      this.t = Math.max(this.t, task.at);
      if (task.every) task.at += task.every;
      else this.tasks.delete(id);
      task.fn();
    }
    this.t = end;
    await flush(3);
  }
}
