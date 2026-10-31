import {
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

/** Where a course's package is kept, read in the organisation's own context (the document row). */
export async function packageLocation(
  db: Database,
  tenantId: string,
  documentId: string,
): Promise<{ storageKey: string; sha256: string; status: string } | null> {
  return asSystem(db, tenantId, async (tx) => {
    const [row] = await tx
      .select({ storageKey: document.storageKey, sha256: document.sha256, status: document.status })
      .from(document)
      .where(eq(document.id, documentId));
    return row ?? null;
  });
}

/**
 * A small in-memory cache of stored packages by SHA-256, so the many files of one launch do not
 * each read the whole archive from storage. Bounded by count and bytes; contents are checked
 * against the hash when read.
 */
export class PackageCache {
  private readonly entries = new Map<string, Buffer>();
  constructor(
    private readonly maxEntries = 3,
    private readonly maxBytes = 300 * 1024 * 1024,
  ) {}
  get(sha: string): Buffer | undefined {
    const found = this.entries.get(sha);
    if (found) {
      this.entries.delete(sha);
      this.entries.set(sha, found);
    }
    return found;
  }
  set(sha: string, bytes: Buffer): void {
    this.entries.set(sha, bytes);
    let total = [...this.entries.values()].reduce((n, b) => n + b.length, 0);
    for (const key of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries && total <= this.maxBytes) break;
      total -= this.entries.get(key)?.length ?? 0;
      this.entries.delete(key);
    }
  }
}
