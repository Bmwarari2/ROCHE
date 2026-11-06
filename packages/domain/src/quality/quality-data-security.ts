/**
 * Data security evidence (quality.md section 17, rules 29 to 31; QUAL-012; DSPT, UK GDPR): the DSPT
 * submission deadline from the rate table (the 30 June deadline), where this year's submission
 * stands, and Cyber Essentials and ICO registration renewals. Nothing is assumed current without a
 * record. Pure functions.
 */

import { addDays, addMonths, isIsoDate } from "./quality-dates";
import type { QualityPhase2Rates } from "./quality-rates";

type DsptRates = Pick<
  QualityPhase2Rates,
  "dsptDeadlineMonth" | "dsptDeadlineDay" | "renewalReminderDays"
>;

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Rule 29: the next DSPT deadline on or after a UK date, and the financial year it closes (the
 * year that ended on 31 March before it, written "2025/26").
 */
export function dsptDeadline(
  on: string,
  rates: Pick<QualityPhase2Rates, "dsptDeadlineMonth" | "dsptDeadlineDay">,
): { readonly deadline: string; readonly financialYear: string } {
  if (!isIsoDate(on)) throw new RangeError(`Not a date: ${on}`);
  const year = Number(on.slice(0, 4));
  const inYear = `${year}-${pad(rates.dsptDeadlineMonth)}-${pad(rates.dsptDeadlineDay)}`;
  if (!isIsoDate(inYear)) throw new RangeError("The DSPT deadline in the rate table is not a date");
  const deadline = on <= inYear ? inYear : `${year + 1}${inYear.slice(4)}`;
  const closes = Number(deadline.slice(0, 4));
  return { deadline, financialYear: `${closes - 1}/${String(closes).slice(2)}` };
}

/** The toolkit's published outcomes; earlier years published "standards exceeded" (H-917). */
export type DsptOutcome =
  | "standards_exceeded"
  | "standards_met"
  | "approaching_standards"
  | "standards_not_met";

export interface DsptSubmission {
  readonly financialYear: string;
  readonly submittedOn: string;
  readonly outcome: DsptOutcome;
}

export type DsptStatus = "submitted" | "due" | "due_soon" | "overdue";

/**
 * Rule 30: where the current DSPT year stands on a UK date. Before the deadline it is due (due soon
 * within the reminder window); after it, overdue until submitted. A submission whose outcome is
 * "standards not met" is submitted but flagged.
 */
export function dsptStatus(
  submissions: readonly DsptSubmission[],
  on: string,
  rates: DsptRates,
): {
  readonly status: DsptStatus;
  readonly deadline: string;
  readonly financialYear: string;
  readonly flagged: boolean;
} {
  // The year in question is the one whose deadline is next, unless the last one passed unsubmitted.
  const next = dsptDeadline(on, rates);
  const lastDeadline = `${Number(next.deadline.slice(0, 4)) - 1}${next.deadline.slice(4)}`;
  const last = dsptDeadline(lastDeadline, rates);
  const find = (year: string) => submissions.find((s) => s.financialYear === year);
  const lastSubmission = find(last.financialYear);
  if (on > last.deadline && lastSubmission === undefined && on < next.deadline) {
    return { status: "overdue", ...last, flagged: false };
  }
  const submission = find(next.financialYear);
  if (submission) {
    return { status: "submitted", ...next, flagged: submission.outcome === "standards_not_met" };
  }
  const soon = on >= addDays(next.deadline, -rates.renewalReminderDays);
  return { status: soon ? "due_soon" : "due", ...next, flagged: false };
}

export type CertificateKind = "cyber_essentials" | "cyber_essentials_plus" | "ico_registration";

export interface CertificateRecord {
  readonly kind: CertificateKind;
  readonly reference: string;
  readonly issuedOn: string;
  /** The expiry the certificate itself states, when it does. */
  readonly expiresOn: string | null;
}

export type RenewalStatus = "current" | "due_soon" | "expired" | "missing";

/**
 * Rule 31: whether a certificate or registration is in date on a UK date. Its own stated expiry
 * wins; otherwise Cyber Essentials (and Plus) last `cyber_essentials.certificate_valid_months` and
 * the ICO registration `ico.registration.renewal_months` from issue. The newest record of the kind
 * counts; none is `missing`, never assumed current.
 */
export function certificateStatus(
  records: readonly CertificateRecord[],
  kind: CertificateKind,
  on: string,
  rates: Pick<
    QualityPhase2Rates,
    "cyberEssentialsValidMonths" | "icoRenewalMonths" | "renewalReminderDays"
  >,
): { readonly status: RenewalStatus; readonly expiresOn: string | null } {
  const newest = records
    .filter((r) => r.kind === kind)
    .sort((a, b) => b.issuedOn.localeCompare(a.issuedOn))[0];
  if (!newest) return { status: "missing", expiresOn: null };
  const months =
    kind === "ico_registration" ? rates.icoRenewalMonths : rates.cyberEssentialsValidMonths;
  const expiresOn = newest.expiresOn ?? addMonths(newest.issuedOn, months);
  if (on >= expiresOn) return { status: "expired", expiresOn };
  if (on >= addDays(expiresOn, -rates.renewalReminderDays))
    return { status: "due_soon", expiresOn };
  return { status: "current", expiresOn };
}
