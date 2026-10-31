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
    /**
     * Whether the commit can be undone now: committed, not undone, within the window, and no phone
     * may hold the people yet (a sync token carrying people since the commit). False otherwise.
     */
    undoAvailable: z.boolean(),
    /** While `undoAvailable`, the last moment within `import.undo_window_days`; null otherwise. */
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
    /**
     * The existing record the row matched (already in Harbour, or a possible duplicate). The
     * importer can see everyone in the organisation (rule 18), so this tells them nothing new.
     */
    personId: uuid.nullable().optional(),
    /** A possible duplicate's other row in the file. */
    otherRow: z.number().int().min(1).nullable().optional(),
    /** How the names agree: same_name, names_swapped, same_family_name, same_given_name. */
    match: z.string().optional(),
    /** A warning's key, listed back in the commit's acknowledgement. */
    key: z.string().optional(),
  })
  .meta({ id: "ImportFinding", description: "An error or warning at a row and field" });
export type ImportFinding = z.infer<typeof ImportFinding>;

const rowNumbers = z.array(z.number().int().min(1));

export const ImportDryRunReport = z
  .object({
    batchId: uuid,
    rows: count,
    validRows: count,
    errorCount: count,
    warningCount: count,
    /** Every error, counted by code. */
    byCode: z.record(z.string(), count),
    /** True only with no errors and no possible duplicates left to acknowledge. */
    mayCommit: z.boolean(),
    /** True when the only thing left is to acknowledge the possible duplicates listed. */
    needsAcknowledgement: z.boolean(),
    errors: z.array(ImportFinding),
    warnings: z.array(ImportFinding),
    /** Every warning's key: the commit's `acknowledgedWarnings` must list exactly these. */
    warningKeys: z.array(z.string()),
    /** True when more errors or warnings were found than are listed. */
    truncated: z.boolean(),
    /**
     * HZ-007: every person's allergy status is imported as not recorded, whatever the file says,
     * until staff check it on the record. What the file stated, so those are checked first.
     */
    allergyStatusNotStatedRows: rowNumbers,
    noKnownAllergiesStatedRows: rowNumbers,
    hasAllergiesStatedRows: rowNumbers,
    /** True when a row matched more existing records than its warnings name. */
    recordMatchesCapped: z.boolean(),
    /**
     * Phones are in use in the organisation, so the import cannot be undone once committed: the
     * commit needs `acceptNoUndo`.
     */
    phonesInUse: z.boolean(),
    /** What committing does, in plain words. */
    whatHappens: z.array(z.string()),
  })
  .meta({
    id: "ImportDryRunReport",
    description: "What committing would do now; nothing is committed by a dry run",
  });
export type ImportDryRunReport = z.infer<typeof ImportDryRunReport>;

export const CommitImport = z
  .object({
    /**
     * The keys of the possible duplicates the person committing has checked: exactly the dry
     * run's `warningKeys`. A warning found now that is not listed, or one listed that is no longer
     * found, refuses the commit.
     */
    // A dry run never lists more than 500 warnings (`IMPORT_WARNING_LIMITS.total`): a file with
    // more is refused, so every warning shown can be acknowledged.
    acknowledgedWarnings: z.array(z.string().max(120)).max(500).default([]),
    /**
     * True once the person committing accepts that the import cannot be undone: needed while
     * phones are in use in the organisation (the dry run's `phonesInUse`).
     */
    acceptNoUndo: z.boolean().default(false),
  })
  .meta({ id: "CommitImport" });
export type CommitImport = z.infer<typeof CommitImport>;

export const ImportCommitResult = z
  .object({
    batchId: uuid,
    records: count,
    committedAt: isoDateTime,
    /** Whether it can be undone now (see `ImportBatch.undoAvailable`). */
    undoAvailable: z.boolean(),
    undoClosesAt: isoDateTime.nullable(),
    /** True when the batch was already committed: the same commit, nothing created again. */
    replayed: z.boolean(),
    /**
     * HZ-007: the people whose allergy status the file stated, imported as not recorded, each with
     * the task raised to check and record it (kept on the task, so a replay lists them too).
     */
    allergyStatusToConfirm: z.array(
      z.object({
        personId: uuid,
        taskId: uuid,
        stated: z.enum(["no_known_allergies", "has_allergies"]),
      }),
    ),
  })
  .meta({ id: "ImportCommitResult" });
export type ImportCommitResult = z.infer<typeof ImportCommitResult>;

export const ImportUndoResult = z
  .object({ batchId: uuid, records: count, undoneAt: isoDateTime })
  .meta({ id: "ImportUndoResult" });
export type ImportUndoResult = z.infer<typeof ImportUndoResult>;
