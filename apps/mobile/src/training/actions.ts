/**
 * What the phone writes while a course runs offline (mobile slice 72): rows in `elearning_outbox`,
 * each with a client UUID, sent when there is a connection (`sync/training-upload.ts`), and the
 * phone's own record of the attempt, so it resumes where the member left off. Pure.
 */
import { attemptOutcome, nextAttemptStatus, xapiOutcome } from "@harbour/domain";
import {
  type OfflineAttempt,
  type OfflineManifest,
  STATEMENTS_PER_ATTEMPT_MAX,
} from "./offline-plan";
import type { RuntimeMessage } from "./offline-runtime";

export interface Statement {
  readonly sql: string;
  readonly params: (string | null)[];
}

export const INSERT_OUTBOX_SQL = `INSERT INTO elearning_outbox (id, tenant_id, action, attempt_id,
  body, queued_at) VALUES (?, ?, ?, ?, ?, ?)`;

/** The attempt, started on the phone by its own id: the outbox row's id is the attempt's. */
export function startStatement(input: {
  readonly attemptId: string;
  readonly tenantId: string;
  readonly manifest: OfflineManifest;
  readonly at: Date;
}): Statement {
  return {
    sql: INSERT_OUTBOX_SQL,
    params: [
      input.attemptId,
      input.tenantId,
      "start",
      input.attemptId,
      JSON.stringify({
        courseId: input.manifest.courseId,
        packageSha256: input.manifest.packageSha256,
      }),
      input.at.toISOString(),
    ],
  };
}

/**
 * What the course reported, queued: a SCORM commit as it is, xAPI statements each with an id
 * (given here when the course left it out), so a resend is kept once.
 */
export function messageStatement(input: {
  readonly id: string;
  readonly attemptId: string;
  readonly tenantId: string;
  readonly message: RuntimeMessage;
  readonly at: Date;
  readonly newId: () => string;
}): Statement {
  const body =
    input.message.type === "commit"
      ? { cmi: input.message.cmi, finished: input.message.finished }
      : input.message.statements.map((s) =>
          typeof s.id === "string" &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.id)
            ? s
            : { ...s, id: input.newId() },
        );
  return {
    sql: INSERT_OUTBOX_SQL,
    params: [
      input.id,
      input.tenantId,
      input.message.type === "commit" ? "commit" : "statements",
      input.attemptId,
      JSON.stringify(body),
      input.at.toISOString(),
    ],
  };
}

/**
 * Commits held back while a course runs (security review of slice 72, M2): the elements of a
 * waiting commit with a newer one's on top, so only the latest of each is queued, at most every
 * `COMMIT_GAP_MS`; a finishing commit carries everything waiting.
 */
export function mergeCommits(
  waiting: Extract<RuntimeMessage, { type: "commit" }> | null,
  next: Extract<RuntimeMessage, { type: "commit" }>,
): Extract<RuntimeMessage, { type: "commit" }> {
  if (!waiting) return next;
  return { type: "commit", cmi: { ...waiting.cmi, ...next.cmi }, finished: next.finished };
}

/**
 * Statements a course may still queue for an attempt: none beyond what the server keeps, so a
 * course can never fill the phone (M2).
 */
export function statementsAllowed(attempt: OfflineAttempt, count: number): boolean {
  return (attempt.statementsQueued ?? 0) + count <= STATEMENTS_PER_ATTEMPT_MAX;
}

/** The phone's record of the attempt after a message, by the same rules as the server's. */
export function nextLocalAttempt(
  attempt: OfflineAttempt,
  standard: OfflineManifest["standard"],
  message: RuntimeMessage,
): OfflineAttempt {
  if (message.type === "commit") {
    if (standard === "xapi") return attempt;
    const outcome = attemptOutcome(standard, message.cmi);
    const location = message.cmi["cmi.core.lesson_location"] ?? message.cmi["cmi.location"];
    const suspend = message.cmi["cmi.suspend_data"];
    return {
      ...attempt,
      status: nextAttemptStatus(attempt.status, outcome.status),
      location: location ?? attempt.location,
      suspendData: suspend ?? attempt.suspendData,
    };
  }
  let status = attempt.status;
  const statementsQueued = (attempt.statementsQueued ?? 0) + message.statements.length;
  for (const s of message.statements) {
    const verb = (s.verb as { id?: unknown } | undefined)?.id;
    const scaled = (s.result as { score?: { scaled?: unknown } } | undefined)?.score?.scaled;
    const outcome = xapiOutcome(
      typeof verb === "string" ? verb : "",
      typeof scaled === "number" ? scaled : null,
    );
    if (outcome) status = nextAttemptStatus(status, outcome.status);
  }
  return { ...attempt, status, statementsQueued };
}
