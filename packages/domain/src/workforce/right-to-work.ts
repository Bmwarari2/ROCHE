import { daysBetween } from "./dates";

/**
 * Right to work (workforce.md rule 2; Immigration, Asylum and Nationality Act 2006 and the Home
 * Office employer's guide). A check before employment starts gives the employer a statutory excuse.
 * An unlimited permission needs no follow-up; a time-limited one needs a follow-up check on or
 * before the day it expires. From the day after expiry, with no follow-up, the worker has no right
 * to work on record, which blocks rostering and cannot be overridden.
 */

export interface RightToWorkCheck {
  readonly checkedOn: string;
  readonly permission: "unlimited" | "time_limited";
  /** The last day of a time-limited permission. */
  readonly expiresOn: string | null;
}

export type RightToWorkStatus =
  | { readonly kind: "none" }
  | { readonly kind: "valid"; readonly followUpDueOn: string | null }
  | { readonly kind: "follow_up_due"; readonly followUpDueOn: string; readonly daysLeft: number }
  | { readonly kind: "lapsed"; readonly lapsedOn: string };

/**
 * The worker's right to work on `today`, from their checks (newest last is not required). The
 * latest check counts; `followUpWindowDays` is how early a follow-up shows as due (the first
 * document-expiry reminder).
 */
export function rightToWorkStatus(
  checks: readonly RightToWorkCheck[],
  today: string,
  followUpWindowDays: number,
): RightToWorkStatus {
  if (checks.length === 0) return { kind: "none" };
  const latest = [...checks].sort((a, b) => (a.checkedOn < b.checkedOn ? -1 : 1)).at(-1);
  if (!latest || latest.checkedOn > today) return { kind: "none" };
  if (latest.permission === "unlimited") return { kind: "valid", followUpDueOn: null };
  if (!latest.expiresOn) {
    // A time-limited permission recorded without its expiry is not evidence of anything.
    return { kind: "none" };
  }
  const daysLeft = daysBetween(today, latest.expiresOn);
  if (daysLeft < 0) return { kind: "lapsed", lapsedOn: latest.expiresOn };
  if (daysLeft <= followUpWindowDays) {
    return { kind: "follow_up_due", followUpDueOn: latest.expiresOn, daysLeft };
  }
  return { kind: "valid", followUpDueOn: latest.expiresOn };
}

/** Whether the right to work allows work on `today` (a follow-up due still allows it). */
export function mayWork(status: RightToWorkStatus): boolean {
  return status.kind === "valid" || status.kind === "follow_up_due";
}

/**
 * The first check was made after employment started: the statutory excuse does not cover the
 * days before it, which the file must say (section 12.1).
 */
export function checkedLate(firstCheckOn: string, startedOn: string): boolean {
  return firstCheckOn > startedOn;
}
