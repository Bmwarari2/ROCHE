import type { Logger } from "../logger";

/** The structured log line a failed worker job writes; the operator alarms on it (on-call.md). */
export const WORKER_JOB_FAILED_EVENT = "worker.job.failed";

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
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : null;
    logger.error(
      {
        event: WORKER_JOB_FAILED_EVENT,
        queue,
        error: error instanceof Error ? error.name : "Error",
        code,
      },
      WORKER_JOB_FAILED_EVENT,
    );
    throw error;
  }
}
