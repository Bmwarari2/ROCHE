import { afterEach, describe, expect, it } from "vitest";
import { forgetAnswered, isAnswered, rememberAnswered } from "./answered-tasks";

describe("hazard HZ-029 a round task is answered by one entry from this device (#123 clinical review, M1)", () => {
  afterEach(() => forgetAnswered());

  it("stays answered after its entry uploads and the synced copy drops the task", () => {
    expect(isAnswered("t-1")).toBe(false);
    // The entry saved with task_id t-1 (useSaveEntry remembers it).
    rememberAnswered("t-1");
    // A sync replaces the entry with the server's copy, which has no task_id: the device's
    // entries no longer say the task was answered (queries.test.ts), but this still does.
    expect(isAnswered("t-1")).toBe(true);
    expect(isAnswered("t-2")).toBe(false);
  });

  it("forgets on sign-out", () => {
    rememberAnswered("t-1");
    forgetAnswered();
    expect(isAnswered("t-1")).toBe(false);
  });
});
