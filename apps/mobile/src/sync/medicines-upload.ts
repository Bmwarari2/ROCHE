/**
 * Turns a dose recorded on the phone (`medicines/record.ts`) into its request:
 * `POST /v1/people/{id}/medicine-administrations` with the client's UUID, so a resend records once
 * and a dose recorded on two devices is kept for review (HZ-004). The body is the one the phone
 * built when the carer recorded it, kept in the row's local `request` column. A record the API
 * refuses moves to "needs attention" in the API's words, and the next sync removes it from the
 * round, so a dose Harbour did not take never reads as given (HZ-006).
 *
 * Pure, so the mapping is tested without a device.
 */
import { MEDICINES_WRITABLE_TABLES, type MedicinesWritableTable } from "@harbour/sync/client";
import { t } from "../i18n/t";
import type { CrudEntryLike } from "./connector";

export function isMedicinesWritableTable(table: string): table is MedicinesWritableTable {
  return (MEDICINES_WRITABLE_TABLES as readonly string[]).includes(table);
}

export interface MedicinesUploadRequest {
  readonly kind: "request";
  readonly table: MedicinesWritableTable;
  readonly recordId: string;
  readonly tenantId: string;
  readonly personId: string;
  readonly path: string;
  readonly body: Record<string, unknown>;
}

export interface MedicinesUploadRefusal {
  readonly kind: "refused";
  readonly table: MedicinesWritableTable;
  readonly recordId: string;
  readonly tenantId: string | null;
  readonly personId: string | null;
  readonly code: "dose_record_unreadable";
  readonly message: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function toMedicinesUpload(
  entry: CrudEntryLike & { readonly table: MedicinesWritableTable },
): MedicinesUploadRequest | MedicinesUploadRefusal {
  const data = entry.opData ?? {};
  const tenantId = typeof data.tenant_id === "string" ? data.tenant_id : null;
  const personId = typeof data.person_id === "string" ? data.person_id : null;
  const refused = (): MedicinesUploadRefusal => ({
    kind: "refused",
    table: entry.table,
    recordId: entry.id,
    tenantId,
    personId,
    code: "dose_record_unreadable",
    message: t("mobile.meds.uploadUnreadable"),
  });
  // A record is an insert only: a correction is its own record (slice 70).
  if (entry.op !== "PUT" || !tenantId || !personId || !UUID.test(entry.id)) return refused();
  if (!UUID.test(personId)) return refused();
  let queued: unknown;
  try {
    queued = typeof data.request === "string" ? JSON.parse(data.request) : null;
  } catch {
    return refused();
  }
  if (typeof queued !== "object" || queued === null) return refused();
  const {
    personId: forPerson,
    body,
    kind,
    supersedesId,
  } = queued as { personId?: unknown; body?: unknown; kind?: unknown; supersedesId?: unknown };
  if (forPerson !== personId || typeof body !== "object" || body === null) return refused();
  const record = body as Record<string, unknown>;
  // The row's id is the record's own: the idempotency key and the server's id.
  if (record.id !== entry.id || record.entryId !== data.medication_id) return refused();
  // A correction (slice 70) names the record it corrects, as the row does.
  if (kind === "correction") {
    if (typeof supersedesId !== "string" || !UUID.test(supersedesId)) return refused();
    if (data.supersedes_id !== supersedesId) return refused();
    return {
      kind: "request",
      table: entry.table,
      recordId: entry.id,
      tenantId,
      personId,
      path: `/v1/medicine-administrations/${encodeURIComponent(supersedesId)}/corrections`,
      body: record,
    };
  }
  if (kind !== undefined) return refused();
  return {
    kind: "request",
    table: entry.table,
    recordId: entry.id,
    tenantId,
    personId,
    path: `/v1/people/${encodeURIComponent(personId)}/medicine-administrations`,
    body: record,
  };
}
