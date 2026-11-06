import { ukEndOfDay } from "../shared/time";
import type { HealthResult } from "./ports";

/**
 * The Thapsus-HR link (Phase 2 slice 86; INTG-014; ADR-0126; integrations.md section 11; HZ-133).
 * Pure rules: who owns each kind of staff data, the UK-only connection, matching that never relies
 * on a name, the fields each flow may carry, staleness, the leaver rule and the double-payment
 * guard. The port is implemented by a contract-tested mock until Thapsus-HR's Phase 19 ships.
 */

/** The partner kind Thapsus-HR uses for this product (its `partner_connections.kind`, K1). */
export const THAPSUS_HR_PARTNER_KIND = "thapsus_care";
/** The only home region a linked Thapsus-HR workspace may have (ADR-0098, ADR-0126). */
export const THAPSUS_HR_HOME_REGION = "uk";

// ---- Owners (rule 2; ADR-0126 table; H-1340) --------------------------------------------------

export const HR_DATA_KINDS = [
  "employee_record",
  "leavers",
  "pay_rates_and_periods",
  "leave_and_sickness",
  "care_shifts",
  "clocking",
  "timesheets_and_pay_units",
  "recruitment_and_vetting",
  "training_and_competence",
] as const;
export type HrDataKind = (typeof HR_DATA_KINDS)[number];
export type HrSystem = "harbour" | "thapsus_hr";
export type HrOwners = Readonly<Record<HrDataKind, HrSystem>>;

/** ADR-0126's default owners. */
export const DEFAULT_HR_OWNERS: HrOwners = {
  employee_record: "thapsus_hr",
  leavers: "thapsus_hr",
  pay_rates_and_periods: "thapsus_hr",
  leave_and_sickness: "thapsus_hr",
  care_shifts: "harbour",
  clocking: "harbour",
  timesheets_and_pay_units: "harbour",
  recruitment_and_vetting: "harbour",
  training_and_competence: "harbour",
};

/**
 * Kinds whose owner a tenant cannot change: care-specific records Thapsus-HR has no model for
 * (DBS, the Reg 19 file, competence), and clocking at the point of care, which only the app does.
 */
export const FIXED_HR_OWNERS: Readonly<Partial<Record<HrDataKind, HrSystem>>> = {
  recruitment_and_vetting: "harbour",
  training_and_competence: "harbour",
  clocking: "harbour",
  // Harbour keeps care shifts and the rota (ADR-0126; confirmed 06/11/2026): Thapsus-HR shows them
  // read-only, so safe staffing, competence and Working Time are always checked (HZ-123, HZ-124).
  care_shifts: "harbour",
};

export type OwnersProblem = { readonly kind: HrDataKind; readonly problem: "fixed_owner" };

/** The owners a tenant chose, checked: a fixed kind keeps its owner. */
export function ownersProblems(owners: HrOwners): OwnersProblem[] {
  return HR_DATA_KINDS.filter((k) => {
    const fixed = FIXED_HR_OWNERS[k];
    return fixed !== undefined && owners[k] !== fixed;
  }).map((kind) => ({ kind, problem: "fixed_owner" as const }));
}

/**
 * Whether a system may edit a kind of data: only its owner. The other system's copy is read-only
 * ("Managed in Thapsus-HR"); reconciliation puts back the owner's version (rule 2).
 */
export function editRefusal(
  owners: HrOwners,
  kind: HrDataKind,
  editor: HrSystem,
): "managed_elsewhere" | null {
  return owners[kind] === editor ? null : "managed_elsewhere";
}

// ---- UK only (rule 1) -------------------------------------------------------------------------

export type ConnectionRefusal = "not_uk_region" | "not_uk_host" | "not_https";

/**
 * Whether Harbour may talk to a Thapsus-HR workspace: its home region is `uk` and its API is the
 * UK host on Thapsus's domain, over HTTPS, with no credentials in the URL. Checked when connecting
 * and before every sync; otherwise nothing is sent. `apiBaseUrl` must be the URL the adapter
 * actually connects to, from Harbour's own connection record, never what the workspace reports
 * about itself (security review, slice 86).
 */
export function connectionRefusal(input: {
  readonly homeRegion: string;
  readonly apiBaseUrl: string;
  /** Thapsus's own domain (configuration), for example `thapsus.example`. */
  readonly thapsusDomain: string;
}): ConnectionRefusal | null {
  if (input.homeRegion !== THAPSUS_HR_HOME_REGION) return "not_uk_region";
  let url: URL;
  try {
    url = new URL(input.apiBaseUrl);
  } catch {
    return "not_uk_host";
  }
  if (url.protocol !== "https:") return "not_https";
  const domain = input.thapsusDomain.trim().toLowerCase().replace(/^\.+/, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return "not_uk_host";
  if (url.username !== "" || url.password !== "") return "not_uk_host";
  if (url.hostname.toLowerCase() !== `api.uk.${domain}` || url.port !== "") return "not_uk_host";
  return null;
}

// ---- Matching (rule 3) ------------------------------------------------------------------------

export interface HrEmployee {
  readonly id: string;
  readonly employeeNumber: string | null;
  readonly workEmail: string | null;
  /** YYYY-MM-DD, for matching only; never stored by Harbour beyond the match. */
  readonly dateOfBirth: string | null;
  readonly givenName: string;
  readonly familyName: string;
  /** Fields Thapsus-HR owns that Harbour copies (section 11.8); absent when not sent. */
  readonly jobTitle?: string | null;
  readonly startDate?: string | null;
  readonly leavingDate?: string | null;
  readonly locationId?: string | null;
}

export interface StaffCandidate {
  readonly memberId: string;
  readonly employeeNumber: string | null;
  readonly workEmail: string | null;
  readonly dateOfBirth: string | null;
  /** Already linked to a Thapsus-HR employee: never matched again. */
  readonly linked: boolean;
}

export type MatchResult =
  | {
      readonly kind: "matched";
      readonly memberId: string;
      readonly how: "employee_number" | "email_and_birth_date";
    }
  | {
      readonly kind: "review";
      readonly reason: "no_match" | "ambiguous" | "conflict" | "already_linked";
    };

const norm = (v: string | null) => (v ?? "").trim().toLowerCase();

/**
 * Matches a Thapsus-HR employee to a Harbour staff member: by employee number first, then by work
 * email together with date of birth. Never by name, alone or with anything else. A number match
 * whose email or date of birth disagrees, more than one candidate, or a candidate already linked
 * goes to the review queue; an unconfirmed person is neither rostered from Thapsus-HR data nor
 * sent to it (HZ-133).
 */
export function matchEmployee(
  employee: HrEmployee,
  candidates: readonly StaffCandidate[],
): MatchResult {
  const number = norm(employee.employeeNumber);
  if (number !== "") {
    const byNumber = candidates.filter((c) => norm(c.employeeNumber) === number);
    if (byNumber.length > 1) return { kind: "review", reason: "ambiguous" };
    const [hit] = byNumber;
    if (hit) {
      const disagrees =
        (norm(hit.workEmail) !== "" &&
          norm(employee.workEmail) !== "" &&
          norm(hit.workEmail) !== norm(employee.workEmail)) ||
        (hit.dateOfBirth !== null &&
          employee.dateOfBirth !== null &&
          hit.dateOfBirth !== employee.dateOfBirth);
      if (disagrees) return { kind: "review", reason: "conflict" };
      // Another member holds the same work email and date of birth: two routes, two people.
      const other = candidates.some(
        (c) =>
          c.memberId !== hit.memberId &&
          norm(c.workEmail) !== "" &&
          norm(c.workEmail) === norm(employee.workEmail) &&
          c.dateOfBirth !== null &&
          c.dateOfBirth === employee.dateOfBirth,
      );
      if (other) return { kind: "review", reason: "conflict" };
      if (hit.linked) return { kind: "review", reason: "already_linked" };
      return { kind: "matched", memberId: hit.memberId, how: "employee_number" };
    }
  }
  const email = norm(employee.workEmail);
  if (email === "" || employee.dateOfBirth === null) return { kind: "review", reason: "no_match" };
  const byEmail = candidates.filter(
    (c) => norm(c.workEmail) === email && c.dateOfBirth === employee.dateOfBirth,
  );
  if (byEmail.length > 1) return { kind: "review", reason: "ambiguous" };
  const [hit] = byEmail;
  if (!hit) return { kind: "review", reason: "no_match" };
  // Both have employee numbers and they differ: never matched on email (clinical review, slice 86).
  if (number !== "" && norm(hit.employeeNumber) !== "" && norm(hit.employeeNumber) !== number) {
    return { kind: "review", reason: "conflict" };
  }
  if (hit.linked) return { kind: "review", reason: "already_linked" };
  return { kind: "matched", memberId: hit.memberId, how: "email_and_birth_date" };
}

// ---- Fields that cross (rule 4, rule 10; section 11.8) ----------------------------------------

/** The only fields each outbound flow may carry. Nothing about people receiving care. */
export const OUTBOUND_FIELDS = {
  starter: [
    "givenName",
    "familyName",
    "workEmail",
    "dateOfBirth",
    "jobTitle",
    "locationId",
    "contractedHours",
    "startDate",
  ],
  shift: [
    "harbourRef",
    "employeeId",
    "locationId",
    "role",
    "startsAt",
    "endsAt",
    "startsAtLocal",
    "endsAtLocal",
    "breakMinutes",
  ],
  clock_event: ["harbourRef", "employeeId", "kind", "at", "atLocal", "locationId"],
  pay_units: ["employeeId", "payPeriodId", "payCode", "units"],
} as const;
export type OutboundFlow = keyof typeof OUTBOUND_FIELDS;

/** Fields a payload carries that its flow does not allow: the payload is never sent. */
export function outboundExtraFields(flow: OutboundFlow, payload: object): string[] {
  const allowed: readonly string[] = OUTBOUND_FIELDS[flow];
  return Object.keys(payload).filter((k) => !allowed.includes(k));
}

/** A clock event's kinds that cross: in and out only (breaks stay in Harbour). */
export const OUTBOUND_CLOCK_KINDS = ["in", "out"] as const;
/** The longest text any outbound field may carry. */
export const OUTBOUND_MAX_TEXT = 200;

/**
 * Everything wrong with an outbound payload, by field: a field its flow does not allow, a value
 * that is not a plain string, number, boolean or null (so nothing nested can ride inside an
 * allowed field), a text longer than `OUTBOUND_MAX_TEXT`, or a clock kind other than in and out.
 * A payload with any problem is never sent (rule 4).
 */
export function outboundProblems(flow: OutboundFlow, payload: object): string[] {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload))
    return ["(payload)"];
  if (Object.getPrototypeOf(payload) !== Object.prototype) return ["(payload)"];
  const allowed: readonly string[] = OUTBOUND_FIELDS[flow];
  const problems: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (!allowed.includes(key)) problems.push(key);
    else if (
      !(value === null || ["string", "number", "boolean"].includes(typeof value)) ||
      (typeof value === "string" && value.length > OUTBOUND_MAX_TEXT) ||
      (typeof value === "number" && !Number.isFinite(value))
    ) {
      problems.push(key);
    } else if (
      flow === "clock_event" &&
      key === "kind" &&
      !(OUTBOUND_CLOCK_KINDS as readonly unknown[]).includes(value)
    ) {
      problems.push(key);
    }
  }
  return problems;
}

/** A real calendar day as YYYY-MM-DD (2026-02-30 and 2026-13-45 are not). */
export function realDay(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export type HrAbsenceType = "leave" | "sickness" | "other";

export interface HrAbsence {
  readonly id: string;
  readonly employeeId: string;
  readonly type: HrAbsenceType;
  readonly startsOn: string;
  readonly endsOn: string | null;
  readonly status: "requested" | "approved" | "cancelled";
}

const ABSENCE_TYPES: Readonly<Record<string, HrAbsenceType>> = {
  annual_leave: "leave",
  leave: "leave",
  holiday: "leave",
  sickness: "sickness",
  sick: "sickness",
};

/**
 * An absence as it may enter Harbour: identifier, employee, type, dates and status only. Reasons,
 * fit notes, notes and anything medical are dropped, never kept (rule 10). A record that does not
 * carry the minimum is refused (null), to be quarantined.
 */
export function inboundAbsence(raw: Readonly<Record<string, unknown>>): HrAbsence | null {
  const s = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : null);
  const id = s("id");
  const employeeId = s("employeeId");
  const startsOn = s("startsOn");
  const endsOn = s("endsOn");
  const status = s("status");
  const ident = /^[A-Za-z0-9_-]{1,64}$/;
  if (!id || !employeeId || !ident.test(id) || !ident.test(employeeId)) return null;
  if (!startsOn || !realDay(startsOn)) return null;
  if (endsOn !== null && (!realDay(endsOn) || endsOn < startsOn)) return null;
  if (status !== "requested" && status !== "approved" && status !== "cancelled") return null;
  const type = ABSENCE_TYPES[(s("type") ?? "").toLowerCase()] ?? "other";
  return { id, employeeId, type, startsOn, endsOn, status };
}

// ---- Staleness (rule 9; H-1344) ---------------------------------------------------------------

/** The default staleness limit and the highest a tenant may set (H-1344); a tenant may lower it. */
export const HR_STALENESS_DEFAULT_MINUTES = 15;
export const HR_STALENESS_MAX_MINUTES = 60;

export function stalenessLimitProblem(minutes: number): "out_of_range" | null {
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= HR_STALENESS_MAX_MINUTES
    ? null
    : "out_of_range";
}

export interface Staleness {
  readonly stale: boolean;
  /** Whole minutes since the last good sync; null when there has never been one. */
  readonly minutesSince: number | null;
}

/**
 * Whether the copy of Thapsus-HR data is out of date: stale once the last good sync is more than
 * the limit old (exactly at the limit is not stale), or when there has never been a good sync.
 * Absences already known still block rostering whatever this says.
 */
export function hrStaleness(
  lastGoodSyncAt: Date | null,
  now: Date,
  limitMinutes: number = HR_STALENESS_DEFAULT_MINUTES,
): Staleness {
  if (lastGoodSyncAt === null) return { stale: true, minutesSince: null };
  // A limit outside 1 to 60 minutes counts as the default (H-1344).
  const limit =
    stalenessLimitProblem(limitMinutes) === null ? limitMinutes : HR_STALENESS_DEFAULT_MINUTES;
  const ms = now.getTime() - lastGoodSyncAt.getTime();
  return {
    // A last sync in the future (clock skew) is not trusted as fresh.
    stale: ms < 0 || ms > limit * 60_000,
    minutesSince: Math.max(0, Math.floor(ms / 60_000)),
  };
}

// ---- Leavers (rule 8) -------------------------------------------------------------------------

/** When a leaver's sign-in ends: the end of their leaving day in UK time. */
export function leaverSignInEndsAt(leavingDate: string): Date {
  return ukEndOfDay(leavingDate);
}

/**
 * Whether a member may still sign in. A leaving date that is not a real day refuses sign-in (and
 * the record is quarantined by the caller); a failed sync never extends access.
 */
export function leaverMaySignIn(leavingDate: string | null, now: Date): boolean {
  if (leavingDate === null) return true;
  if (!realDay(leavingDate)) return false;
  return now.getTime() < leaverSignInEndsAt(leavingDate).getTime();
}

/**
 * The leaving date to keep after a sync: once known, a sync that drops the date or moves it later
 * never gives access back; only an earlier date replaces it. A person withdraws a leaving date in
 * Harbour's review queue, never a sync (clinical review, slice 86).
 */
export function effectiveLeavingDate(known: string | null, incoming: string | null): string | null {
  if (known === null) return incoming !== null && realDay(incoming) ? incoming : null;
  if (incoming !== null && realDay(incoming) && incoming < known) return incoming;
  return known;
}

// ---- No double payment (rule 12; HZ-133) ------------------------------------------------------

/** Who sends approved pay to payroll for a tenant. */
export type PayRoute = "harbour_export" | "thapsus_hr";

/**
 * Whether Harbour's own payroll export (slice 76) may run for a pay period: never while the route
 * to payroll is Thapsus-HR's, so nobody is paid twice. A route change takes effect only from the
 * start of the next pay period, never part-way through one.
 */
export interface PayRouteInput {
  readonly currentRoute: PayRoute;
  /** A change waiting for the next pay period, or null. */
  readonly pendingRoute: PayRoute | null;
  readonly pendingFrom: string | null;
  /** The pay period being exported or sent (YYYY-MM-DD start). */
  readonly periodStart: string;
}

/** The route for a pay period; null when a date is not a real day (then nothing is paid out). */
function routeFor(input: PayRouteInput): PayRoute | null {
  if (!realDay(input.periodStart)) return null;
  if (input.pendingRoute === null || input.pendingFrom === null) return input.currentRoute;
  if (!realDay(input.pendingFrom)) return null;
  return input.periodStart >= input.pendingFrom ? input.pendingRoute : input.currentRoute;
}

export function payrollExportAllowed(input: PayRouteInput): boolean {
  return routeFor(input) === "harbour_export";
}

/** Whether pay units may go to Thapsus-HR for a period: only when its route is Thapsus-HR's. */
export function payUnitsToHrAllowed(input: PayRouteInput): boolean {
  return routeFor(input) === "thapsus_hr";
}

/** A route change may start only on a later pay period, never the current one or before. */
export function payRouteChangeProblem(input: {
  readonly from: string;
  readonly currentPeriodStart: string;
}): "not_a_later_period" | null {
  return realDay(input.from) &&
    realDay(input.currentPeriodStart) &&
    input.from > input.currentPeriodStart
    ? null
    : "not_a_later_period";
}

// ---- The port ---------------------------------------------------------------------------------

/** Thapsus-HR's capabilities at the pinned commit, and those planned in its Phase 19 (K1 to K7). */
export type HrCapability =
  | "employees_read"
  | "employees_write"
  | "org_read"
  | "leave_read"
  | "time_write"
  | "partner_connections"
  | "partner_managed_records"
  | "partner_events"
  | "partner_pay_items"
  | "pay_rates_read"
  | "partner_rate_limit";

export type HrResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error:
        | "planned"
        | "refused"
        | "not_found"
        | "conflict"
        | "partner_managed"
        | "rate_limited"
        | "unavailable";
      /** Seconds to wait, from `Retry-After`, for a 429. */
      readonly retryAfterSeconds?: number;
    };

export interface HrWorkspace {
  readonly slug: string;
  readonly homeRegion: string;
  readonly apiBaseUrl: string;
}

export interface HrLocation {
  readonly id: string;
  readonly name: string;
}

export interface HrPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export type HrStarter = Readonly<Record<(typeof OUTBOUND_FIELDS)["starter"][number], unknown>>;
export type HrShift = Readonly<Record<(typeof OUTBOUND_FIELDS)["shift"][number], unknown>>;
export type HrClockEvent = Readonly<
  Record<(typeof OUTBOUND_FIELDS)["clock_event"][number], unknown>
>;
export type HrPayUnit = Readonly<Record<(typeof OUTBOUND_FIELDS)["pay_units"][number], unknown>>;

export interface HrRate {
  readonly employeeId: string;
  /** Pence an hour. */
  readonly hourlyPence: number;
  readonly effectiveFrom: string;
}

/**
 * Harbour's view of Thapsus-HR's API. Every write carries Harbour's event identifier as its
 * idempotency key. A planned capability (Phase 19) answers `planned` until it ships.
 */
export interface ThapsusHrPort {
  readonly pinnedCommit: string;
  /** The URL this adapter actually sends to, from Harbour's connection record (rule 1). */
  readonly apiBaseUrl: string;
  capabilities(): Readonly<Record<HrCapability, "available" | "planned">>;
  workspace(): Promise<HrResult<HrWorkspace>>;
  locations(): Promise<HrResult<readonly HrLocation[]>>;
  employees(cursor: string | null): Promise<HrResult<HrPage<HrEmployee>>>;
  employee(id: string): Promise<HrResult<HrEmployee & { readonly leavingDate: string | null }>>;
  createEmployee(
    starter: HrStarter,
    idempotencyKey: string,
  ): Promise<HrResult<{ readonly id: string }>>;
  absences(cursor: string | null): Promise<HrResult<HrPage<Readonly<Record<string, unknown>>>>>;
  upsertShift(shift: HrShift, idempotencyKey: string): Promise<HrResult<{ readonly id: string }>>;
  postClockEvent(
    event: HrClockEvent,
    idempotencyKey: string,
  ): Promise<HrResult<{ readonly id: string }>>;
  putPayUnits(
    payPeriodId: string,
    units: readonly HrPayUnit[],
    idempotencyKey: string,
  ): Promise<HrResult<{ readonly accepted: number }>>;
  rates(employeeIds: readonly string[]): Promise<HrResult<readonly HrRate[]>>;
  health(): Promise<HealthResult>;
}

/** The employee webhooks Thapsus-HR sends at the pinned commit (identifiers only; section 11.2). */
export const HR_WEBHOOK_EVENTS = [
  "employee.created",
  "employee.changed",
  "employee.transferred",
  "employee.terminated",
] as const;
export type HrWebhookEvent = (typeof HR_WEBHOOK_EVENTS)[number];

/** How far a webhook's signed time may be from now, either way, before it is refused as a replay. */
export const HR_WEBHOOK_REPLAY_SECONDS = 300;

/**
 * Why a webhook's signed time (Unix seconds) is refused, or null: not a whole number of seconds,
 * older than the replay window, or further ahead than it.
 */
export function webhookTimestampProblem(
  sentAtSeconds: number,
  now: Date,
): "invalid" | "too_old" | "in_future" | null {
  if (!Number.isSafeInteger(sentAtSeconds) || sentAtSeconds <= 0) return "invalid";
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (nowSeconds - sentAtSeconds > HR_WEBHOOK_REPLAY_SECONDS) return "too_old";
  if (sentAtSeconds - nowSeconds > HR_WEBHOOK_REPLAY_SECONDS) return "in_future";
  return null;
}

/** Harbour's copy of the fields Thapsus-HR owns in the staff file. */
export interface StaffFileCopy {
  readonly jobTitle: string | null;
  readonly startsOn: string | null;
}

export type DriftField = "job_title" | "start_date";

/**
 * The owned fields where Harbour's copy differs from Thapsus-HR's (rule 2): only fields Thapsus-HR
 * sent, and a start date only when it is a real day. Reconciliation puts back Thapsus-HR's value.
 */
export function employeeDrift(copy: StaffFileCopy, employee: HrEmployee): DriftField[] {
  const drift: DriftField[] = [];
  const title = typeof employee.jobTitle === "string" ? employee.jobTitle.trim() : "";
  if (title.length >= 2 && title.length <= 120 && title !== (copy.jobTitle ?? "").trim()) {
    drift.push("job_title");
  }
  const start = employee.startDate;
  if (typeof start === "string" && realDay(start) && start !== copy.startsOn) {
    drift.push("start_date");
  }
  return drift;
}
