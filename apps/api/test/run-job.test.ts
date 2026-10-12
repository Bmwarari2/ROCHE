import { describe, expect, it } from "vitest";
import { errorCode, runJob, WORKER_JOB_FAILED_EVENT } from "../src/jobs/run-job";
import type { Logger } from "../src/logger";

/** A logger that keeps what was written at error level, as the alarm's log group would. */
function capture() {
  const lines: { fields: Record<string, unknown>; message: string }[] = [];
  const logger = {
    error: (fields: Record<string, unknown>, message: string) => lines.push({ fields, message }),
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
  } as unknown as Logger;
  return { lines, logger };
}

/**
 * Hazards HZ-008 and HZ-013 (ADR-0071 review round 5, C5-M1): every worker job that fails writes
 * one structured line, `worker.job.failed`, which the operator's alarm matches (`{ $.event =
 * "worker.job.failed" }`), with the queue's name and the error's kind only, and the job still
 * fails so pg-boss retries it.
 */
describe("hazard HZ-008 hazard HZ-013 a failed worker job is logged for the operator's alarm", () => {
  it("writes nothing when the job succeeds", async () => {
    const { lines, logger } = capture();
    await runJob(logger, "task-escalations", async () => 3);
    expect(lines).toEqual([]);
  });

  it("writes one structured line with the queue and the error's kind, never its message, and fails the job", async () => {
    const { lines, logger } = capture();
    const failure = Object.assign(new Error("duplicate key for Ada Example"), { code: "23505" });
    await expect(
      runJob(logger, "task-escalations", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(lines).toEqual([
      {
        fields: {
          event: WORKER_JOB_FAILED_EVENT,
          queue: "task-escalations",
          error: "Error",
          code: "23505",
        },
        message: "worker.job.failed",
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain("Ada");
  });

  it("names the database code of a driver error the query builder wraps", async () => {
    const { lines, logger } = capture();
    const wrapped = new Error("Failed query: insert into notification", {
      cause: Object.assign(new Error("injected failure"), { code: "P0001" }),
    });
    await expect(
      runJob(logger, "task-escalations", async () => {
        throw wrapped;
      }),
    ).rejects.toBe(wrapped);
    expect(lines[0]?.fields).toMatchObject({ error: "Error", code: "P0001" });
    expect(errorCode({ code: 42 })).toBe("42");
    expect(errorCode("text")).toBeNull();
  });

  it("names no code when the error has none", async () => {
    const { lines, logger } = capture();
    await expect(
      runJob(logger, "unrouted-daily-report", async () => {
        throw new TypeError("bad");
      }),
    ).rejects.toThrow(TypeError);
    expect(lines[0]?.fields).toEqual({
      event: "worker.job.failed",
      queue: "unrouted-daily-report",
      error: "TypeError",
      code: null,
    });
  });
});
