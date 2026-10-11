import { describe, expect, it } from "vitest";
import { IdleTimer, type Scheduler } from "./idle-timer";

/** A manual clock and scheduler: time only moves when the test says so. */
function harness(timeoutMs = 120_000) {
  let now = 1_000_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const scheduler: Scheduler = {
    setTimeout(callback, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
  };
  let idleCount = 0;
  const timer = new IdleTimer({
    timeoutMs,
    clock: { now: () => now },
    scheduler,
    onIdle: () => {
      idleCount += 1;
    },
  });
  /** Advances time and fires due timers in order. */
  const advance = (ms: number, firesTimers = true) => {
    now += ms;
    if (!firesTimers) return;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= now)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      due[1].callback();
    }
  };
  return {
    timer,
    advance,
    idle: () => idleCount,
    pendingTimers: () => timers.size,
  };
}

describe("IdleTimer", () => {
  it("locks after the timeout with no activity", () => {
    const h = harness(120_000);
    h.timer.start();
    h.advance(119_999);
    expect(h.idle()).toBe(0);
    h.advance(1);
    expect(h.idle()).toBe(1);
    expect(h.timer.isRunning()).toBe(false);
  });

  it("restarts the period on each touch", () => {
    const h = harness(30_000);
    h.timer.start();
    h.advance(20_000);
    h.timer.touch();
    h.advance(20_000);
    expect(h.idle()).toBe(0);
    h.advance(10_000);
    expect(h.idle()).toBe(1);
  });

  it("fires only once until restarted", () => {
    const h = harness(30_000);
    h.timer.start();
    h.advance(90_000);
    expect(h.idle()).toBe(1);
    h.timer.touch();
    h.advance(90_000);
    expect(h.idle()).toBe(1);
    h.timer.start();
    h.advance(30_000);
    expect(h.idle()).toBe(2);
  });

  it("counts time in the background and locks on return if it has passed", () => {
    const h = harness(120_000);
    h.timer.start();
    h.advance(10_000);
    h.timer.background();
    expect(h.pendingTimers()).toBe(0);
    // Timers do not run in the background.
    h.advance(200_000, false);
    expect(h.idle()).toBe(0);
    h.timer.foreground();
    expect(h.idle()).toBe(1);
  });

  it("resumes with the remaining time after a short trip to the background", () => {
    const h = harness(120_000);
    h.timer.start();
    h.advance(60_000);
    h.timer.background();
    h.advance(30_000, false);
    h.timer.foreground();
    expect(h.idle()).toBe(0);
    h.advance(29_999);
    expect(h.idle()).toBe(0);
    h.advance(1);
    expect(h.idle()).toBe(1);
  });

  it("ignores touches while in the background", () => {
    const h = harness(30_000);
    h.timer.start();
    h.timer.background();
    h.advance(40_000, false);
    h.timer.touch();
    h.timer.foreground();
    expect(h.idle()).toBe(1);
  });

  it("re-checks the clock when a timer fires early", () => {
    const h = harness(30_000);
    h.timer.start();
    h.advance(10_000);
    h.timer.touch(); // deadline moves to t+40s; the old timer was replaced
    h.advance(20_000);
    expect(h.idle()).toBe(0);
    h.advance(10_000);
    expect(h.idle()).toBe(1);
  });

  it("applies a shorter timeout at once, keeping the time already elapsed", () => {
    const h = harness(120_000);
    h.timer.start();
    h.advance(45_000);
    h.timer.setTimeoutMs(30_000);
    expect(h.idle()).toBe(1);
  });

  it("does nothing once stopped", () => {
    const h = harness(30_000);
    h.timer.start();
    h.timer.stop();
    h.advance(60_000);
    h.timer.foreground();
    h.timer.touch();
    expect(h.idle()).toBe(0);
    expect(h.pendingTimers()).toBe(0);
  });

  it("rejects a non-positive timeout", () => {
    expect(() => harness(0)).toThrow(RangeError);
    expect(() => harness(30_000).timer.setTimeoutMs(-1)).toThrow(RangeError);
  });
});
