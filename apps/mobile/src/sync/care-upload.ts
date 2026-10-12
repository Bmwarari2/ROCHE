/**
 * Turns a queued care entry (a PowerSync CRUD entry for one of the five append-only entry tables)
 * into a request to the API's own endpoint for it. `POST /v1/sync/upload` does not write care
 * tables, while `POST /v1/people/{id}/notes`, `/observations`, `/body-map`, `/activities` and
 * `/visits` already take the device's id and ignore a replay of it (care.md section 5), and run
 * the same checks, flags and follow-ups as an entry made on the web.
 *
 * Pure, so the mapping is tested without a device. Values are read defensively: a row that cannot
 * become a valid request is refused here, with a reason, rather than sent.
 */
import type {
  CreateActivityRecord,
  CreateBodyMapMark,
  CreateCareNote,
  CreateObservation,
  CreateVisit,
} from "@harbour/contracts";
import { DEVICE_WRITABLE_TABLES, type OfflineWindowTable } from "@harbour/sync/client";
import { t } from "../i18n/t";
import type { CrudEntryLike } from "./connector";

/** The API resource under `/v1/people/{personId}/` for each entry table. */
export const CARE_ENTRY_PATHS: Readonly<Record<OfflineWindowTable, string>> = {
  care_note: "notes",
  observation: "observations",
  body_map_mark: "body-map",
  activity_record: "activities",
  visit_log: "visits",
};

export function isCareEntryTable(table: string): table is OfflineWindowTable {
  return (DEVICE_WRITABLE_TABLES as readonly string[]).includes(table);
}

export interface CareUploadRequest {
  readonly kind: "request";
  readonly table: OfflineWindowTable;
  readonly recordId: string;
  readonly personId: string;
  readonly tenantId: string;
  /** For example `/v1/people/{personId}/notes`. */
  readonly path: string;
  readonly body: Record<string, unknown>;
}

export interface CareUploadRefusal {
  readonly kind: "refused";
  readonly table: OfflineWindowTable;
  readonly recordId: string;
  readonly personId: string | null;
  readonly tenantId: string | null;
  readonly code: "entry_not_editable" | "entry_incomplete" | "entry_unreadable";
  readonly message: string;
}

type Data = Readonly<Record<string, unknown>>;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function number(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** SQLite holds booleans as 1 and 0. */
function bool(value: unknown): boolean | undefined {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return undefined;
}

class Unreadable extends Error {}

function json(value: unknown): unknown {
  if (typeof value !== "string") return value ?? undefined;
  try {
    return JSON.parse(value);
  } catch {
    throw new Unreadable();
  }
}

function stringArray(value: unknown): string[] {
  const parsed = json(value);
  if (parsed === undefined || parsed === null) return [];
  if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === "string")) {
    throw new Unreadable();
  }
  return parsed;
}

/** Drops absent values: the API's optional fields refuse `null`. */
function compact<T extends Record<string, unknown>>(body: T): T {
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) as T;
}

/** The fields every entry shares: the device's id and both clocks (HZ-010, HZ-017). */
function common(id: string, data: Data) {
  return {
    id,
    occurredAt: text(data.occurred_at) as string,
    // The device clock when the entry was written, never when it happened to upload: the server
    // measures lateness from this, so an entry written on time and synced hours later is not late.
    deviceTime: text(data.device_time),
    supersedesId: text(data.supersedes_id),
    correctionReason: text(data.correction_reason),
  };
}

function noteBody(id: string, data: Data): CreateCareNote {
  return compact({
    ...common(id, data),
    category: text(data.category) as CreateCareNote["category"],
    body: text(data.body) as string,
    tags: stringArray(data.tags),
    attachmentDocumentIds: [],
  });
}

function observationBody(id: string, data: Data): CreateObservation {
  const values = json(data.chart_values);
  if (typeof values !== "object" || values === null || Array.isArray(values)) {
    throw new Unreadable();
  }
  return compact({ ...common(id, data), values: values as CreateObservation["values"] });
}

function markBody(id: string, data: Data): CreateBodyMapMark {
  return compact({
    ...common(id, data),
    view: text(data.view) as CreateBodyMapMark["view"],
    region: text(data.region) as string,
    // HZ-019: the API checks the side drawn against the side chosen in words, as the device did.
    drawnSide: text(data.drawn_side) as CreateBodyMapMark["drawnSide"],
    side: text(data.side) as CreateBodyMapMark["side"],
    markType: text(data.mark_type) as CreateBodyMapMark["markType"],
    pressureCategory: text(data.pressure_category) as CreateBodyMapMark["pressureCategory"],
    deviceRelated: bool(data.device_related),
    bruiseExplained: bool(data.bruise_explained),
    lengthMm: number(data.length_mm),
    widthMm: number(data.width_mm),
    depthMm: number(data.depth_mm),
    description: text(data.description),
    status: (text(data.status) ?? "present") as CreateBodyMapMark["status"],
  });
}

function activityBody(id: string, data: Data): CreateActivityRecord {
  return compact({
    ...common(id, data),
    activity: text(data.activity) as string,
    format: text(data.format) as CreateActivityRecord["format"],
    groupSessionId: text(data.group_session_id),
    attendance: text(data.attendance) as CreateActivityRecord["attendance"],
    engagement: text(data.engagement) as CreateActivityRecord["engagement"],
    durationMinutes: number(data.duration_minutes),
    notes: text(data.notes),
  });
}

function visitBody(id: string, data: Data): CreateVisit {
  return compact({
    ...common(id, data),
    kind: text(data.kind) as CreateVisit["kind"],
    contactId: text(data.contact_id),
    visitorName: text(data.visitor_name),
    visitorRelationship: text(data.visitor_relationship),
    endedAt: text(data.ended_at),
    restrictionsApplied: bool(data.restrictions_applied) ?? false,
    restrictionReason: text(data.restriction_reason),
    notes: text(data.notes),
  });
}

const BODIES: Readonly<
  Record<OfflineWindowTable, (id: string, data: Data) => Record<string, unknown>>
> = {
  care_note: noteBody,
  observation: observationBody,
  body_map_mark: markBody,
  activity_record: activityBody,
  visit_log: visitBody,
};

/** Maps one queued care entry to its API request, or says why it cannot be sent. */
export function toCareUpload(
  entry: CrudEntryLike & { readonly table: OfflineWindowTable },
): CareUploadRequest | CareUploadRefusal {
  const data: Data = entry.opData ?? {};
  const personId = text(data.person_id) ?? null;
  const tenantId = text(data.tenant_id) ?? null;
  const refuse = (code: CareUploadRefusal["code"], message: string): CareUploadRefusal => ({
    kind: "refused",
    table: entry.table,
    recordId: entry.id,
    personId,
    tenantId,
    code,
    message,
  });

  // Entries are append-only: the app only inserts them, and a correction is a new entry.
  if (entry.op !== "PUT") return refuse("entry_not_editable", t("mobile.upload.notEditable"));
  if (!personId || !tenantId || !text(data.occurred_at)) {
    return refuse("entry_incomplete", t("mobile.upload.incomplete"));
  }
  try {
    return {
      kind: "request",
      table: entry.table,
      recordId: entry.id,
      personId,
      tenantId,
      path: `/v1/people/${encodeURIComponent(personId)}/${CARE_ENTRY_PATHS[entry.table]}`,
      body: BODIES[entry.table](entry.id, data),
    };
  } catch (error) {
    if (error instanceof Unreadable) {
      return refuse("entry_unreadable", t("mobile.upload.unreadable"));
    }
    throw error;
  }
}
