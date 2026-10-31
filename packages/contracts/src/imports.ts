import { z } from "zod";

/**
 * The import wizard's API (PLAT-014; platform.md rules 18 to 26; ADR-0092; HZ-130). A batch is one
 * upload, staged in quarantine until a dry run and a commit; responses carry opaque ids, row and
 * column numbers, field keys, codes and counts, never an imported value, a column heading or whose
 * record a row matched. Enumerations mirror packages/domain (`imports.ts`).
 */

const uuid = z.uuid();
const isoDateTime = z.iso.datetime({ offset: true });
const count = z.number().int().min(0);

/** The largest CSV text one upload takes, in characters (the request body is capped too). */
export const IMPORT_MAX_CSV_CHARACTERS = 10_000_000;

export const ImportRecordType = z
  .enum(["people"])
  .meta({ id: "ImportRecordType", description: "What a batch imports (people in slice 26)" });
export type ImportRecordType = z.infer<typeof ImportRecordType>;

export const ImportBatchStatus = z
  .enum(["staged", "committed", "undone", "discarded", "expired"])
  .meta({ id: "ImportBatchStatus", description: "Where a batch stands; forward only" });
export type ImportBatchStatus = z.infer<typeof ImportBatchStatus>;

/**
 * An upload. Exactly one of `csv` (UTF-8 text, one header row, RFC 4180 quoting) or `rows` (JSON
 * objects of text). `mapping` takes a column heading to a Harbour field key, or to null to leave
 * the column out; any other column must be named by its field key or label. Headings and values
 * are checked by the API, which names a problem by row and column number, never by what they hold.
 */
export const UploadImport = z
  .object({
    recordType: ImportRecordType,
    /** The location every imported person lives at. */
    locationId: uuid,
    csv: z.string().max(IMPORT_MAX_CSV_CHARACTERS).optional(),
    rows: z
      .array(z.record(z.string(), z.unknown()))
      .max(5000)
      .optional()
      .meta({ description: "JSON rows: each an object of column heading to text" }),
    mapping: z
      .record(z.string(), z.unknown())
      .optional()
      .meta({ description: "Column heading to Harbour field key, or null to leave it out" }),
  })
  .meta({ id: "UploadImport" });
export type UploadImport = z.infer<typeof UploadImport>;

export const ImportBatch = z
  .object({
    id: uuid,
    recordType: ImportRecordType,
    locationId: uuid,
    status: ImportBatchStatus,
    rows: count,
    uploadedBy: uuid,
    uploadedAt: isoDateTime,
    /** While staged: when its staged rows are deleted unless committed first. */
    expiresAt: isoDateTime,
    dryRunAt: isoDateTime.nullable(),
    dryRunErrors: count.nullable(),
    dryRunWarnings: count.nullable(),
    /** When it was committed, discarded or expired. */
    closedAt: isoDateTime.nullable(),
    /** Records the commit created; null until committed. */
    records: count.nullable(),
    committedAt: isoDateTime.nullable(),
    /** The last moment the commit may be undone (`import.undo_window_days`); null otherwise. */
    undoClosesAt: isoDateTime.nullable(),
    undoneAt: isoDateTime.nullable(),
  })
  .meta({ id: "ImportBatch", description: "One upload; never a value, a heading or a file name" });
export type ImportBatch = z.infer<typeof ImportBatch>;

export const ImportBatchList = z
  .object({ items: z.array(ImportBatch) })
  .meta({ id: "ImportBatchList" });
export type ImportBatchList = z.infer<typeof ImportBatchList>;

export const ImportFinding = z
  .object({
    /** The 1-based data row (1 is the first row under the header). */
    row: z.number().int().min(1),
    /** The Harbour field key, never the file's heading. */
    column: z.string(),
    code: z.string(),
    /** Plain words naming the field, never the value. */
    message: z.string(),
  })
  .meta({ id: "ImportFinding", description: "An error or warning at a row and field" });
export type ImportFinding = z.infer<typeof ImportFinding>;

export const ImportDryRunReport = z
  .object({
    batchId: uuid,
    rows: count,
    validRows: count,
    errorCount: count,
    warningCount: count,
    /** Every error, counted by code. */
    byCode: z.record(z.string(), count),
    /** True when the batch may be committed (warnings still need acknowledging). */
    mayCommit: z.boolean(),
    errors: z.array(ImportFinding),
    warnings: z.array(ImportFinding),
    /** True when more errors or warnings were found than are listed. */
    truncated: z.boolean(),
    /** HZ-007: rows imported with allergy status unknown ("not recorded" until someone records it). */
    allergyStatusUnknownRows: z.array(z.number().int().min(1)),
    /** Rows marked as having allergies: record each allergy on the person after the import. */
    allergiesToRecordRows: z.array(z.number().int().min(1)),
  })
  .meta({
    id: "ImportDryRunReport",
    description: "What committing would do now; nothing is committed by a dry run",
  });
export type ImportDryRunReport = z.infer<typeof ImportDryRunReport>;

export const CommitImport = z
  .object({
    /** True once the person committing has checked each possible duplicate the dry run listed. */
    acknowledgePossibleDuplicates: z.boolean().default(false),
  })
  .meta({ id: "CommitImport" });
export type CommitImport = z.infer<typeof CommitImport>;

export const ImportCommitResult = z
  .object({
    batchId: uuid,
    records: count,
    committedAt: isoDateTime,
    undoClosesAt: isoDateTime,
    /** True when the batch was already committed: the same commit, nothing created again. */
    replayed: z.boolean(),
  })
  .meta({ id: "ImportCommitResult" });
export type ImportCommitResult = z.infer<typeof ImportCommitResult>;

export const ImportUndoResult = z
  .object({ batchId: uuid, records: count, undoneAt: isoDateTime })
  .meta({ id: "ImportUndoResult" });
export type ImportUndoResult = z.infer<typeof ImportUndoResult>;
