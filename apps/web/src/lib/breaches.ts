import type { paths } from "@harbour/contracts/client";
import type { Translator } from "@harbour/i18n";
import type { StatusChipStatus } from "@harbour/ui";
import { BREACHES_PAGE } from "./data-rights";
import { formatDate, formatDateTime } from "./format";
import { formatUkTime, ukToday } from "./uk-time";

/**
 * The breach register's screens (PLAT-022; platform.md rules 18 to 24; breach-response.md). Pure,
 * unit tested. The ICO clock is the API's, worked out from the rate table each time it is read:
 * the screen says it in words and never works out a deadline itself. Harbour's assessment is
 * decision support only; the decision is the person's.
 */

type BreachResponse =
  paths["/v1/data-protection/breaches/{id}"]["get"]["responses"][200]["content"]["application/json"];
export type Breach = BreachResponse;
export type BreachList =
  paths["/v1/data-protection/breaches"]["get"]["responses"][200]["content"]["application/json"];
export type BreachSuggestion = NonNullable<Breach["suggestion"]>;
export type BreachFactors = NonNullable<Breach["factors"]>;

export const breachPath = (id: string) => `${BREACHES_PAGE}/${id}`;

/** What a status chip shows: an icon (from the status) and a word, never colour alone. */
export interface Chip {
  readonly status: StatusChipStatus;
  readonly label: string;
  /** Done, but after the deadline: drawn with an alert icon, the same in every register. */
  readonly late?: boolean;
}

/** "14:00" and "02/11/2026" for an instant, both in UK time. */
function ukTimeAndDate(iso: string): { readonly time: string; readonly date: string } {
  return {
    time: formatUkTime(iso) ?? "",
    date: formatDate(ukToday(new Date(iso))) ?? "",
  };
}

/** Whether the organisation has decided the breach is not one to report to the ICO. */
export const decidedNotToReport = (b: Pick<Breach, "decision" | "report">): boolean =>
  b.decision !== null && !b.decision.reportToIco && b.report === null;

/**
 * The ICO clock in words, with its chip: when to report by and the hours left, overdue since the
 * deadline, reported on time or late, or no report needed once the decision is not to report.
 * The hours and the deadline are the API's (`ico.breach.report_hours`), never a figure here.
 */
export function breachClockWords(
  b: Pick<Breach, "clock" | "decision" | "report">,
  t: Translator,
): Chip & { readonly words: string } {
  const { time, date } = ukTimeAndDate(b.clock.deadline);
  if (decidedNotToReport(b)) {
    const label = t("dataRights.breach.clock.chip", { state: "not_needed" });
    return { status: "notApplicable", label, words: t("dataRights.breach.clock.notNeeded") };
  }
  switch (b.clock.state) {
    case "open":
      return {
        status: "due",
        label: t("dataRights.breach.clock.chip", { state: "open" }),
        words: t("dataRights.breach.clock.open", {
          time,
          date,
          hours: b.clock.hoursLeft ?? 0,
        }),
      };
    case "overdue":
      return {
        status: "overdue",
        label: t("dataRights.breach.clock.chip", { state: "overdue" }),
        words: t("dataRights.breach.clock.overdue", { time, date }),
      };
    case "reported_on_time":
      return {
        status: "done",
        label: t("dataRights.breach.clock.chip", { state: "reported_on_time" }),
        words: t("dataRights.breach.clock.reportedOnTime", {
          at: formatDateTime(b.report?.reportedAt) ?? "",
        }),
      };
    case "reported_late":
      return {
        status: "done",
        late: true,
        label: t("dataRights.breach.clock.chip", { state: "reported_late" }),
        words: t("dataRights.breach.clock.reportedLate", {
          at: formatDateTime(b.report?.reportedAt) ?? "",
          time,
          date,
        }),
      };
    default:
      // A state this screen does not know yet: said as needing a check, never as done.
      return {
        status: "overdue",
        label: t("dataRights.breach.clock.chip", { state: "unknown" }),
        words: t("dataRights.breach.clock.unknown"),
      };
  }
}

export type BreachStage = "assess" | "decide" | "report" | "tell" | "close" | "closed";

/** Where an open entry stands in the procedure: the next thing to record. */
export function breachStage(b: Breach): BreachStage {
  if (b.status === "closed") return "closed";
  if (!b.factors) return "assess";
  if (!b.decision) return "decide";
  if (b.decision.reportToIco && !b.report) return "report";
  if (b.decision.tellIndividuals && !b.individuals) return "tell";
  return "close";
}

/** The entry's state as an icon and a word: closed, or what is to be recorded next. */
export function breachChip(b: Breach, t: Translator): Chip {
  const stage = breachStage(b);
  return {
    status: stage === "closed" ? "done" : "info",
    label: t("dataRights.breach.stage", { stage }),
  };
}

/** The forms the detail page offers, each only while it applies; the API checks every rule again. */
export interface BreachForms {
  readonly assess: boolean;
  readonly decide: boolean;
  readonly report: boolean;
  readonly tell: boolean;
  readonly close: boolean;
}

export function breachForms(b: Breach): BreachForms {
  const open = b.status === "open";
  return {
    // Reassessing after a decision is refused (rule 20).
    assess: open && b.decision === null,
    // A decision, or a change of mind, until anything has been done on it.
    decide: open && b.factors !== null && b.report === null && b.individuals === null,
    report: open && b.decision?.reportToIco === true && b.report === null,
    tell: open && b.decision?.tellIndividuals === true && b.individuals === null,
    close:
      open &&
      b.decision !== null &&
      (!b.decision.reportToIco || b.report !== null) &&
      (!b.decision.tellIndividuals || b.individuals !== null),
  };
}

/**
 * Whether a decision goes against Harbour's suggestion, as the API checks it (checkBreachDecision):
 * not reporting when it suggests considering a report, or not telling the people affected when it
 * suggests considering that. Doing more than it suggests is never against it.
 */
export function againstSuggestion(
  suggestion: Pick<BreachSuggestion, "considerReportingToIco" | "considerTellingIndividuals">,
  choice: { readonly reportToIco: boolean; readonly tellIndividuals: boolean },
): boolean {
  return (
    (!choice.reportToIco && suggestion.considerReportingToIco) ||
    (!choice.tellIndividuals && suggestion.considerTellingIndividuals)
  );
}

/** Harbour's suggestion in words: the severity, what to consider, and why, as decision support. */
export function suggestionWords(
  s: BreachSuggestion,
  t: Translator,
): {
  readonly headline: string;
  readonly reasons: readonly string[];
} {
  return {
    headline: t("dataRights.breach.suggestion.headline", {
      severity: s.severity,
      report: s.considerReportingToIco ? "yes" : "no",
      tell: s.considerTellingIndividuals ? "yes" : "no",
    }),
    reasons: s.reasons.map((reason) => t("dataRights.breach.reason", { reason })),
  };
}

/** Whether a report time is after the API's deadline, so the reasons for the delay are needed. */
export function reportIsLate(deadline: string, reportedAt: string): boolean {
  return new Date(reportedAt).getTime() > new Date(deadline).getTime();
}

/** The factors form's fields, in the order of breach-response.md section 4. */
export const FACTOR_FLAGS = [
  "identifiable",
  "specialCategory",
  "safeguardingOrLocationAtRisk",
  "disclosedOutsideOrganisation",
  "careRecordsUnavailable",
  "contained",
] as const satisfies readonly (keyof BreachFactors)[];

/** The most people the API takes as affected. */
export const PEOPLE_AFFECTED_MAX = 10_000_000;

/** The number of people affected, as typed: a whole number of zero or more, or null. */
export function readPeopleAffected(value: string): number | null {
  const trimmed = value.trim().replaceAll(",", "");
  if (!/^\d{1,8}$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n <= PEOPLE_AFFECTED_MAX ? n : null;
}

/** A Thapsus notice's approximate numbers in words ("About 12 people, about 40 records"). */
export function noticeNumbers(
  n: { readonly approxPeople: number | null; readonly approxRecords: number | null },
  t: Translator,
): string | null {
  const parts: string[] = [];
  if (n.approxPeople !== null) {
    parts.push(t("dataRights.breach.notice.people", { count: n.approxPeople }));
  }
  if (n.approxRecords !== null) {
    parts.push(t("dataRights.breach.notice.records", { count: n.approxRecords }));
  }
  return parts.length > 0 ? parts.join(", ") : null;
}
