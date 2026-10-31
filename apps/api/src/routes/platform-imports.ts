import {
  CommitImport,
  ImportBatch,
  ImportBatchList,
  ImportCommitResult,
  ImportDryRunReport,
  ImportUndoResult,
  UploadImport,
} from "@harbour/contracts";
import { importBatch, importCommit, importRow, person } from "@harbour/db";
import {
  checkPeopleCommit,
  IMPORT_FIELDS,
  IMPORT_LIMITS,
  type ImportLimits,
  importStagingExpiresAt,
  importUndoClosesAt,
  importUndoEligibility,
  mapImportColumns,
  type ParsedImportFile,
  type PeopleDryRun,
  parseImportCsv,
  sampleDataRefusal,
  stagedCells,
  UNDO_MESSAGES,
  type UndoProblem,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { desc, eq, sql } from "drizzle-orm";
import type { Context } from "hono";
import {
  AuditedRefusal,
  auditInTx,
  auditManyInTx,
  withAuditedRefusal,
  writeAudit,
} from "../http/audit";
import {
  type AppEnv,
  requirePermission,
  stepUpRefusal,
  type TenantAccess,
  withTenant,
} from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import {
  batchOut,
  dryRunNow,
  findBatch,
  findCommit,
  importRates,
  openLocation,
  unchangedPeople,
} from "../services/platform-imports";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";
import { dbCode } from "./people-shared";

/**
 * The import wizard's API (PLAT-014; platform.md rules 18 to 26; ADR-0092; HZ-130, HZ-007). Every
 * route needs platform.import.run and people.person.create across the whole organisation (rule 18:
 * an import by someone who sees only some homes could tell them a person they cannot see exists),
 * refused with one answer, before anything is read, to anyone who holds them only somewhere. A
 * batch is staged in quarantine, dry-run, committed whole (with a fresh step-up) or discarded, and
 * undone once within the window. No response, problem, log line or audit event carries an imported
 * value, a column heading or whose record a row matched: rows and columns by number and field key,
 * counts, and opaque ids.
 */

const UPLOADED = "platform.import.uploaded";
const READ = "platform.import.read";
const DRY_RUN = "platform.import.dry_run";
const COMMITTED = "platform.import.committed";
const UNDONE = "platform.import.undone";
const DISCARDED = "platform.import.discarded";
const IMPORTED = "people.person.imported";

/** The import permissions, and the answer to a holder whose reach stops short of the organisation. */
const ORGANISATION_WIDE = new HttpProblem(
  403,
  "organisation_wide_required",
  "Importing needs access to the whole organisation.",
  "Ask the owner to import, or to give you the import wizard across the organisation.",
);

/**
 * Rule 18: both permissions, each reaching the whole organisation, with MFA (care-record
 * permissions). Anyone else is refused, audited, before the request's batch or file is read; the
 * request then runs scoped to the whole organisation.
 */
async function requireImporter(c: Context<AppEnv>, action: string): Promise<TenantAccess> {
  await requirePermission(c, "platform.import.run");
  const access = await requirePermission(c, "people.person.create");
  if (access.context.scope !== "tenant") {
    await writeAudit(c.get("services").appPool, access, {
      action,
      outcome: "denied",
      reason: ORGANISATION_WIDE.code,
      requestId: c.get("requestId"),
    });
    throw ORGANISATION_WIDE;
  }
  return access;
}

/** Commit and undo create or remove care records in bulk: a fresh second factor first. */
async function requireStepUp(c: Context<AppEnv>, access: TenantAccess, action: string) {
  if (access.stepUpFresh) return;
  await writeAudit(c.get("services").appPool, access, {
    action,
    outcome: "denied",
    reason: "step_up_required",
    requestId: c.get("requestId"),
  });
  throw stepUpRefusal(access);
}

/** A refusal of a batch's state, audited by batch id and code after the transaction ends. */
function stateRefusal(action: string, batchId: string, code: string, message: string): never {
  throw new AuditedRefusal(new HttpProblem(409, code, "The import was not changed.", message), {
    action,
    outcome: "denied",
    reason: code,
    resourceType: "import_batch",
    resourceId: batchId,
  });
}

const NOT_STAGED =
  "This import can no longer be changed: it was committed, discarded or expired. Upload the file again to start over.";

// ------------------------------------------------------------------------------------------------
// Reading the upload (rule 19)
// ------------------------------------------------------------------------------------------------

type Upload = { readonly header: readonly string[]; readonly rows: readonly (readonly string[])[] };

/** JSON rows as a file: every key in order of first appearance is a column; values are text. */
function readJsonRows(rows: readonly Record<string, unknown>[], limits: ImportLimits): Upload {
  const header: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue;
      seen.add(key);
      header.push(key);
    }
  }
  if (header.length === 0) throw problems.invalid("The rows have no columns to import.");
  if (header.length > limits.columns) {
    throw problems.invalid(`The rows have more than ${limits.columns} columns.`);
  }
  if (header.some((h) => h.length > limits.cellCharacters)) {
    throw problems.invalid(`A column heading is longer than ${limits.cellCharacters} characters.`);
  }
  const out = rows.map((row, index) =>
    header.map((key) => {
      const value = row[key];
      if (value === undefined || value === null) return "";
      if (typeof value !== "string") {
        throw problems.invalid(
          `Row ${index + 1} has a value that is not text. Send every value as text.`,
        );
      }
      if (value.length > limits.cellCharacters) {
        throw problems.invalid(
          `Row ${index + 1} has a cell longer than ${limits.cellCharacters} characters.`,
        );
      }
      return value;
    }),
  );
  return { header, rows: out };
}

/** The upload as a header and rows, or a 422 naming a row or column by number only. */
function readUpload(body: UploadImport): Upload {
  if ((body.csv === undefined) === (body.rows === undefined)) {
    throw problems.invalid("Send the file as CSV text or as JSON rows, one or the other.");
  }
  if (body.rows !== undefined) return readJsonRows(body.rows, IMPORT_LIMITS);
  const parsed: ParsedImportFile = parseImportCsv(body.csv ?? "", IMPORT_LIMITS);
  if (!parsed.ok) throw problems.invalid(parsed.message);
  return parsed;
}

/** The mapping, checked: each value a field key or null; refused without echoing a heading. */
function readMapping(mapping: Record<string, unknown> | undefined): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [heading, field] of Object.entries(mapping ?? {})) {
    if (field !== null && typeof field !== "string") {
      throw problems.invalid("The mapping takes each column heading to a field key, or to null.");
    }
    out[heading] = field;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// Routes
// ------------------------------------------------------------------------------------------------

const BatchParam = z.object({ id: z.uuid() });

function reportOut(batchId: string, report: PeopleDryRun): ImportDryRunReport {
  return {
    batchId,
    rows: report.rows,
    validRows: report.validRows,
    errorCount: report.errorCount,
    warningCount: report.warningCount,
    byCode: { ...report.byCode } as Record<string, number>,
    mayCommit: report.mayCommit,
    errors: [...report.errors],
    warnings: [...report.warnings],
    truncated: report.truncated,
    allergyStatusUnknownRows: [...report.allergyStatusUnknownRows],
    allergiesToRecordRows: [...report.allergiesToRecordRows],
  };
}

/** The database's undo refusals in the domain's words. */
const UNDO_PROBLEMS: readonly UndoProblem[] = [
  "already_undone",
  "changed_since",
  "referenced_since",
];

function messageOf(error: unknown): string | undefined {
  const e = error as { message?: string; cause?: { message?: string } };
  return e.cause?.message ?? e.message;
}

/** The person columns an imported row fills (rule 23; data-standards.md). */
function personValues(row: Readonly<Record<string, string>>, locationId: string) {
  return {
    locationId,
    status: "active" as const,
    givenName: row.given_name ?? "",
    familyName: row.family_name ?? "",
    preferredName: row.preferred_name ?? null,
    dateOfBirth: row.date_of_birth ?? null,
    nhsNumber: row.nhs_number ?? null,
    localIdentifier: row.local_identifier ?? null,
    sexCode: row.sex_code ?? null,
    genderIdentity: row.gender_identity ?? null,
    // HZ-007: blank was stored as unknown by the rules; never assumed.
    allergyStatus: (row.allergy_status ?? "unknown") as
      | "unknown"
      | "no_known_allergies"
      | "has_allergies",
    postcode: row.postcode ?? null,
  };
}

export const platformImportsRouter = createRouter()
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/imports",
      tags: ["platform"],
      summary: "Upload a file to import",
      description:
        "platform.import.run and people.person.create, both across the whole organisation (403 organisation_wide_required otherwise, whatever the file holds). Takes a record type (people), a location of the organisation and either CSV text or JSON rows, matches each column to a Harbour field by the mapping or by its field key or label, and stages the matched cells in quarantine, never in anyone's record, until a dry run and a commit. A column that matches nothing, a mapping to no field or two columns for one field refuse the upload (422 columns_not_mapped); every problem names a row or column by number, never a heading or value. The batch expires import.staging_expiry_days after upload. Audited (platform.import.uploaded: batch id, rows and columns).",
      security,
      request: { body: { content: { "application/json": { schema: UploadImport } } } },
      responses: { 201: jsonBody(ImportBatch, "Staged"), ...errorResponses },
    }),
    async (c) => {
      const access = await requireImporter(c, UPLOADED);
      const body = c.req.valid("json");
      const upload = readUpload(body);
      const fields = IMPORT_FIELDS[body.recordType];
      const mapped = mapImportColumns(upload.header, fields, readMapping(body.mapping));
      if (!mapped.ok) {
        throw new HttpProblem(
          422,
          "columns_not_mapped",
          "Some columns need matching to Harbour fields.",
          mapped.errors.map((e) => e.message).join(" "),
        );
      }
      if (upload.rows.length === 0) throw problems.invalid("The file has no rows to import.");
      const out = await withTenant(c, async (tx) => {
        const home = await openLocation(tx, body.locationId);
        if (!home) throw problems.invalid("Choose one of the organisation's open locations.");
        const rates = await importRates(tx, access.tenantId, home.id);
        const now = new Date();
        const [batch] = await tx
          .insert(importBatch)
          .values({
            recordType: body.recordType,
            locationId: home.id,
            rowCount: upload.rows.length,
            uploadedAt: now,
            expiresAt: importStagingExpiresAt(now, rates),
          })
          .returning();
        if (!batch) throw new Error("import batch not created");
        const staged = upload.rows.map((row, index) => ({
          batchId: batch.id,
          rowNumber: index + 1,
          cells: stagedCells(row, mapped.fields),
        }));
        for (let start = 0; start < staged.length; start += 500) {
          await tx.insert(importRow).values(staged.slice(start, start + 500));
        }
        await auditInTx(tx, access, {
          action: UPLOADED,
          resourceType: "import_batch",
          resourceId: batch.id,
          scope: {
            recordType: body.recordType,
            rows: upload.rows.length,
            columns: mapped.fields.filter((f) => f !== null).length,
            columnsLeftOut: mapped.fields.filter((f) => f === null).length,
          },
          requestId: c.get("requestId"),
        });
        return batchOut(batch, undefined, rates.undoWindowDays);
      });
      return c.json(out, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/imports",
      tags: ["platform"],
      summary: "The organisation's imports",
      description:
        "platform.import.run and people.person.create across the whole organisation. The latest 100 batches, newest first: ids, counts and times, never a value. Audited (platform.import.read, the count).",
      security,
      responses: { 200: jsonBody(ImportBatchList, "Batches"), ...errorResponses },
    }),
    async (c) => {
      const access = await requireImporter(c, READ);
      const items = await withTenant(c, async (tx) => {
        const batches = await tx
          .select()
          .from(importBatch)
          .orderBy(desc(importBatch.uploadedAt), desc(importBatch.id))
          .limit(100);
        const commits = await tx.select().from(importCommit);
        const byBatch = new Map(commits.map((m) => [m.batchId, m]));
        const out = [];
        for (const batch of batches) {
          const rates = await importRates(tx, access.tenantId, batch.locationId);
          out.push(batchOut(batch, byBatch.get(batch.id), rates.undoWindowDays));
        }
        await auditInTx(tx, access, {
          action: READ,
          resourceType: "import_batch",
          scope: { batches: out.length },
          requestId: c.get("requestId"),
        });
        return out;
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/imports/{id}",
      tags: ["platform"],
      summary: "One import",
      description:
        "platform.import.run and people.person.create across the whole organisation. A batch of another organisation, or none, is 404 alike. Audited (platform.import.read, the batch id).",
      security,
      request: { params: BatchParam },
      responses: {
        200: jsonBody(ImportBatch, "The batch"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireImporter(c, READ);
      const { id } = c.req.valid("param");
      const out = await withTenant(c, async (tx) => {
        const batch = await findBatch(tx, id);
        if (!batch) throw problems.notFound();
        const rates = await importRates(tx, access.tenantId, batch.locationId);
        await auditInTx(tx, access, {
          action: READ,
          resourceType: "import_batch",
          resourceId: batch.id,
          requestId: c.get("requestId"),
        });
        return batchOut(batch, await findCommit(tx, batch.id), rates.undoWindowDays);
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/imports/{id}/dry-run",
      tags: ["platform"],
      summary: "Dry run an import",
      description:
        "platform.import.run and people.person.create across the whole organisation. Checks every staged row against data-standards.md and against the people already in the organisation, committing nothing: rows, valid rows, errors by code, each error and warning by row and field key with a code and plain words (never a value or whose record matched), the rows imported with allergy status unknown (HZ-007) and the rows with allergies to record. A row whose NHS number or local identifier is already on a record is an error (already_in_harbour); the same name and date of birth where either has no NHS number is a warning (possible_duplicate). Only a staged batch (409 not_staged). Recorded on the batch; audited (platform.import.dry_run: counts).",
      security,
      request: { params: BatchParam },
      responses: {
        200: jsonBody(ImportDryRunReport, "The report"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireImporter(c, DRY_RUN);
      const { id } = c.req.valid("param");
      const out = await withAuditedRefusal(c, access, () =>
        withTenant(c, async (tx) => {
          const batch = await findBatch(tx, id, true);
          if (!batch) throw problems.notFound();
          if (batch.status !== "staged") stateRefusal(DRY_RUN, batch.id, "not_staged", NOT_STAGED);
          const { report } = await dryRunNow(tx, batch.id);
          await tx
            .update(importBatch)
            .set({
              dryRunAt: sql`now()`,
              dryRunBy: access.tenantUserId,
              dryRunErrors: report.errorCount,
              dryRunWarnings: report.warningCount,
            })
            .where(eq(importBatch.id, batch.id));
          await auditInTx(tx, access, {
            action: DRY_RUN,
            resourceType: "import_batch",
            resourceId: batch.id,
            scope: {
              rows: report.rows,
              validRows: report.validRows,
              errors: report.errorCount,
              warnings: report.warningCount,
              byCode: report.byCode,
            },
            requestId: c.get("requestId"),
          });
          return reportOut(batch.id, report);
        }),
      );
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/imports/{id}/commit",
      tags: ["platform"],
      summary: "Commit an import, whole",
      description:
        "platform.import.run and people.person.create across the whole organisation, with a fresh step-up (403 step_up_required). Repeats the dry run with the batch locked and commits the whole batch only when it has had a dry run (409 dry_run_first), has no error (409 has_errors) and, when there are possible duplicates, acknowledgePossibleDuplicates (409 possible_duplicates_unacknowledged); otherwise nothing is created. Each row becomes a person at the batch's location (status active; allergy status as imported, blank as unknown). The staged rows are deleted in the same transaction. Committing a committed batch again returns the same commit (replayed). Refused while sample data is in place (409 remove_sample_data_first), and when someone was added meanwhile (409 records_changed). Audited: platform.import.committed (count) and people.person.imported per person.",
      security,
      request: {
        params: BatchParam,
        body: { content: { "application/json": { schema: CommitImport } } },
      },
      responses: {
        200: jsonBody(ImportCommitResult, "Committed"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireImporter(c, COMMITTED);
      await requireStepUp(c, access, COMMITTED);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const out = await withAuditedRefusal(c, access, () =>
        withTenant(c, async (tx) => {
          const batch = await findBatch(tx, id, true);
          if (!batch) throw problems.notFound();
          const rates = await importRates(tx, access.tenantId, batch.locationId);
          if (batch.status === "committed" || batch.status === "undone") {
            const done = await findCommit(tx, batch.id);
            if (!done) throw new Error("committed batch without its commit record");
            await auditInTx(tx, access, {
              action: COMMITTED,
              resourceType: "import_batch",
              resourceId: batch.id,
              scope: { records: done.recordCount, replayed: true },
              requestId: c.get("requestId"),
            });
            return {
              batchId: batch.id,
              records: done.recordCount,
              committedAt: done.committedAt.toISOString(),
              undoClosesAt: importUndoClosesAt(done.committedAt, rates).toISOString(),
              replayed: true,
            };
          }
          const { validation, report } = await dryRunNow(tx, batch.id);
          const check = checkPeopleCommit({
            status: batch.status as "staged",
            dryRunAt: batch.dryRunAt,
            report,
            acknowledgePossibleDuplicates: body.acknowledgePossibleDuplicates,
          });
          if (!check.ok) stateRefusal(COMMITTED, batch.id, check.problem, check.message);
          const created: string[] = [];
          try {
            const values = validation.rows.map((row) => personValues(row, batch.locationId));
            for (let start = 0; start < values.length; start += 500) {
              const made = await tx
                .insert(person)
                .values(values.slice(start, start + 500))
                .returning({ id: person.id });
              created.push(...made.map((m) => m.id));
            }
          } catch (error) {
            const code = dbCode(error);
            if (code === "23514" && messageOf(error) === "remove_sample_data_first") {
              const refusal = sampleDataRefusal("remove_sample_data_first");
              stateRefusal(COMMITTED, batch.id, refusal.problem, refusal.message);
            }
            // The organisation's NHS numbers are unique: someone was added since the check above.
            if (code === "23505") {
              stateRefusal(
                COMMITTED,
                batch.id,
                "records_changed",
                "Someone in this file was added to Harbour since the dry run. Nothing was imported: run the dry run again.",
              );
            }
            throw error;
          }
          const [closed] = await tx
            .update(importBatch)
            .set({ status: "committed", closedAt: sql`now()`, closedBy: access.tenantUserId })
            .where(eq(importBatch.id, batch.id))
            .returning({ closedAt: importBatch.closedAt });
          const [commit] = await tx
            .insert(importCommit)
            .values({ batchId: batch.id, recordIds: created, recordCount: created.length })
            .returning();
          if (!closed || !commit) throw new Error("import commit not recorded");
          await auditManyInTx(
            tx,
            access,
            created.map((personId) => ({
              action: IMPORTED,
              resourceType: "person",
              resourceId: personId,
              scope: { importBatchId: batch.id },
              requestId: c.get("requestId"),
            })),
          );
          await auditInTx(tx, access, {
            action: COMMITTED,
            resourceType: "import_batch",
            resourceId: batch.id,
            scope: { records: created.length, possibleDuplicatesAcknowledged: report.warningCount },
            requestId: c.get("requestId"),
          });
          return {
            batchId: batch.id,
            records: created.length,
            committedAt: commit.committedAt.toISOString(),
            undoClosesAt: importUndoClosesAt(commit.committedAt, rates).toISOString(),
            replayed: false,
          };
        }),
      );
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/imports/{id}/undo",
      tags: ["platform"],
      summary: "Undo a committed import, once",
      description:
        "platform.import.run and people.person.create across the whole organisation, with a fresh step-up. Removes every person the commit created through app.undo_import_batch, the whole batch or nothing, once (409 already_undone), within import.undo_window_days of the commit (409 window_passed), and only while none has been changed or soft-deleted (409 changed_since) and nothing refers to any of them (409 referenced_since); otherwise correct records one by one. Only a committed batch (409 not_committed). Audited by the database (platform.import.undone: the count); refusals here.",
      security,
      request: { params: BatchParam },
      responses: {
        200: jsonBody(ImportUndoResult, "Undone"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireImporter(c, UNDONE);
      await requireStepUp(c, access, UNDONE);
      const { id } = c.req.valid("param");
      const out = await withAuditedRefusal(c, access, () =>
        withTenant(c, async (tx) => {
          const batch = await findBatch(tx, id, true);
          if (!batch) throw problems.notFound();
          const commit = await findCommit(tx, batch.id);
          if (!commit || (batch.status !== "committed" && batch.status !== "undone")) {
            stateRefusal(
              UNDONE,
              batch.id,
              "not_committed",
              "Only a committed import can be undone. Discard one that is not committed.",
            );
          }
          const rates = await importRates(tx, access.tenantId, batch.locationId);
          const unchanged = await unchangedPeople(tx, commit.recordIds);
          const eligible = importUndoEligibility(
            {
              committedAt: commit.committedAt,
              undoneAt: commit.undoneAt,
              changedSinceCommit: unchanged < commit.recordIds.length,
              // Decided by the database, which sees every record that refers to them.
              referencedSinceCommit: false,
            },
            rates,
            new Date(),
          );
          if (!eligible.ok) stateRefusal(UNDONE, batch.id, eligible.problem, eligible.message);
          let removed = 0;
          try {
            const { rows } = await tx.execute<{ removed: number }>(
              sql`SELECT app.undo_import_batch(${batch.id}::uuid, ${c.get("requestId")}) AS removed`,
            );
            removed = Number(rows[0]?.removed ?? 0);
          } catch (error) {
            const problem = UNDO_PROBLEMS.find((p) => p === messageOf(error));
            if (problem) stateRefusal(UNDONE, batch.id, problem, UNDO_MESSAGES[problem]);
            throw error;
          }
          const after = await findCommit(tx, batch.id);
          return {
            batchId: batch.id,
            records: removed,
            undoneAt: (after?.undoneAt ?? new Date()).toISOString(),
          };
        }),
      );
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/v1/imports/{id}",
      tags: ["platform"],
      summary: "Discard a staged import",
      description:
        "platform.import.run and people.person.create across the whole organisation. Discards a staged batch: its staged rows are deleted in the same transaction and the batch is kept as the record that it was discarded. Only a staged batch (409 not_staged). Audited (platform.import.discarded: the batch id and row count).",
      security,
      request: { params: BatchParam },
      responses: {
        200: jsonBody(ImportBatch, "Discarded"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireImporter(c, DISCARDED);
      const { id } = c.req.valid("param");
      const out = await withAuditedRefusal(c, access, () =>
        withTenant(c, async (tx) => {
          const batch = await findBatch(tx, id, true);
          if (!batch) throw problems.notFound();
          if (batch.status !== "staged")
            stateRefusal(DISCARDED, batch.id, "not_staged", NOT_STAGED);
          const [closed] = await tx
            .update(importBatch)
            .set({ status: "discarded", closedAt: sql`now()`, closedBy: access.tenantUserId })
            .where(eq(importBatch.id, batch.id))
            .returning();
          if (!closed) throw new Error("import batch not discarded");
          await auditInTx(tx, access, {
            action: DISCARDED,
            resourceType: "import_batch",
            resourceId: batch.id,
            scope: { rows: batch.rowCount },
            requestId: c.get("requestId"),
          });
          const rates = await importRates(tx, access.tenantId, batch.locationId);
          return batchOut(closed, undefined, rates.undoWindowDays);
        }),
      );
      return c.json(out, 200);
    },
  );
