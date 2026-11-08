/**
 * Turns an incident reported on the phone (`incident_outbox`) into `POST /v1/incidents`. The body
 * is the API's `CreateIncident` JSON as the form queued it; its id must be the row's, which is the
 * idempotency key, so a resend returns the earlier copy and never records twice. `POST
 * /v1/sync/upload` never writes incidents.
 *
 * Pure, so the mapping is tested without a device. A row that cannot become a valid request is
 * refused here, in words, and kept as "needs attention" by the connector.
 */
import { SAFETY_WRITABLE_TABLES, type SafetyWritableTable } from "@harbour/sync/client";
import { t } from "../i18n/t";
import type { CrudEntryLike } from "./connector";

export function isSafetyWritableTable(table: string): table is SafetyWritableTable {
  return (SAFETY_WRITABLE_TABLES as readonly string[]).includes(table);
}

export interface IncidentUploadRequest {
  readonly kind: "request";
  readonly table: SafetyWritableTable;
  readonly recordId: string;
  readonly tenantId: string;
  readonly personId: string | null;
  readonly path: "/v1/incidents";
  readonly body: Record<string, unknown>;
}

export interface IncidentUploadRefusal {
  readonly kind: "refused";
  readonly table: SafetyWritableTable;
  readonly recordId: string;
  readonly tenantId: string | null;
  readonly personId: string | null;
  readonly code: "incident_unreadable";
  readonly message: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const text = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

function object(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function toIncidentUpload(
  entry: CrudEntryLike & { readonly table: SafetyWritableTable },
): IncidentUploadRequest | IncidentUploadRefusal {
  const data = entry.opData ?? {};
  const tenantId = text(data.tenant_id);
  const personId = text(data.person_id);
  const body = object(data.body);
  if (
    entry.op !== "PUT" ||
    !tenantId ||
    !UUID.test(entry.id) ||
    !body ||
    body.id !== entry.id ||
    !text(body.locationId) ||
    !text(body.occurredAt)
  ) {
    return {
      kind: "refused",
      table: entry.table,
      recordId: entry.id,
      tenantId,
      personId,
      code: "incident_unreadable",
      message: t("mobile.incident.unreadable"),
    };
  }
  return {
    kind: "request",
    table: entry.table,
    recordId: entry.id,
    tenantId,
    personId,
    path: "/v1/incidents",
    body,
  };
}
