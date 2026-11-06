import type {
  RosterBlockerItem,
  RotaCheck,
  ShiftItem,
  StaffingComparisonItem,
} from "@harbour/contracts";
import type { Translator } from "@harbour/i18n";
import type { SafetyChip } from "./incidents";

/**
 * The rota builder's screens (scheduling.md section 14; SCHED-001, SCHED-002; hazards HZ-123 and
 * HZ-124). Pure and unit tested. Every rule is the API's: the page shows the rostering rule's
 * blockers in words, asks for an override's justification naming the blockers it covers, shows
 * the staffing comparison as the organisation's own scale (never a Harbour score) with its status
 * as an icon and a word, and lists each period to acknowledge by name before publishing.
 */

type StaffingComparison = StaffingComparisonItem;
type RosterBlocker = RosterBlockerItem;

export const ROTA_PAGE = "/rota";
export const MY_SHIFTS_PAGE = "/my-shifts";
export const rotaHomePage = (locationId: string) => `${ROTA_PAGE}/locations/${locationId}`;
export const templatesPage = (locationId: string) => `${rotaHomePage(locationId)}/templates`;
export const rotaPage = (id: string) => `${ROTA_PAGE}/${id}`;
export const rotaCheckPage = (id: string) => `${rotaPage(id)}/check`;

export const ROTA_READERS = ["scheduling.rota.read", "scheduling.rota.manage"] as const;

export function rotaShown(permissions: readonly string[]): boolean {
  return ROTA_READERS.some((p) => permissions.includes(p));
}
export function mayManageRota(permissions: readonly string[]): boolean {
  return permissions.includes("scheduling.rota.manage");
}
/** An override of the rostering rule needs scheduling.rota.approve (the API checks it again). */
export function mayOverride(permissions: readonly string[]): boolean {
  return permissions.includes("scheduling.rota.approve");
}
/** The check before publishing is a care-record view: it also needs care.plan.read. */
export function mayCheck(permissions: readonly string[]): boolean {
  return mayManageRota(permissions) && permissions.includes("care.plan.read");
}
export function myShiftsShown(permissions: readonly string[]): boolean {
  return permissions.includes("scheduling.timesheet.self");
}

/** "07:30" from minutes after midnight (24-hour, UK wall clock). */
export function clockTime(minuteOfDay: number): string {
  const m = ((Math.trunc(minuteOfDay) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Minutes after midnight from "07:30" (or "7:30"); null when it is not a 24-hour time. */
export function readClockTime(value: string): number | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** A shift's times: "07:30 to 15:00", "next day" when it ends at or before it starts. */
export function shiftTimes(startMinute: number, endMinute: number, t: Translator): string {
  return t("rota.shift.times", {
    start: clockTime(startMinute),
    end: clockTime(endMinute),
    nextDay: endMinute <= startMinute ? "yes" : "no",
  });
}

/** "7 h 30 min" from minutes, for the comparison's figures. */
export function hoursWords(minutes: number, t: Translator): string {
  const whole = Math.round(minutes);
  return t("rota.figure.hours", { hours: Math.floor(whole / 60), minutes: whole % 60 });
}

/** UK wall-clock "HH:mm" of an instant. */
export function ukClock(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

/** The UK date of an instant (yyyy-mm-dd). */
export function ukDateOf(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date(iso));
}

/** A shift's times from its instants: "20:00 to 08:00 (next day)" when it ends on a later UK day. */
export function instantTimes(startsAt: string, endsAt: string, t: Translator): string {
  return t("rota.shift.times", {
    start: ukClock(startsAt),
    end: ukClock(endsAt),
    nextDay: ukDateOf(endsAt) > ukDateOf(startsAt) ? "yes" : "no",
  });
}

/**
 * Why a blocked member cannot be overridden onto a shift, from the blockers' kinds (HZ-124): a
 * missing right to work is never overridden; a member who is not active cannot work at all.
 */
export function notOverridableReason(
  blockers: readonly Pick<RosterBlocker, "kind">[],
  t: Translator,
): string {
  if (blockers.some((b) => b.kind === "right_to_work")) return t("rota.override.rightToWork");
  if (blockers.some((b) => b.kind === "not_active")) return t("rota.override.notActive");
  return t("rota.override.cannot");
}

/** Shifts grouped by their UK date, in date then start order. */
export function shiftsByDate<S extends Pick<ShiftItem, "date" | "startsAt" | "id">>(
  shifts: readonly S[],
): { readonly date: string; readonly shifts: readonly S[] }[] {
  const byDate = new Map<string, S[]>();
  for (const s of [...shifts].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.startsAt.localeCompare(b.startsAt) ||
      a.id.localeCompare(b.id),
  )) {
    byDate.set(s.date, [...(byDate.get(s.date) ?? []), s]);
  }
  return [...byDate].map(([date, list]) => ({ date, shifts: list }));
}

const COMPARISON_CHIPS: Record<StaffingComparison["status"], Omit<SafetyChip, "label">> = {
  below: { status: "overdue", icon: "triangle-alert" },
  incomplete: { status: "overdue", icon: "circle-alert" },
  no_scale: { status: "overdue", icon: "circle-minus" },
  met_with_warnings: { status: "due", icon: "circle-alert" },
  met: { status: "done", icon: "circle-check" },
};

/**
 * The comparison's status as an icon and the API's own word (HZ-123: never colour alone, and a
 * status the web does not know warns rather than reading as met).
 */
export function comparisonChip(item: Pick<StaffingComparison, "status" | "word">): SafetyChip {
  const known = COMPARISON_CHIPS[item.status as StaffingComparison["status"]];
  return { ...(known ?? { status: "overdue", icon: "circle-alert" }), label: item.word };
}

/** The key the publish must list for a period: `date:periodKey`, or `date` with no period. */
export function periodKey(item: Pick<StaffingComparison, "date" | "periodKey">): string {
  return item.periodKey ? `${item.date}:${item.periodKey}` : item.date;
}

export interface PublishReadiness {
  readonly ready: boolean;
  readonly reasons: readonly ("blocked" | "warnings" | "periods" | "notListed")[];
  /** Exactly the check's periods to acknowledge, once every one is ticked. */
  readonly acknowledgedPeriods: readonly string[];
}

/**
 * Whether the publish may be sent (HZ-123): no assignment blocked without an override, the
 * warnings read when there are any, and every period to acknowledge ticked by name. A period the
 * page cannot show (not in the comparison) keeps publishing closed.
 */
export function publishReadiness(
  check: Pick<
    RotaCheck,
    "blockedAssignmentIds" | "hasWarnings" | "periodsToAcknowledge" | "staffing"
  >,
  ticked: ReadonlySet<string>,
  warningsRead: boolean,
): PublishReadiness {
  const reasons: PublishReadiness["reasons"][number][] = [];
  if (check.blockedAssignmentIds.length > 0) reasons.push("blocked");
  const shown = new Set(check.staffing.map(periodKey));
  if (check.periodsToAcknowledge.some((p) => !shown.has(p))) reasons.push("notListed");
  if (check.periodsToAcknowledge.some((p) => !ticked.has(p))) reasons.push("periods");
  if (check.hasWarnings && !warningsRead) reasons.push("warnings");
  return {
    ready: reasons.length === 0,
    reasons,
    acknowledgedPeriods: [...check.periodsToAcknowledge],
  };
}

/** The blocker keys an override names: exactly those shown (the API refuses changed ones). */
export function overrideKeys(blockers: readonly Pick<RosterBlocker, "key">[]): string[] {
  return blockers.map((b) => b.key);
}

export const JUSTIFICATION_MIN = 10;
export const JUSTIFICATION_MAX = 1000;

/** The override's justification: 10 to 1,000 characters, in the manager's words. */
export function justificationProblem(text: string, t: Translator): string | null {
  const length = text.trim().length;
  if (length < JUSTIFICATION_MIN) return t("rota.override.tooShort", { min: JUSTIFICATION_MIN });
  if (length > JUSTIFICATION_MAX) return t("rota.override.tooLong", { max: JUSTIFICATION_MAX });
  return null;
}

/** Where a rota stands, as an icon and a word. */
export function rotaChip(
  rota: { readonly state: string; readonly changedSincePublished: boolean },
  t: Translator,
): SafetyChip {
  if (rota.state === "published" && rota.changedSincePublished) {
    return { status: "due", icon: "file-pen", label: t("rota.state", { state: "changed" }) };
  }
  if (rota.state === "published") {
    return { status: "done", icon: "send", label: t("rota.state", { state: "published" }) };
  }
  if (rota.state === "draft") {
    return { status: "neutral", icon: "file-pen", label: t("rota.state", { state: "draft" }) };
  }
  return { status: "overdue", icon: "circle-alert", label: t("rota.state", { state: "unknown" }) };
}

/** An open shift or who is on it, as an icon and a word. */
export function shiftChip(shift: Pick<ShiftItem, "assignment">, t: Translator): SafetyChip {
  if (!shift.assignment) {
    return { status: "due", icon: "circle-alert", label: t("rota.shift.open") };
  }
  // Never a green tick: whether the person may still work it is the check's answer (HZ-124).
  if (shift.assignment.overridden.length > 0) {
    return { status: "info", icon: "triangle-alert", label: t("rota.shift.overridden") };
  }
  return { status: "neutral", icon: "circle-check", label: t("rota.shift.filled") };
}

/** The number of days a rota covers, inclusive. */
export function rotaDays(startsOn: string, endsOn: string): number {
  return (
    Math.round(
      (Date.parse(`${endsOn}T12:00:00Z`) - Date.parse(`${startsOn}T12:00:00Z`)) / 86_400_000,
    ) + 1
  );
}
