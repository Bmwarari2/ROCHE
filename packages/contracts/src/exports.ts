import { z } from "zod";
import { StaffName } from "./staff";

/**
 * The organisation's free full export (PLAT-015; platform-completions.md rules 10 to 16). Who
 * asked, where it stands and the single download; never the archive's place in storage. The
 * archive is fetched once, by the person who asked, from `GET /v1/exports/{id}/download`.
 */

const uuid = z.uuid();
const isoDateTime = z.iso.datetime({ offset: true });

export const ExportStatus = z
  .enum(["queued", "running", "ready", "failed", "expired", "revoked"])
  .meta({ id: "ExportStatus" });

export const ExportItem = z
  .object({
    id: uuid,
    kind: z.enum(["full", "changes_since"]),
    since: isoDateTime.nullable(),
    /** As of now: a ready export past its expiry reads expired. */
    status: ExportStatus,
    requestedBy: StaffName.nullable(),
    requestedAt: isoDateTime,
    snapshotAt: isoDateTime.nullable(),
    readyAt: isoDateTime.nullable(),
    expiresAt: isoDateTime.nullable(),
    bytes: z.number().int().nonnegative().nullable(),
    manifestSha256: z.string().nullable(),
    warnings: z.array(z.record(z.string(), z.unknown())),
    downloadedAt: isoDateTime.nullable(),
    /** Whether the caller may download it now: their own, ready, unexpired, not yet downloaded. */
    mayDownload: z.boolean(),
  })
  .meta({ id: "ExportItem" });
export type ExportItem = z.infer<typeof ExportItem>;

export const ExportList = z.object({ items: z.array(ExportItem) }).meta({ id: "ExportList" });
export type ExportList = z.infer<typeof ExportList>;

export const RequestExport = z
  .object({
    /** For the changes since an earlier export: that export's id (its snapshot is the start). */
    sinceExportId: uuid.optional(),
  })
  .meta({ id: "RequestExport", description: "Ask for a full export, or the changes since one" });
export type RequestExport = z.infer<typeof RequestExport>;
