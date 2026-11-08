/**
 * Reporting an incident on the phone (safety.md section 3; MOB-006). The report is checked on the
 * device against the limits the API applies, then queued in `incident_outbox` with the API's
 * `CreateIncident` body; the upload queue sends it to `POST /v1/incidents` under its own id, so a
 * resend records once. The person whose record it was raised from is on it as affected. The server
 * runs the classifier from `occurredAt`, never the send time (HZ-013, HZ-027), and opens a missing
 * person episode for an absconding (#191). Questions the carer could not answer ("Not known yet")
 * go to the person in charge as a task (H-264, HZ-090).
 *
 * Nobody is alerted until the report reaches the server, so the form says so (HZ-006).
 */
import type { CreateIncident, IncidentType } from "@harbour/contracts";
import type { EntryContext, FieldError } from "./entries";
import { resolveOccurredAt, type WhenChoice } from "./time";

/** Every type the web form offers, in its order (`IncidentType`); a test keeps them equal. */
export const INCIDENT_TYPES: readonly IncidentType[] = [
  "fall",
  "medication",
  "skin",
  "behaviour",
  "missing_person",
  "safeguarding_concern",
  "injury",
  "near_miss",
  "environmental",
  "ipc",
  "staff_injury",
  "violence_to_staff",
  "self_harm",
  "sexual_safety",
  "absconding",
  "fire_setting",
  "substance_use",
  "data_breach",
];

/** API limits from `@harbour/contracts` (`CreateIncident`); a test keeps them equal. */
export const INCIDENT_TEXT_LIMITS = { descriptionMin: 3, max: 4000 } as const;

/** A yes or no question the carer may leave as "Not known yet", never guessed (HZ-090). */
export type Answer = "yes" | "no" | "not_known";
export const ANSWERS: readonly Answer[] = ["yes", "no", "not_known"];

export interface IncidentDraft {
  readonly type: IncidentType | null;
  readonly when: WhenChoice;
  readonly description: string;
  readonly immediateActions: string;
  readonly emergencyServices: Answer | null;
  readonly gp: Answer | null;
}

export type IncidentField =
  | "type"
  | "when"
  | "description"
  | "immediateActions"
  | "emergencyServices"
  | "gp"
  | "location";

/** The row queued in `incident_outbox`. */
export interface IncidentRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly person_id: string;
  readonly body: string;
  readonly queued_at: string;
}

export type IncidentCheck =
  | { readonly ok: true; readonly row: IncidentRow }
  | { readonly ok: false; readonly errors: Partial<Record<IncidentField, FieldError>> };

const answer = (value: Answer): boolean | null =>
  value === "yes" ? true : value === "no" ? false : null;

export function checkIncident(
  draft: IncidentDraft,
  context: EntryContext,
  now: Date,
): IncidentCheck {
  const errors: Partial<Record<IncidentField, FieldError>> = {};
  if (!draft.type || !INCIDENT_TYPES.includes(draft.type))
    errors.type = { key: "mobile.form.choose" };
  const description = draft.description.trim();
  if (description.length < INCIDENT_TEXT_LIMITS.descriptionMin) {
    errors.description = {
      key: "mobile.incident.descriptionTooShort",
      values: { min: INCIDENT_TEXT_LIMITS.descriptionMin },
    };
  } else if (description.length > INCIDENT_TEXT_LIMITS.max) {
    errors.description = {
      key: "mobile.incident.tooLong",
      values: { max: INCIDENT_TEXT_LIMITS.max },
    };
  }
  const actions = draft.immediateActions.trim();
  if (actions.length > INCIDENT_TEXT_LIMITS.max) {
    errors.immediateActions = {
      key: "mobile.incident.tooLong",
      values: { max: INCIDENT_TEXT_LIMITS.max },
    };
  }
  if (!draft.emergencyServices) errors.emergencyServices = { key: "mobile.form.choose" };
  if (!draft.gp) errors.gp = { key: "mobile.form.choose" };
  // The API needs the home; a person whose location is not on the phone cannot be reported here.
  if (!context.locationId) errors.location = { key: "mobile.incident.noLocation" };
  const when = resolveOccurredAt(
    draft.when,
    now,
    context.windowDays,
    context.clockToleranceMinutes ?? 0,
  );
  if (!when.ok) errors.when = { key: when.error };
  if (
    Object.keys(errors).length > 0 ||
    !when.ok ||
    !draft.type ||
    !draft.emergencyServices ||
    !draft.gp ||
    !context.locationId
  ) {
    return { ok: false, errors };
  }

  const id = context.newId();
  const body: CreateIncident = {
    id,
    locationId: context.locationId,
    type: draft.type,
    occurredAt: when.occurredAt.toISOString(),
    deviceTime: now.toISOString(),
    description,
    ...(actions ? { immediateActions: actions } : {}),
    emergencyServicesCalled: answer(draft.emergencyServices),
    gpContacted: answer(draft.gp),
    people: [
      {
        kind: "service_user",
        role: "affected",
        personId: context.personId,
        died: false,
        bodyMapMarkIds: [],
      },
    ],
    answers: [],
  };
  return {
    ok: true,
    row: {
      id,
      tenant_id: context.tenantId,
      person_id: context.personId,
      body: JSON.stringify(body),
      queued_at: now.toISOString(),
    },
  };
}

export const INSERT_INCIDENT_SQL = `INSERT INTO incident_outbox (id, tenant_id, person_id, body,
  queued_at) VALUES (?, ?, ?, ?, ?)`;

export function insertIncidentParams(row: IncidentRow): readonly string[] {
  return [row.id, row.tenant_id, row.person_id, row.body, row.queued_at];
}

/** Reports not yet sent: `incident_outbox` is insert-only, so only the queue has them. */
export const QUEUED_INCIDENTS_SQL = `SELECT data FROM ps_crud
  WHERE data LIKE '%"incident_outbox"%' ORDER BY id`;

/** The demo database is local-only: its reports stay in the table, read in the queue's shape. */
export const DEMO_QUEUED_INCIDENTS_SQL = `SELECT json_object('op', 'PUT', 'type',
  'incident_outbox', 'id', id, 'data', json_object('tenant_id', tenant_id, 'person_id', person_id,
  'body', body)) AS data FROM incident_outbox ORDER BY queued_at`;

/** A report waiting to send, as the person's record lists it. */
export interface QueuedIncident {
  readonly id: string;
  readonly type: string;
  readonly occurredAt: string | null;
}

/**
 * The reports waiting to send about one person in one tenant, oldest first. Anything unreadable
 * is left out here; the connector parks it under "needs attention" when it tries to send it.
 */
export function queuedIncidentsFor(
  rows: readonly { readonly data: string | null }[],
  tenantId: string,
  personId: string,
): QueuedIncident[] {
  const out: QueuedIncident[] = [];
  for (const row of rows) {
    const entry = parse(row.data);
    if (entry?.type !== "incident_outbox" || typeof entry.id !== "string") continue;
    const data = isObject(entry.data) ? entry.data : {};
    if (data.tenant_id !== tenantId || data.person_id !== personId) continue;
    const body = typeof data.body === "string" ? parse(data.body) : null;
    out.push({
      id: entry.id,
      type: typeof body?.type === "string" ? body.type : "other",
      occurredAt: typeof body?.occurredAt === "string" ? body.occurredAt : null,
    });
  }
  return out;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function parse(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
