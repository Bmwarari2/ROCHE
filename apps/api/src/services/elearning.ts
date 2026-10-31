import {
  auditEvent,
  type Database,
  document,
  elearningAttempt,
  elearningCourse,
  type Transaction,
  trainingRecord,
  withRequestContext,
} from "@harbour/db";
import { type AttemptStatus, completesTraining, ukIsoDate } from "@harbour/domain";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { LaunchClaims } from "./elearning-package";

/**
 * E-learning attempts and completions (workforce.md section 14; ADR-0093). A completion is kept
 * as a slice 17 training record, written by the organisation's own system context (the member
 * never writes their own training record), once per attempt, under a row lock so two commits at
 * once make one record.
 */

export type CourseRow = typeof elearningCourse.$inferSelect;
export type AttemptRow = typeof elearningAttempt.$inferSelect;

export const COURSE_SOURCE = "elearning_course";
export const ATTEMPT_SOURCE = "elearning_attempt";

/** The organisation's own context: no member, organisation-wide (`app.is_system()`). */
export function asSystem<T>(db: Database, tenantId: string, fn: (tx: Transaction) => Promise<T>) {
  return withRequestContext(db, { tenantId, userId: null, scope: "tenant", locationIds: [] }, fn);
}

/**
 * The member a launch token was made for, and nothing wider: their own attempts and statements
 * (`app.reads_own_development`), while they still hold a staff role (scope none, no locations).
 */
export function asLauncher<T>(
  db: Database,
  claims: LaunchClaims,
  fn: (tx: Transaction) => Promise<T>,
) {
  return withRequestContext(
    db,
    { tenantId: claims.tenantId, userId: claims.workerId, scope: "none", locationIds: [] },
    fn,
  );
}

const PROVIDER_PREFIX = "Harbour e-learning: ";

/** The training record provider for a course: its title, within the column's 160 characters. */
export function providerOf(title: string): string {
  return `${PROVIDER_PREFIX}${title}`.slice(0, 160);
}

/**
 * Records a completed or passed attempt as a training record, once. Returns the record's id, or
 * null when the attempt has not completed (or a record was already made).
 */
export async function recordCompletion(
  db: Database,
  tenantId: string,
  attemptId: string,
  /** How the completion arrived, for its audit event: the member's session or a launch token. */
  via: { readonly by: "session" | "launch_token"; readonly requestId: string | null },
): Promise<string | null> {
  return asSystem(db, tenantId, async (tx) => {
    const locked = await tx.execute<{
      id: string;
      worker_id: string;
      status: AttemptStatus;
      training_record_id: string | null;
      course_id: string;
    }>(
      sql`SELECT id, worker_id, status, training_record_id, course_id FROM elearning_attempt
           WHERE id = ${attemptId} FOR UPDATE`,
    );
    const attempt = locked.rows[0];
    if (!attempt || attempt.training_record_id || !completesTraining(attempt.status)) return null;
    const [course] = await tx
      .select()
      .from(elearningCourse)
      .where(eq(elearningCourse.id, attempt.course_id));
    if (!course) return null;
    const [record] = await tx
      .insert(trainingRecord)
      .values({
        workerId: attempt.worker_id,
        topic: course.topic,
        tier: course.tier,
        completedOn: ukIsoDate(new Date()),
        provider: providerOf(course.title),
      })
      .returning({ id: trainingRecord.id });
    if (!record) throw new Error("training record not stored");
    await tx
      .update(elearningAttempt)
      .set({ trainingRecordId: record.id })
      .where(eq(elearningAttempt.id, attemptId));
    // Audited with the completion, in the same transaction, however it arrived (review M2): the
    // member it is about, and whether their session or a launch token reported it.
    await tx.insert(auditEvent).values({
      tenantId,
      actorTenantUserId: via.by === "session" ? attempt.worker_id : null,
      action: "workforce.elearning_attempt.completed",
      resourceType: "elearning_attempt",
      resourceId: attemptId,
      scope: {
        subjectTenantUserId: attempt.worker_id,
        via: via.by,
        trainingRecordId: record.id,
        courseId: attempt.course_id,
      },
      requestId: via.requestId,
    });
    return record.id;
  });
}

/** The member's latest attempt at each course (the course list shows it). */
export async function latestAttempts(
  tx: Transaction,
  workerId: string,
): Promise<Map<string, AttemptRow>> {
  const rows = await tx
    .select()
    .from(elearningAttempt)
    .where(and(eq(elearningAttempt.workerId, workerId), isNull(elearningAttempt.deletedAt)))
    .orderBy(desc(elearningAttempt.createdAt));
  const out = new Map<string, AttemptRow>();
  for (const row of rows) if (!out.has(row.courseId)) out.set(row.courseId, row);
  return out;
}

/**
 * A course's stored package as it is now, read in the organisation's own context: only an
 * available e-learning package document (a quarantined, destroyed or removed one is never served,
 * and never another category; review L1).
 */
export async function packageOf(
  db: Database,
  tenantId: string,
  documentId: string,
): Promise<{ storageKey: string; sha256: string } | null> {
  return asSystem(db, tenantId, async (tx) => {
    const [row] = await tx
      .select({ storageKey: document.storageKey, sha256: document.sha256 })
      .from(document)
      .where(
        and(
          eq(document.id, documentId),
          eq(document.category, "elearning_package"),
          eq(document.status, "available"),
          isNull(document.deletedAt),
        ),
      );
    return row ?? null;
  });
}
