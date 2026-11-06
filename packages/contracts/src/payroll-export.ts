import { z } from "zod";

/**
 * Payroll and pension exports (scheduling.md section 19; SCHED-008; ADR-0013, ADR-0097): a locked
 * pay run, exported on purpose to the organisation's payroll provider, with its record.
 */

const uuid = z.uuid();
const isoDateTime = z.iso.datetime({ offset: true });

export const PayrollFormat = z
  .enum(["xero_payroll_uk", "staffology_csv", "sage_csv", "brightpay_csv"])
  .meta({ id: "PayrollFormat" });

export const PayrollExportItem = z
  .object({
    id: uuid,
    runId: uuid,
    calculation: z.number().int(),
    format: PayrollFormat,
    formatVersion: z.number().int(),
    lineCount: z.number().int(),
    contentSha256: z.string(),
    /** Another export of the same calculation came before: check payroll is not paid twice. */
    reexport: z.boolean(),
    /**
     * A file is generated. An API export is pending until the provider answers, then sent,
     * failed (refused: nothing taken in) or unknown (no answer: check the provider before
     * exporting again). Only failed does not count as exported.
     */
    outcome: z.enum(["generated", "pending", "sent", "failed", "unknown"]),
    /** The provider's batch id, when it sent one. */
    externalRef: z.string().nullable(),
    exportedBy: uuid,
    exportedAt: isoDateTime,
  })
  .meta({ id: "PayrollExportItem" });

export const PayrollExportList = z
  .object({ items: z.array(PayrollExportItem) })
  .meta({ id: "PayrollExportList" });

export const NewPayrollExport = z
  .object({
    format: PayrollFormat,
    /** Needed to export a run's calculation again (rule 6). */
    confirmReexport: z.boolean().default(false),
  })
  .meta({ id: "NewPayrollExport" });

export const PayrollExportResult = z
  .object({
    export: PayrollExportItem,
    /** For a file format: the file, made from the locked run. Null for an API export. */
    file: z
      .object({
        fileName: z.string(),
        contentType: z.literal("text/csv; charset=utf-8"),
        content: z.string(),
      })
      .nullable(),
    message: z.string(),
  })
  .meta({ id: "PayrollExportResult" });

export const PayrollConnectionItem = z
  .object({
    id: uuid,
    provider: z.enum(["xero_payroll_uk"]),
    externalOrganisationId: z.string(),
    status: z.enum(["connected", "disconnected"]),
    connectedBy: uuid,
    connectedAt: isoDateTime,
    disconnectedAt: isoDateTime.nullable(),
    version: z.number().int(),
  })
  .meta({ id: "PayrollConnectionItem", description: "Never the secret or a token" });

export const PayrollConnectionList = z
  .object({ items: z.array(PayrollConnectionItem) })
  .meta({ id: "PayrollConnectionList" });

export const NewPayrollConnection = z
  .object({
    provider: z.enum(["xero_payroll_uk"]),
    externalOrganisationId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
  })
  .meta({ id: "NewPayrollConnection" });

export const DisconnectPayroll = z
  .object({ version: z.number().int().min(1) })
  .meta({ id: "DisconnectPayroll" });
