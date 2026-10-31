import { type RateNation, type RateRow, resolveRate } from "../platform/rates";
import { addWorkingDays, type BankHolidays, isWorkingDay } from "../shared/working-days";
import { changeReportDueOn, type SponsorRates } from "./sponsor";

/**
 * Sponsored workers, staff data protection and LDSS (workforce.md section 12; slice 35; WORK-003,
 * WORK-007, WORK-011). Home Office sponsor duties as Harbour reads the guidance for sponsors, for
 * the DPO and an immigration adviser to confirm (H-524, H-900): every figure comes from the rate
 * table. Nothing here decides a worker's immigration status; it keeps the records and the clocks.
 */

export const SPONSORSHIP_RATE_KEYS = {
  unauthorisedAbsenceWorkingDays: "sponsor.unauthorised_absence_working_days",
  visaExpiryWarningDays: "sponsor.visa_expiry_warning_days",
} as const;

export type SponsorshipRates = {
  readonly [K in keyof typeof SPONSORSHIP_RATE_KEYS]: number;
};

export function resolveSponsorshipRates(
  rows: readonly RateRow[],
  nation: Exclude<RateNation, "uk" | "all">,
  on: string,
  tenantId: string | null,
): SponsorshipRates {
  return {
    unauthorisedAbsenceWorkingDays: resolveRate(
      rows,
      SPONSORSHIP_RATE_KEYS.unauthorisedAbsenceWorkingDays,
      nation,
      on,
      tenantId,
    ).value,
    visaExpiryWarningDays: resolveRate(
      rows,
      SPONSORSHIP_RATE_KEYS.visaExpiryWarningDays,
      nation,
      on,
      tenantId,
    ).value,
  };
}

/** Reportable changes a sponsor records on the sponsor management system. */
export const SPONSOR_REPORT_KINDS = [
  "did_not_start",
  "unauthorised_absence",
  "employment_ended",
  "change_of_job",
  "change_of_salary",
  "change_of_work_location",
  "change_of_hours",
  "other",
] as const;
export type SponsorReportKind = (typeof SPONSOR_REPORT_KINDS)[number];

/** The Appendix D records a sponsor keeps for each sponsored worker (as Harbour reads it, H-900). */
export const APPENDIX_D_ITEMS = [
  "passport_or_travel_document",
  "right_to_work_check",
  "contact_details",
  "certificate_of_sponsorship",
  "recruitment_evidence",
  "english_language_evidence",
  "registration_or_qualification",
  "absence_records",
] as const;
export type AppendixDItem = (typeof APPENDIX_D_ITEMS)[number];

/** Appendix D records not yet held. */
export function appendixDGaps(held: readonly string[]): AppendixDItem[] {
  return APPENDIX_D_ITEMS.filter((item) => !held.includes(item));
}

export interface AbsenceSpell {
  /** ISO dates, both inclusive. */
  readonly from: string;
  readonly to: string;
  readonly authorised: boolean;
}

function nextDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Unauthorised absence for more than `sponsor.unauthorised_absence_working_days` consecutive
 * working days is reportable. Consecutive means unbroken by a working day at work: weekends and
 * bank holidays inside a spell neither count nor break it, an authorised day breaks it. Returns
 * the working day the limit was passed (the change "happens" then) and the report's due date.
 */
export function unauthorisedAbsence(
  spells: readonly AbsenceSpell[],
  holidays: BankHolidays,
  rates: SponsorshipRates & SponsorRates,
):
  | { readonly reportable: false }
  | { readonly reportable: true; readonly happenedOn: string; readonly dueOn: string } {
  const away = new Map<string, boolean>();
  for (const spell of spells) {
    for (let day = spell.from; day <= spell.to; day = nextDay(day)) {
      // An authorised day on the same date wins over an unauthorised one.
      away.set(day, (away.get(day) ?? true) && !spell.authorised);
    }
  }
  const days = [...away.keys()].sort();
  let run = 0;
  let previous: string | null = null;
  for (const day of days) {
    if (!isWorkingDay(day, holidays)) continue;
    const unbroken =
      previous !== null &&
      addWorkingDays(previous, 1, holidays) === day &&
      away.get(previous) === true;
    run = away.get(day) === true ? (unbroken ? run + 1 : 1) : 0;
    previous = day;
    if (run > rates.unauthorisedAbsenceWorkingDays) {
      return { reportable: true, happenedOn: day, dueOn: changeReportDueOn(day, holidays, rates) };
    }
  }
  return { reportable: false };
}

/** Where a visa stands against today (warning window from the rate table). */
export function visaExpiryState(
  expiresOn: string,
  today: string,
  rates: SponsorshipRates,
): "valid" | "due_soon" | "expired" {
  if (expiresOn < today) return "expired";
  const warnFrom = new Date(`${expiresOn}T00:00:00Z`);
  warnFrom.setUTCDate(warnFrom.getUTCDate() - rates.visaExpiryWarningDays);
  return today >= warnFrom.toISOString().slice(0, 10) ? "due_soon" : "valid";
}

// ------------------------------------------------------------------------------------------------
// LDSS claims (Learning and Development Support Scheme)
// ------------------------------------------------------------------------------------------------

export const LDSS_STATUSES = ["planned", "submitted", "paid", "rejected", "withdrawn"] as const;
export type LdssStatus = (typeof LDSS_STATUSES)[number];

const LDSS_NEXT: Record<LdssStatus, readonly LdssStatus[]> = {
  planned: ["submitted", "withdrawn"],
  submitted: ["paid", "rejected", "withdrawn"],
  paid: [],
  rejected: ["submitted"],
  withdrawn: [],
};

export function checkLdssTransition(
  from: LdssStatus,
  to: LdssStatus,
  input: {
    readonly reference: string | null;
    readonly on: string | null;
    readonly reason: string | null;
  },
):
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly problem: "not_allowed" | "reference_required" | "date_required" | "reason_required";
    } {
  if (!LDSS_NEXT[from].includes(to)) return { ok: false, problem: "not_allowed" };
  if (to === "submitted" && !input.reference?.trim())
    return { ok: false, problem: "reference_required" };
  if ((to === "submitted" || to === "paid") && !input.on)
    return { ok: false, problem: "date_required" };
  if ((to === "rejected" || to === "withdrawn") && !input.reason?.trim())
    return { ok: false, problem: "reason_required" };
  return { ok: true };
}

// ------------------------------------------------------------------------------------------------
// Staff data protection: privacy notice and image consent
// ------------------------------------------------------------------------------------------------

/** Whether the member has acknowledged the notice version in force. */
export function privacyNoticeAcknowledged(
  acknowledgedVersions: readonly string[],
  currentVersion: string | null,
): boolean {
  return currentVersion !== null && acknowledgedVersions.includes(currentVersion);
}

/**
 * Optional uses of a member's photo or image (consent is the basis only for these; the
 * identification photo on the shared-device picker rests on employment, B3).
 */
export const IMAGE_PURPOSES = ["newsletter", "website", "social_media", "family_feed"] as const;
export type ImagePurpose = (typeof IMAGE_PURPOSES)[number];

export interface ImageConsentEvent {
  readonly purpose: ImagePurpose;
  readonly decision: "given" | "refused" | "withdrawn";
  readonly at: string;
}

/** The latest decision for a purpose; no decision means no use. */
export function imageConsent(
  events: readonly ImageConsentEvent[],
  purpose: ImagePurpose,
): { readonly decision: "given" | "refused" | "withdrawn" | "none"; readonly mayUse: boolean } {
  const latest = events
    .filter((e) => e.purpose === purpose)
    .sort((a, b) => a.at.localeCompare(b.at))
    .at(-1);
  const decision = latest?.decision ?? "none";
  return { decision, mayUse: decision === "given" };
}
