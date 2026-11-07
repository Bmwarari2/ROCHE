import {
  FIXED_HR_OWNERS,
  HR_DATA_KINDS,
  HR_STALENESS_MAX_MINUTES,
  type HrDataKind,
  type HrOwners,
  type HrSystem,
  PAY_CODE,
} from "@harbour/domain";
import type { Translator } from "@harbour/i18n";
import type { SafetyChip } from "./incidents";
import { type Problem, problemMessage } from "./outcome";
import { type FormLike, readDateField } from "./uk-time";

/**
 * The link to the HR platform (Thapsus-HR; integrations.md section 11; INTG-014; ADR-0126; slice
 * 90; HZ-133, HZ-140): who sees its settings page, the forms' checks and the words for its states.
 * Pure and unit tested. The API checks every rule again: the page reads status, sync health and
 * deliveries for `integrations.hr_link.read`, `.review` or `.manage`; matches need `.review` or
 * `.manage`; connecting, owners, locations, pay and releases need `.manage` with a fresh step-up
 * (pay codes also `scheduling.pay.approve`). In user-facing copy Thapsus-HR is "the HR platform".
 */

export const HR_LINK_PAGE = "/settings/hr-link";
export const HR_LINK_READ = "integrations.hr_link.read";
export const HR_LINK_REVIEW = "integrations.hr_link.review";
export const HR_LINK_MANAGE = "integrations.hr_link.manage";
/** Pay codes decide what payroll pays: a pay approver sets them (API, slice 89). */
export const PAY_APPROVE = "scheduling.pay.approve";
/** The organisation's flag: the link is off until it is turned on (ADR-0126). */
export const HR_LINK_FLAG = "integrations.thapsus_hr";
/** The reconciliation runs every 5 minutes, so the API refuses a staleness limit below this. */
export const STALENESS_MIN_MINUTES = 10;
export const STALENESS_MAX_MINUTES = HR_STALENESS_MAX_MINUTES;
/** How many deliveries the page lists (the API gives the latest 200). */
export const DELIVERIES_SHOWN = 50;

const WORKSPACE_SLUG = /^[a-z0-9-]{1,63}$/;
/** A Secret Manager reference the API may accept (it checks the project and organisation too). */
const SECRET_REF =
  /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/locations\/[a-z0-9-]+\/secrets\/harbour_int_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_[a-z0-9][a-z0-9-]{0,62}(\/versions\/(latest|[1-9][0-9]*))?$/;
const HR_LOCATION_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function hrLinkShown(permissions: readonly string[]): boolean {
  return [HR_LINK_READ, HR_LINK_REVIEW, HR_LINK_MANAGE].some((p) => permissions.includes(p));
}

/** The module link: for holders of the link's permissions once the organisation has turned it on. */
export function hrLinkNavShown(me: {
  readonly permissions: readonly string[];
  readonly flags: Readonly<Record<string, boolean>>;
}): boolean {
  return hrLinkShown(me.permissions) && me.flags[HR_LINK_FLAG] === true;
}

export interface HrLinkMay {
  readonly manage: boolean;
  readonly review: boolean;
  readonly payCodes: boolean;
}

export function hrLinkMay(permissions: readonly string[]): HrLinkMay {
  const manage = permissions.includes(HR_LINK_MANAGE);
  return {
    manage,
    // Confirming and rejecting need `.review` itself (the API), whatever else is held.
    review: permissions.includes(HR_LINK_REVIEW),
    payCodes: manage && permissions.includes(PAY_APPROVE),
  };
}

// ---- Owners (rule 2) --------------------------------------------------------------------------

/** The kinds of staff data an organisation chooses an owner for; the rest are always this product's. */
export const CHOOSABLE_KINDS: readonly HrDataKind[] = HR_DATA_KINDS.filter(
  (k) => FIXED_HR_OWNERS[k] === undefined,
);
export const FIXED_KINDS: readonly HrDataKind[] = HR_DATA_KINDS.filter(
  (k) => FIXED_HR_OWNERS[k] !== undefined,
);

type Errors = Readonly<Record<string, string>>;

const text = (form: FormLike, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};

export type ConnectRead =
  | {
      readonly ok: true;
      readonly body: { readonly workspaceSlug: string; readonly secretRef: string | null };
    }
  | { readonly ok: false; readonly errors: Errors };

/** Connecting: the workspace's short name, and the webhook secret's reference when there is one. */
export function readConnect(form: FormLike, t: Translator): ConnectRead {
  const errors: Record<string, string> = {};
  const workspaceSlug = text(form, "workspaceSlug").toLowerCase();
  const secretRef = text(form, "secretRef");
  if (!WORKSPACE_SLUG.test(workspaceSlug)) errors.workspaceSlug = t("hrLink.connect.slugError");
  if (secretRef !== "" && !SECRET_REF.test(secretRef)) {
    errors.secretRef = t("hrLink.connect.secretError");
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, body: { workspaceSlug, secretRef: secretRef === "" ? null : secretRef } };
}

export type SettingsRead =
  | { readonly ok: true; readonly owners: HrOwners; readonly stalenessMinutes: number }
  | { readonly ok: false; readonly errors: Errors };

/**
 * Owners and the staleness limit: an owner for each kind the organisation chooses (the fixed ones
 * stay this product's), and a whole number of minutes from 10 to 60.
 */
export function readSettings(form: FormLike, t: Translator): SettingsRead {
  const errors: Record<string, string> = {};
  const owners: Record<string, HrSystem> = {};
  for (const kind of HR_DATA_KINDS) {
    const fixed = FIXED_HR_OWNERS[kind];
    if (fixed) {
      owners[kind] = fixed;
      continue;
    }
    const value = text(form, `owner-${kind}`);
    if (value === "harbour" || value === "thapsus_hr") owners[kind] = value;
    else errors[`owner-${kind}`] = t("hrLink.owners.chooseError");
  }
  const raw = text(form, "stalenessMinutes");
  const minutes = /^\d{1,3}$/.test(raw) ? Number(raw) : Number.NaN;
  if (
    !Number.isInteger(minutes) ||
    minutes < STALENESS_MIN_MINUTES ||
    minutes > STALENESS_MAX_MINUTES
  ) {
    errors.stalenessMinutes = t("hrLink.owners.stalenessError", {
      min: STALENESS_MIN_MINUTES,
      max: STALENESS_MAX_MINUTES,
    });
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, owners: owners as HrOwners, stalenessMinutes: minutes };
}

// ---- Pay (rules 11 and 12) --------------------------------------------------------------------

export type PayRoute = "harbour_export" | "thapsus_hr";

const ENHANCEMENTS = ["bank_holiday", "night", "overtime", "weekend"] as const;
type Enhancement = (typeof ENHANCEMENTS)[number];

/**
 * Every unit kind the pay calculation gives (`payUnits`): paid hours, alone or with any of the
 * enhancements (sorted and joined by `_`), then sleep-ins, on-call periods away and miles. Plain
 * hours first, then by the number of enhancements.
 */
export const PAY_UNIT_KINDS: readonly string[] = (() => {
  const subsets: Enhancement[][] = [];
  for (let mask = 0; mask < 1 << ENHANCEMENTS.length; mask++) {
    subsets.push(ENHANCEMENTS.filter((_, i) => (mask & (1 << i)) !== 0));
  }
  subsets.sort((a, b) => a.length - b.length || a.join("_").localeCompare(b.join("_")));
  return [...subsets.map((s) => ["hours", ...s].join("_")), "sleep_in", "on_call", "mileage"];
})();

/** The enhancements in an hours kind, in order: "hours_night_weekend" gives night and weekend. */
export function enhancementsOf(kind: string): Enhancement[] | null {
  if (kind === "hours") return [];
  if (!kind.startsWith("hours_")) return null;
  const out: Enhancement[] = [];
  let rest = kind.slice("hours_".length);
  while (rest !== "") {
    const next = ENHANCEMENTS.find((e) => rest === e || rest.startsWith(`${e}_`));
    if (!next || out.includes(next)) return null;
    out.push(next);
    rest = rest.slice(next.length + 1);
  }
  return out;
}

/** A unit kind in words: "Hours: night and weekend", "Sleep-ins". */
export function unitKindWords(kind: string, t: Translator): string {
  const enhancements = enhancementsOf(kind);
  if (enhancements === null) return t("hrLink.pay.unitKind", { kind });
  if (enhancements.length === 0) return t("hrLink.pay.unitKind", { kind: "hours" });
  const words = enhancements.map((e) => t("hrLink.pay.enhancement", { enhancement: e }));
  const list = new Intl.ListFormat(t.locale, { type: "conjunction" }).format(words);
  return t("hrLink.pay.hoursWith", { list });
}

/** The form field for a unit kind's pay code. */
export const payCodeField = (kind: string) => `code-${kind}`;

export type PayCodesRead =
  | { readonly ok: true; readonly codes: Record<string, string> }
  | { readonly ok: false; readonly errors: Errors };

/** Pay codes: a well-formed code for each kind given; a blank kind is not mapped (and stops a lock). */
export function readPayCodes(form: FormLike, t: Translator): PayCodesRead {
  const errors: Record<string, string> = {};
  const codes: Record<string, string> = {};
  for (const kind of PAY_UNIT_KINDS) {
    const code = text(form, payCodeField(kind));
    if (code === "") continue;
    if (PAY_CODE.test(code)) codes[kind] = code;
    else errors[payCodeField(kind)] = t("hrLink.pay.codeError");
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, codes };
}

export type PayRouteRead =
  | { readonly ok: true; readonly route: PayRoute; readonly from: string }
  | {
      readonly ok: false;
      readonly errors: Errors;
      readonly parts?: Readonly<Record<string, readonly string[]>>;
    };

/** A change of route to payroll: which route, and the first day of the pay period it starts. */
export function readPayRoute(form: FormLike, t: Translator): PayRouteRead {
  const errors: Record<string, string> = {};
  const route = text(form, "route");
  if (route !== "harbour_export" && route !== "thapsus_hr") {
    errors.route = t("hrLink.pay.routeError");
  }
  const from = readDateField(form, "from", { subject: t("hrLink.pay.fromSubject"), t });
  if (!from.ok) errors.from = from.message;
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors, ...(from.ok ? {} : { parts: { from: from.parts } }) };
  }
  return { ok: true, route: route as PayRoute, from: (from as { date: string }).date };
}

/** The route in force and any change waiting, as the status gives them. */
export interface PaySettings {
  readonly route: PayRoute;
  readonly pendingRoute: PayRoute | null;
  readonly pendingFrom: string | null;
  readonly codes: Readonly<Record<string, string>>;
}

/** The kinds with no pay code yet: a run paid through the HR platform cannot be locked until mapped. */
export function unmappedKinds(codes: Readonly<Record<string, string>>): string[] {
  return PAY_UNIT_KINDS.filter((k) => !codes[k]);
}

// ---- Location mapping -------------------------------------------------------------------------

/** The HR platform location chosen for a home: an offered id, or null to clear the mapping. */
export function readLocationMap(
  form: FormLike,
  offered: ReadonlySet<string>,
  t: Translator,
): { ok: true; hrLocationId: string | null } | { ok: false; errors: Errors } {
  const value = text(form, "hrLocationId");
  if (value === "") return { ok: true, hrLocationId: null };
  if (!HR_LOCATION_ID.test(value) || !offered.has(value)) {
    return { ok: false, errors: { hrLocationId: t("hrLink.locations.chooseError") } };
  }
  return { ok: true, hrLocationId: value };
}

// ---- Releasing held absence copies (rule 13; HZ-133) ------------------------------------------

export type ReleaseMode = "drift" | "disconnected";
export type ReleaseReason = "checked_in_hr_platform" | "link_ended" | "other_recorded_in_review";

/** The reasons the API takes for each kind of release (routes/hr-link-absences.ts). */
export const RELEASE_REASONS: Readonly<Record<ReleaseMode, readonly ReleaseReason[]>> = {
  drift: ["checked_in_hr_platform", "other_recorded_in_review"],
  disconnected: ["link_ended", "other_recorded_in_review"],
};

/** A release: a reason that fits it, and the box that says the copies were checked. */
export function readRelease(
  form: FormLike,
  mode: ReleaseMode,
  t: Translator,
): { ok: true; reason: ReleaseReason } | { ok: false; errors: Errors } {
  const errors: Record<string, string> = {};
  const reason = text(form, "reason") as ReleaseReason;
  if (!RELEASE_REASONS[mode].includes(reason)) errors.reason = t("hrLink.release.reasonError");
  if (text(form, "checked") !== "yes") errors.checked = t("hrLink.release.checkedError");
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, reason };
}

// ---- States in words, with an icon (never colour alone) ----------------------------------------

export function linkChip(
  status: { readonly connected: boolean; readonly status: string | null },
  t: Translator,
): SafetyChip {
  if (status.connected) {
    return {
      status: "done",
      icon: "circle-check",
      label: t("hrLink.status.state", { state: "connected" }),
    };
  }
  const state = status.status === null ? "none" : "disconnected";
  return {
    status: "notApplicable",
    icon: "circle-minus",
    label: t("hrLink.status.state", { state }),
  };
}

export function syncChip(
  staleness: { readonly stale: boolean; readonly lastGoodSyncAt: string | null } | null,
  t: Translator,
): SafetyChip {
  if (!staleness || staleness.lastGoodSyncAt === null) {
    return { status: "due", icon: "clock", label: t("hrLink.status.sync", { state: "never" }) };
  }
  return staleness.stale
    ? { status: "due", icon: "clock", label: t("hrLink.status.sync", { state: "stale" }) }
    : { status: "done", icon: "circle-check", label: t("hrLink.status.sync", { state: "fresh" }) };
}

const DELIVERY: Record<string, Omit<SafetyChip, "label">> = {
  sent: { status: "done", icon: "circle-check" },
  pending: { status: "info", icon: "clock" },
  failed: { status: "overdue", icon: "circle-alert" },
  refused: { status: "overdue", icon: "triangle-alert" },
};

export function deliveryChip(state: string, t: Translator): SafetyChip {
  const known = DELIVERY[state] ?? { status: "neutral", icon: "circle-minus" };
  return { ...known, label: t("hrLink.deliveries.state", { state }) };
}

/** Matches with a leaving date first, as the API orders them; then the rest in its order. */
export function leaversFirst<T extends { readonly leavingOn: string | null }>(
  items: readonly T[],
): T[] {
  return [...items.filter((m) => m.leavingOn !== null), ...items.filter((m) => !m.leavingOn)];
}

// ---- Refusals in plain words ------------------------------------------------------------------

/** Where a refusal came from, so a conflict or a rejected value is said in that form's words. */
export type HrLinkForm =
  | "connect"
  | "settings"
  | "payRoute"
  | "payCodes"
  | "location"
  | "match"
  | "release"
  | "check";

const problemCodeOf = (error: unknown): string =>
  typeof error === "object" &&
  error !== null &&
  typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : "";

/**
 * The link's refusals in the catalogue's words, tied to their fields (the API's own words name
 * Thapsus-HR, which the screens call the HR platform). Anything else as every form says it.
 */
export function hrLinkProblem(error: unknown, form: HrLinkForm, t: Translator): Problem {
  const code = problemCodeOf(error);
  const say = (
    key: Parameters<Translator>[0],
    field?: string,
    values: Record<string, string | number> = {},
  ): Problem => {
    const message = t(key, { app: t("app.name"), ...values });
    return { code, message, ...(field ? { fields: { [field]: message } } : {}) };
  };
  switch (code) {
    case "hr_link_not_uk":
      return say("hrLink.problem.notUk", form === "connect" ? "workspaceSlug" : undefined);
    case "hr_link_unavailable":
      return say("hrLink.problem.unavailable");
    case "rate_limited":
      return say("hrLink.problem.rateLimited");
    case "hr_link_not_connected":
      return say("hrLink.problem.notConnected");
    case "hr_link_pay_owners":
      return say("hrLink.problem.payOwners");
    case "hr_link_pay_not_available":
      return say("hrLink.problem.payNotAvailable", "route");
    case "pay_route_not_later":
      return say("hrLink.problem.payRouteNotLater", "from");
    case "not_hr_pay_period_start":
      return say("hrLink.problem.notPayPeriodStart", "from");
    case "hr_link_drift_changed": {
      const now = heldNow(error);
      return say("hrLink.problem.driftChanged", undefined, {
        known: now === null ? "no" : "yes",
        count: now ?? 0,
      });
    }
    case "hr_link_release_reason":
      return say("hrLink.problem.releaseReason", "reason");
    case "hr_link_off_while_connected":
      return say("hrLink.problem.offWhileConnected");
    case "hr_link_own_file":
      return say("hrLink.problem.ownFile", "staffProfileId");
    case "hr_link_leaver_needs_manager":
      return say("hrLink.problem.leaverNeedsManager", "staffProfileId");
    case "managed_in_thapsus_hr":
      return say("hrLink.managed.refusal");
    case "version_conflict":
      if (form === "connect") return say("hrLink.problem.alreadyLinked");
      if (form === "location") return say("hrLink.problem.locationTaken", "hrLocationId");
      if (form === "match") return say("hrLink.problem.matchTaken", "staffProfileId");
      return say("hrLink.problem.conflict");
    case "invalid":
      if (form === "location") return say("hrLink.locations.chooseError", "hrLocationId");
      if (form === "payCodes") return say("hrLink.pay.codeError");
      if (form === "settings") {
        return say("hrLink.problem.settingsInvalid", undefined, {
          min: STALENESS_MIN_MINUTES,
          max: STALENESS_MAX_MINUTES,
        });
      }
      return problemMessage(error, t);
    default:
      return problemMessage(error, t);
  }
}

/** How many copies are held now, from the API's refusal ("... (7 now) ..."), or null. */
export function heldNow(error: unknown): number | null {
  const detail =
    typeof error === "object" &&
    error !== null &&
    typeof (error as { detail?: unknown }).detail === "string"
      ? (error as { detail: string }).detail
      : "";
  const match = /\((\d{1,6}) now\)/.exec(detail);
  return match ? Number(match[1]) : null;
}

// ---- Checks at the server actions' boundary ---------------------------------------------------
// The same rules as the forms and the API's request schemas, again where the browser's input
// reaches the server (a server action can be called with anything).

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);

export const validVersion = (n: unknown): n is number => isInt(n) && n >= 0;

export function validConnect(body: unknown): body is {
  readonly workspaceSlug: string;
  readonly secretRef: string | null;
} {
  if (typeof body !== "object" || body === null) return false;
  const { workspaceSlug, secretRef, ...rest } = body as Record<string, unknown>;
  return (
    Object.keys(rest).length === 0 &&
    typeof workspaceSlug === "string" &&
    WORKSPACE_SLUG.test(workspaceSlug) &&
    (secretRef === null || (typeof secretRef === "string" && SECRET_REF.test(secretRef)))
  );
}

export function validOwners(owners: unknown): owners is HrOwners {
  if (typeof owners !== "object" || owners === null) return false;
  const entries = Object.entries(owners as Record<string, unknown>);
  return (
    entries.length === HR_DATA_KINDS.length &&
    HR_DATA_KINDS.every((kind) => {
      const value = (owners as Record<string, unknown>)[kind];
      const fixed = FIXED_HR_OWNERS[kind];
      return fixed ? value === fixed : value === "harbour" || value === "thapsus_hr";
    })
  );
}

export const validStaleness = (n: unknown): n is number =>
  isInt(n) && n >= STALENESS_MIN_MINUTES && n <= STALENESS_MAX_MINUTES;

export const validPayRoute = (route: unknown, from: unknown): boolean =>
  (route === "harbour_export" || route === "thapsus_hr") &&
  typeof from === "string" &&
  ISO_DATE.test(from) &&
  !Number.isNaN(Date.parse(`${from}T00:00:00Z`));

export function validPayCodes(codes: unknown): codes is Record<string, string> {
  if (typeof codes !== "object" || codes === null) return false;
  const entries = Object.entries(codes as Record<string, unknown>);
  return (
    entries.length <= PAY_UNIT_KINDS.length &&
    entries.every(
      ([kind, code]) =>
        PAY_UNIT_KINDS.includes(kind) && typeof code === "string" && PAY_CODE.test(code),
    )
  );
}

export const validReleaseReason = (reason: unknown): reason is ReleaseReason =>
  reason === "checked_in_hr_platform" ||
  reason === "link_ended" ||
  reason === "other_recorded_in_review";
