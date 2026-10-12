import type { Logger } from "../logger";

/** The structured log line a failed worker job writes; the operator alarms on it (on-call.md). */
export const WORKER_JOB_FAILED_EVENT = "worker.job.failed";

/**
 * The database code of an error (such as `23505` or `P0001`), from the error itself or from the
 * driver error the query builder wraps in `cause`; null when it has none. Opaque, never a message.
 */
export function errorCode(error: unknown): string | null {
  for (let at: unknown = error, depth = 0; depth < 3; depth++) {
    if (typeof at !== "object" || at === null) return null;
    if ("code" in at && (at as { code: unknown }).code !== undefined) {
      return String((at as { code: unknown }).code);
    }
    at = (at as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Runs one worker job. When it throws, one structured line is logged, `worker.job.failed`, with
 * the queue's name, the error's kind and its database code when it has one (opaque values only,
 * never a message, which may hold data), and the error is thrown on so pg-boss retries the job
 * (ADR-0071 review round 5, C5-M1).
 */
export async function runJob(logger: Logger, queue: string, job: () => Promise<unknown>) {
  try {
    await job();
  } catch (error) {
    logger.error(
      {
        event: WORKER_JOB_FAILED_EVENT,
        queue,
        error: error instanceof Error ? error.name : "Error",
        code: errorCode(error),
      },
      WORKER_JOB_FAILED_EVENT,
    );
    throw error;
  }
}
