import type { ImportBatch } from "@harbour/contracts";
import {
  auditEvent,
  importBatch,
  importCommit,
  importRow,
  location,
  person,
  type Transaction,
} from "@harbour/db";
import {
  type ExistingPerson,
  IMPORT_RATE_KEYS,
  type ImportBatchStatus,
  type ImportRecordType,
  importUndoClosesAt,
  type PeopleDryRun,
  peopleDryRun,
  ukIsoDate,
} from "@harbour/domain";
import { and, asc, count, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { rateNumber } from "./rates";

/**
 * The import wizard's database work (PLAT-014; platform.md rules 18 to 26; ADR-0092; HZ-130). Every
 * read and write runs in the caller's request context (`withTenant`, row-level security scoped to
 * the whole organisation, rule 18). Nothing here logs or audits a value: ids, counts and codes.
 */

export type BatchRow = typeof importBatch.$inferSelect;
export type CommitRow = typeof importCommit.$inferSelect;

type Nation = "england" | "wales" | "scotland" | "northern_ireland";

/** A location of the organisation that is still open, with its nation, or null. */
export async function openLocation(
  tx: Transaction,
  locationId: string,
): Promise<{ id: string; nation: Nation } | null> {
  const [found] = await tx
    .select({ id: location.id, nation: location.nation, deletedAt: location.deletedAt })
    .from(location)
    .where(eq(location.id, locationId));
  return found && found.deletedAt === null
    ? { id: found.id, nation: found.nation as Nation }
    : null;
}

/** The nation whose rates apply to a batch: its location's. */
async function nationOf(tx: Transaction, locationId: string): Promise<Nation> {
  const [found] = await tx
    .select({ nation: location.nation })
    .from(location)
    .where(eq(location.id, locationId));
  return (found?.nation ?? "england") as Nation;
}

/** `import.staging_expiry_days` and `import.undo_window_days` for a location (rates.md). */
export async function importRates(
  tx: Transaction,
  tenantId: string,
  locationId: string,
): Promise<{ stagingExpiryDays: number; undoWindowDays: number }> {
  const nation = await nationOf(tx, locationId);
  return {
    stagingExpiryDays: await rateNumber(tx, tenantId, IMPORT_RATE_KEYS.stagingExpiryDays, nation),
    undoWindowDays: await rateNumber(tx, tenantId, IMPORT_RATE_KEYS.undoWindowDays, nation),
  };
}

/** A batch as the API shows it: opaque ids, counts and times, never a value. */
export function batchOut(
  batch: BatchRow,
  commit: CommitRow | undefined,
  undoWindowDays: number,
): ImportBatch {
  const committed = batch.status === "committed" || batch.status === "undone";
  return {
    id: batch.id,
    recordType: batch.recordType as ImportRecordType,
    locationId: batch.locationId,
    status: batch.status as ImportBatchStatus,
    rows: batch.rowCount,
    uploadedBy: batch.uploadedBy,
    uploadedAt: batch.uploadedAt.toISOString(),
    expiresAt: batch.expiresAt.toISOString(),
    dryRunAt: batch.dryRunAt?.toISOString() ?? null,
    dryRunErrors: batch.dryRunErrors,
    dryRunWarnings: batch.dryRunWarnings,
    closedAt: batch.closedAt?.toISOString() ?? null,
    records: committed && commit ? commit.recordCount : null,
    committedAt: committed && commit ? commit.committedAt.toISOString() : null,
    undoClosesAt:
      batch.status === "committed" && commit
        ? importUndoClosesAt(commit.committedAt, { undoWindowDays }).toISOString()
        : null,
    undoneAt: commit?.undoneAt?.toISOString() ?? null,
  };
}

/** One batch the request can reach, locked for the rest of the transaction when asked; or null. */
export async function findBatch(
  tx: Transaction,
  id: string,
  lock = false,
): Promise<BatchRow | null> {
  const query = tx.select().from(importBatch).where(eq(importBatch.id, id));
  const [found] = lock ? await query.for("update") : await query;
  return found ?? null;
}

export async function findCommit(tx: Transaction, batchId: string): Promise<CommitRow | undefined> {
  const [found] = await tx.select().from(importCommit).where(eq(importCommit.batchId, batchId));
  return found;
}

/** The staged rows of a batch, in file order, as text keyed by field. */
export async function stagedRows(
  tx: Transaction,
  batchId: string,
): Promise<Record<string, string>[]> {
  const rows = await tx
    .select({ cells: importRow.cells })
    .from(importRow)
    .where(eq(importRow.batchId, batchId))
    .orderBy(asc(importRow.rowNumber));
  return rows.map((r) => {
    const cells: Record<string, string> = {};
    for (const [key, value] of Object.entries(r.cells as Record<string, unknown>)) {
      if (typeof value === "string") cells[key] = value;
    }
    return cells;
  });
}

/**
 * The people already in the organisation that a batch's rows could match (rule 21): by NHS
 * number, local identifier or date of birth. Read under the request's row-level security, which
 * rule 18 makes the whole organisation and never another's; soft-deleted people count (their NHS
 * numbers are still taken). Only what matching reads.
 */
export async function peopleToMatch(
  tx: Transaction,
  rows: readonly Readonly<Record<string, string>>[],
  today: string,
): Promise<ExistingPerson[]> {
  // The rows' own identifiers as they will be stored (`peopleDryRun` normalises the same way).
  const { validation } = peopleDryRun(rows, [], today);
  const nhs = [...new Set(validation.rows.flatMap((r) => (r.nhs_number ? [r.nhs_number] : [])))];
  const local = [
    ...new Set(validation.rows.flatMap((r) => (r.local_identifier ? [r.local_identifier] : []))),
  ];
  const births = [
    ...new Set(validation.rows.flatMap((r) => (r.date_of_birth ? [r.date_of_birth] : []))),
  ];
  const conditions = [
    nhs.length > 0 ? inArray(person.nhsNumber, nhs) : undefined,
    local.length > 0 ? inArray(person.localIdentifier, local) : undefined,
    births.length > 0 ? inArray(person.dateOfBirth, births) : undefined,
  ].filter((c) => c !== undefined);
  if (conditions.length === 0) return [];
  return tx
    .select({
      nhsNumber: person.nhsNumber,
      localIdentifier: person.localIdentifier,
      givenName: person.givenName,
      familyName: person.familyName,
      dateOfBirth: person.dateOfBirth,
    })
    .from(person)
    .where(or(...conditions));
}

/** The dry run as it stands now: validation and matching, committing nothing (rule 22). */
export async function dryRunNow(
  tx: Transaction,
  batchId: string,
): Promise<{
  readonly rows: Record<string, string>[];
  readonly validation: ReturnType<typeof peopleDryRun>["validation"];
  readonly report: PeopleDryRun;
}> {
  const today = ukIsoDate(new Date());
  const rows = await stagedRows(tx, batchId);
  const existing = await peopleToMatch(tx, rows, today);
  return { rows, ...peopleDryRun(rows, existing, today) };
}

/** How many of a commit's people are still exactly as imported (version 1, not soft-deleted). */
export async function unchangedPeople(tx: Transaction, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const [row] = await tx
    .select({ n: count() })
    .from(person)
    .where(and(inArray(person.id, [...ids]), eq(person.version, 1), isNull(person.deletedAt)));
  return Number(row?.n ?? 0);
}

export const EXPIRED = "platform.import.expired";

/**
 * The expiry sweep (rule 25), as the system in one organisation's view: every staged batch past
 * its `expires_at` on the database's clock (the guard judges by that clock too) is expired, which
 * deletes its staged rows in the same transaction (`app.import_batch_closed`), and audited with
 * the row count.
 */
export async function expireImportBatches(tx: Transaction, tenantId: string): Promise<number> {
  const expired = await tx
    .update(importBatch)
    .set({ status: "expired", closedAt: sql`now()` })
    .where(and(eq(importBatch.status, "staged"), lte(importBatch.expiresAt, sql`now()`)))
    .returning({ id: importBatch.id, rows: importBatch.rowCount });
  if (expired.length > 0) {
    await tx.insert(auditEvent).values(
      expired.map((b) => ({
        tenantId,
        action: EXPIRED,
        resourceType: "import_batch",
        resourceId: b.id,
        scope: { rows: b.rows, job: "import-expiry" },
      })),
    );
  }
  return expired.length;
}
