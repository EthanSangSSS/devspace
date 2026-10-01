export interface ToolResultWaitScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

const systemScheduler: ToolResultWaitScheduler = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class ToolResultWaitTimer {
  private timer: unknown | null = null;

  constructor(
    private readonly delayMs: number,
    private readonly onTimeout: () => void,
    private readonly scheduler: ToolResultWaitScheduler = systemScheduler,
  ) {}

  start(): void {
    this.clear();
    this.timer = this.scheduler.schedule(() => {
      this.timer = null;
      this.onTimeout();
    }, this.delayMs);
  }

  clear(): void {
    if (!this.timer) return;
    this.scheduler.cancel(this.timer);
    this.timer = null;
  }
}
