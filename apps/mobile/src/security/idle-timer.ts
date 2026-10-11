/**
 * Idle auto-lock (section 17.2): the app locks after a period without touches, including time
 * spent in the background, where JavaScript timers do not run reliably. Pure and clock-injected so
 * it is unit-tested; `use-auto-lock.ts` wires it to AppState and touch events.
 */

export interface Clock {
  now(): number;
}

export interface Scheduler {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface IdleTimerOptions {
  readonly timeoutMs: number;
  readonly clock: Clock;
  readonly scheduler: Scheduler;
  /** Called once each time the idle period elapses. */
  readonly onIdle: () => void;
}

export class IdleTimer {
  private timeoutMs: number;
  private readonly clock: Clock;
  private readonly scheduler: Scheduler;
  private readonly onIdle: () => void;
  private lastActivityAt: number;
  private handle: unknown = null;
  private running = false;
  private backgrounded = false;

  constructor(options: IdleTimerOptions) {
    if (!(options.timeoutMs > 0)) throw new RangeError("timeoutMs must be positive");
    this.timeoutMs = options.timeoutMs;
    this.clock = options.clock;
    this.scheduler = options.scheduler;
    this.onIdle = options.onIdle;
    this.lastActivityAt = options.clock.now();
  }

  /** Starts counting from now (call after a successful unlock). */
  start(): void {
    this.running = true;
    this.backgrounded = false;
    this.lastActivityAt = this.clock.now();
    this.schedule(this.timeoutMs);
  }

  /** Stops counting (call when locked or signed out). */
  stop(): void {
    this.running = false;
    this.cancel();
  }

  isRunning(): boolean {
    return this.running;
  }

  /** User activity: restarts the idle period. Ignored while stopped or in the background. */
  touch(): void {
    if (!this.running || this.backgrounded) return;
    this.lastActivityAt = this.clock.now();
    this.schedule(this.timeoutMs);
  }

  /** The app went to the background: timers are unreliable there, so only the time is kept. */
  background(): void {
    if (!this.running) return;
    this.backgrounded = true;
    this.cancel();
  }

  /** The app returned: lock at once if the idle period passed while away, otherwise resume. */
  foreground(): void {
    if (!this.running) return;
    this.backgrounded = false;
    const remaining = this.msUntilIdle();
    if (remaining <= 0) this.fire();
    else this.schedule(remaining);
  }

  /** Changes the timeout (for example when the device mode changes), keeping the elapsed time. */
  setTimeoutMs(timeoutMs: number): void {
    if (!(timeoutMs > 0)) throw new RangeError("timeoutMs must be positive");
    this.timeoutMs = timeoutMs;
    if (!this.running || this.backgrounded) return;
    const remaining = this.msUntilIdle();
    if (remaining <= 0) this.fire();
    else this.schedule(remaining);
  }

  msUntilIdle(): number {
    return this.lastActivityAt + this.timeoutMs - this.clock.now();
  }

  private fire(): void {
    this.stop();
    this.onIdle();
  }

  private schedule(ms: number): void {
    this.cancel();
    this.handle = this.scheduler.setTimeout(() => {
      this.handle = null;
      // Timers can fire early or late; check against the clock, not the timer.
      const remaining = this.msUntilIdle();
      if (remaining <= 0) this.fire();
      else this.schedule(remaining);
    }, ms);
  }

  private cancel(): void {
    if (this.handle !== null) {
      this.scheduler.clearTimeout(this.handle);
      this.handle = null;
    }
  }
}
