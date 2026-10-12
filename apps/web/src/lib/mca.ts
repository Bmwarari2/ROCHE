import type { ConsentDecisionStatus, DolsItem } from "@harbour/contracts";
import type { Translator } from "@harbour/i18n";
import { formatDateTime } from "./format";

/**
 * View logic for the consent, capacity and DoLS tab (docs/specs/care.md rules 9 to 11; register
 * rows CARE-021 and CARE-022; hazards HZ-020 and HZ-026). Pure and unit tested. Every status, end
 * and day count is the API's (`consentStatus`, `dolsStatus`): the web only says them in words with
 * an icon, and a status it does not know is shown as a warning, never as calm.
 */

export type McaIcon =
  | "circle-check"
  | "circle-help"
  | "circle-alert"
  | "circle-minus"
  | "ban"
  | "clock";

export interface McaChip {
  readonly status: "overdue" | "due" | "done" | "notApplicable" | "notRecorded" | "info";
  readonly icon: McaIcon;
  readonly label: string;
}

const when = (iso: string | null | undefined, t: Translator) =>
  formatDateTime(iso) ?? t("common.notRecorded");

/**
 * Whether a valid consent exists for one decision now, as `consentStatus` found it. Nothing
 * recorded asks for a record; a record that is not valid (withdrawn, expired, without authority)
 * is the stronger warning, because care may be going ahead on it (HZ-026).
 */
export function consentChip(
  decision: Pick<ConsentDecisionStatus, "status" | "problems">,
  t: Translator,
): McaChip {
  const label = (status: string) => t("care.mca.consent.status", { status });
  if (decision.status === "valid")
    return { status: "done", icon: "circle-check", label: label("valid") };
  if (decision.status === "refused")
    return { status: "info", icon: "ban", label: label("refused") };
  const nothing = decision.problems.length === 1 && decision.problems[0] === "no_record";
  return nothing
    ? { status: "notRecorded", icon: "circle-help", label: label("none") }
    : { status: "overdue", icon: "circle-alert", label: label("invalid") };
}

// ------------------------------------------------------------------------------------------------
// DoLS register (HZ-020)
// ------------------------------------------------------------------------------------------------

const DOLS_CHIPS: Record<DolsItem["status"], Omit<McaChip, "label">> = {
  requested: { status: "due", icon: "clock" },
  not_granted: { status: "notApplicable", icon: "circle-minus" },
  withdrawn: { status: "notApplicable", icon: "circle-minus" },
  not_started: { status: "info", icon: "clock" },
  active: { status: "done", icon: "circle-check" },
  expiring: { status: "due", icon: "clock" },
  expired: { status: "overdue", icon: "circle-alert" },
  ended: { status: "notApplicable", icon: "circle-minus" },
};

/** Where an authorisation stands, as `dolsStatus` found it; one the web does not know warns. */
export function dolsChip(status: string, t: Translator): McaChip {
  const known = DOLS_CHIPS[status as DolsItem["status"]];
  return known
    ? { ...known, label: t("care.mca.dols.status", { status }) }
    : { status: "overdue", icon: "circle-alert", label: t("care.mca.dols.status", { status }) };
}

const GRANTED = new Set(["not_started", "active", "expiring", "expired", "ended"]);

/**
 * The authorisation's clock in words and dates: when it starts or started, when it ends or ended
 * (the API's `endsAt`, the first moment it is no longer in force, so a shortened or extended end
 * shows as it is), and the whole UK days left while it is in force.
 */
export function dolsClock(
  item: Pick<DolsItem, "status" | "grantedFrom" | "endsAt" | "daysLeft">,
  t: Translator,
): string[] {
  if (!GRANTED.has(item.status)) return [];
  const lines: string[] = [];
  if (item.grantedFrom) {
    lines.push(
      t("care.mca.dols.from", { status: item.status, dateTime: when(item.grantedFrom, t) }),
    );
  }
  if (!item.endsAt) {
    lines.push(t("care.mca.dols.noEnd"));
    return lines;
  }
  lines.push(t("care.mca.dols.ends", { status: item.status, dateTime: when(item.endsAt, t) }));
  const running = item.status === "active" || item.status === "expiring";
  if (running && item.daysLeft !== null) {
    lines.push(t("care.mca.dols.daysLeft", { days: item.daysLeft }));
  }
  return lines;
}

/**
 * When the Registered Manager is reminded of the end, while the authorisation is still to end. The
 * date only: a reminder that would fall before an urgent authorisation starts is due at its start.
 */
export function dolsReminders(
  item: Pick<DolsItem, "status" | "reminders">,
  t: Translator,
): string[] {
  if (!["not_started", "active", "expiring"].includes(item.status)) return [];
  return item.reminders.map((reminder) =>
    t("care.mca.dols.reminder", { dateTime: when(reminder.dueAt, t) }),
  );
}

/** The CQC regulation 18(4A) notification for the outcome, or why none is needed (the API's words). */
export function dolsCqcLine(item: Pick<DolsItem, "cqcNotification">, t: Translator): string {
  const cqc = item.cqcNotification;
  const state = cqc.status ?? (cqc.required ? "missing" : null);
  if (state === null) return cqc.reason;
  return t("care.mca.dols.cqc", { state, due: when(cqc.dueAt, t) });
}
