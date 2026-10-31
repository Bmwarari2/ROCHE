import type { ImportBatch } from "@harbour/contracts";
import {
  auditEvent,
  importBatch,
  importCommit,
  importRow,
  location,
  person,
  type Transaction,
  task,
} from "@harbour/db";
import {
  type ExistingPerson,
  IMPORT_RATE_KEYS,
  type ImportBatchStatus,
  type ImportRecordType,
  importUndoClosesAt,
  type PeopleDryRun,
  type PeopleImportOptions,
  peopleDryRun,
  ukIsoDate,
} from "@harbour/domain";
import { OFFLINE_WINDOW_RATE_KEY, SYNC_TOKEN_TTL_SECONDS } from "@harbour/sync/streams";
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
  /** The latest sync token carrying people issued in the organisation, if any. */
  latestPeopleToken: Date | null,
  now: Date = new Date(),
): ImportBatch {
  const committed = batch.status === "committed" || batch.status === "undone";
  const undo = commit
    ? undoState(batch.status as ImportBatchStatus, commit, undoWindowDays, latestPeopleToken, now)
    : { available: false, closesAt: null };
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
    undoAvailable: undo.available,
    undoClosesAt: undo.closesAt,
    undoneAt: commit?.undoneAt?.toISOString() ?? null,
  };
}

/**
 * Whether a commit can be undone now, and until when (#150 clinical review M-C): committed and not
 * undone, within `import.undo_window_days`, and no phone may hold the people yet: no sync token
 * carrying people issued since one token's lifetime before the commit. The database decides again
 * when an undo is asked for (`app.undo_import_batch`).
 */
export function undoState(
  status: ImportBatchStatus,
  commit: Pick<CommitRow, "committedAt" | "undoneAt">,
  undoWindowDays: number,
  latestPeopleToken: Date | null,
  now: Date,
): { readonly available: boolean; readonly closesAt: string | null } {
  const closes = importUndoClosesAt(commit.committedAt, { undoWindowDays });
  const available =
    status === "committed" &&
    commit.undoneAt === null &&
    now.getTime() <= closes.getTime() &&
    !mayBeOnPhones(commit.committedAt, latestPeopleToken);
  return { available, closesAt: available ? closes.toISOString() : null };
}

/**
 * Whether phones may hold a commit's people: a sync token carrying people was issued from one
 * token's lifetime before the commit (a token issued just before it can still fetch them).
 */
export function mayBeOnPhones(committedAt: Date, latestPeopleToken: Date | null): boolean {
  return (
    latestPeopleToken !== null &&
    latestPeopleToken.getTime() >= committedAt.getTime() - SYNC_TOKEN_TTL_SECONDS * 1000
  );
}

/**
 * The latest sync token carrying people at any home issued in the organisation (the
 * `sync.token.issue` audit event), or null: phones may hold whatever was in Harbour then.
 */
export async function latestPeopleToken(tx: Transaction): Promise<Date | null> {
  const { rows } = await tx.execute<{ at: string | Date | null }>(
    sql`SELECT max(a.occurred_at) AS at FROM audit_event a
         WHERE a.tenant_id = app.current_tenant_id() AND a.action = 'sync.token.issue'
           AND coalesce(a.scope ->> 'peopleLocations', '0') ~ '^[0-9]+$'
           AND (a.scope ->> 'peopleLocations')::integer > 0`,
  );
  const at = rows[0]?.at;
  return at ? new Date(at) : null;
}

/**
 * Whether phones are in use in the organisation (#150 clinical review M-B): a sync token carrying
 * people was issued within the offline window (`mobile.offline_window_days` for the batch's home).
 * Then an import cannot be undone once committed, and the importer must accept that.
 */
export async function phonesInUse(
  tx: Transaction,
  tenantId: string,
  locationId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const latest = await latestPeopleToken(tx);
  if (!latest) return false;
  const nation = await nationOf(tx, locationId);
  const windowDays = await rateNumber(tx, tenantId, OFFLINE_WINDOW_RATE_KEY, nation);
  return latest.getTime() >= now.getTime() - windowDays * 86_400_000;
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
  options: PeopleImportOptions,
): Promise<ExistingPerson[]> {
  // The rows' own identifiers as they will be stored (`peopleDryRun` normalises the same way).
  const { validation } = peopleDryRun(rows, [], options);
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
      id: person.id,
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
  options: { readonly allowTestNhsNumbers: boolean; readonly phonesInUse: boolean },
): Promise<{
  readonly rows: Record<string, string>[];
  readonly validation: ReturnType<typeof peopleDryRun>["validation"];
  readonly report: PeopleDryRun;
}> {
  const today = ukIsoDate(new Date());
  const checks = { today, ...options };
  const rows = await stagedRows(tx, batchId);
  const existing = await peopleToMatch(tx, rows, checks);
  return { rows, ...peopleDryRun(rows, existing, checks) };
}

export type StatedAllergyStatus = "no_known_allergies" | "has_allergies";

export interface AllergyStatusToConfirm {
  readonly personId: string;
  readonly taskId: string;
  readonly stated: StatedAllergyStatus;
}

export const ALLERGY_STATUS_CHECK = "people.allergy_status_check";

/** Plain words naming what the file said; never anything else from it. */
const ALLERGY_CHECK_TITLES: Readonly<Record<StatedAllergyStatus, string>> = {
  has_allergies:
    "Record this person's allergies: the previous system said they have allergies, which were not imported",
  no_known_allergies:
    "Check this person's allergy status: the previous system said no known allergies, which was not imported",
};

/**
 * The identifier a committed person is paired with their row by (#150 clinical review M-A): their
 * NHS number, else their local identifier. Every committed row has one (`identifier_required`) and
 * no two rows of a committed file share either (`duplicate`), so each person pairs with exactly
 * their own row whatever order the database returns them in.
 */
function pairingKey(
  nhsNumber: string | null | undefined,
  localIdentifier: string | null | undefined,
): string | null {
  if (nhsNumber) return `nhs:${nhsNumber}`;
  if (localIdentifier) return `local:${localIdentifier}`;
  return null;
}

/** What each validated row's file said about allergy status, by identifier, when not unknown. */
export function statedAllergyStatusByIdentifier(
  rows: readonly Readonly<Record<string, string>>[],
): ReadonlyMap<string, StatedAllergyStatus> {
  const stated = new Map<string, StatedAllergyStatus>();
  for (const row of rows) {
    const status = row.allergy_status;
    if (status !== "no_known_allergies" && status !== "has_allergies") continue;
    const key = pairingKey(row.nhs_number, row.local_identifier);
    if (key === null || stated.has(key)) throw new Error("import row without its own identifier");
    stated.set(key, status);
  }
  return stated;
}

/**
 * HZ-007 (#150 clinical review M-A): one task per person whose file stated an allergy status, for
 * whoever records it on their record (people.person.update, assigned to the registered manager,
 * due now; urgent when the file said they have allergies), carrying what the file said as a code
 * (`TaskDetails.importedAllergyStatus`). Every stated status must pair with a person created, or
 * the whole commit fails. Ordered by person id.
 */
export async function raiseAllergyStatusChecks(
  tx: Transaction,
  batch: Pick<BatchRow, "id" | "locationId">,
  stated: ReadonlyMap<string, StatedAllergyStatus>,
  created: readonly {
    readonly id: string;
    readonly nhsNumber: string | null;
    readonly localIdentifier: string | null;
  }[],
  now: Date = new Date(),
): Promise<AllergyStatusToConfirm[]> {
  const pairs = created.flatMap((p) => {
    const key = pairingKey(p.nhsNumber, p.localIdentifier);
    const status = key === null ? undefined : stated.get(key);
    return status ? [{ personId: p.id, stated: status }] : [];
  });
  if (pairs.length !== stated.size) throw new Error("import allergy statuses not all paired");
  const raised: AllergyStatusToConfirm[] = [];
  for (let start = 0; start < pairs.length; start += 500) {
    const chunk = pairs.slice(start, start + 500);
    const made = await tx
      .insert(task)
      .values(
        chunk.map((p) => ({
          kind: ALLERGY_STATUS_CHECK,
          title: ALLERGY_CHECK_TITLES[p.stated],
          requiredPermission: "people.person.update",
          personId: p.personId,
          locationId: batch.locationId,
          sourceType: "import_batch",
          sourceId: batch.id,
          assigneeRoleKey: "registered_manager",
          dueAt: now,
          priority: p.stated === "has_allergies" ? "urgent" : "routine",
          details: { importedAllergyStatus: p.stated },
        })),
      )
      .returning({ id: task.id, personId: task.personId });
    const statedFor = new Map(chunk.map((p) => [p.personId, p.stated]));
    for (const t of made) {
      const status = t.personId ? statedFor.get(t.personId) : undefined;
      if (!t.personId || !status) throw new Error("import allergy check without its person");
      raised.push({ personId: t.personId, taskId: t.id, stated: status });
    }
  }
  return raised.sort((a, b) => a.personId.localeCompare(b.personId));
}

/** The allergy status checks a commit raised that are still there (a replay lists them again). */
export async function allergyStatusChecks(
  tx: Transaction,
  batchId: string,
): Promise<AllergyStatusToConfirm[]> {
  const rows = await tx
    .select({ id: task.id, personId: task.personId, details: task.details })
    .from(task)
    .where(
      and(
        eq(task.kind, ALLERGY_STATUS_CHECK),
        eq(task.sourceType, "import_batch"),
        eq(task.sourceId, batchId),
        isNull(task.deletedAt),
      ),
    );
  return rows
    .flatMap((t): AllergyStatusToConfirm[] => {
      const stated = (t.details as { importedAllergyStatus?: unknown } | null)
        ?.importedAllergyStatus;
      return t.personId && (stated === "no_known_allergies" || stated === "has_allergies")
        ? [{ personId: t.personId, taskId: t.id, stated }]
        : [];
    })
    .sort((a, b) => a.personId.localeCompare(b.personId));
}

/**
 * A database failure while writing imported values, carrying only the database's code (#150
 * security review H1): a failed query's message holds its parameters (names, dates of birth, NHS
 * numbers), so the original error, and with it its message and cause, never travels further.
 */
export class ImportWriteFailed extends Error {
  constructor(readonly code: string | null) {
    super(`An import write failed (SQLSTATE ${code ?? "unknown"}).`);
    this.name = "ImportWriteFailed";
  }
}

/** The database's code of an error from the driver, or its query builder's wrapper. */
export function sqlState(error: unknown): string | null {
  const e = error as { code?: unknown; cause?: { code?: unknown } };
  const code = typeof e.cause?.code === "string" ? e.cause.code : e.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

/** Runs a write of imported values; any database failure is rethrown as its code alone. */
export async function writingImported<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    throw new ImportWriteFailed(sqlState(error));
  }
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
