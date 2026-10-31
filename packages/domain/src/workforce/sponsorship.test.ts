import { describe, expect, it } from "vitest";
import {
  type AbsenceSpell,
  appendixDGaps,
  checkLdssTransition,
  imageConsent,
  privacyNoticeAcknowledged,
  resolveSponsorshipRates,
  unauthorisedAbsence,
  visaExpiryState,
} from "./sponsorship";

/**
 * Sponsored workers, LDSS and staff data protection (workforce.md section 12; slice 35; WORK-003,
 * WORK-007, WORK-011). Figures are test inputs standing in for the rate table rows.
 */

const rates = {
  unauthorisedAbsenceWorkingDays: 10,
  visaExpiryWarningDays: 90,
  sponsorSalaryFloorYearly: 25000,
  sponsorSalaryFloorHourly: 12.82,
  sponsorChangeReportWorkingDays: 10,
  sponsorCountedWeeklyHoursMax: 48,
};
// England: Monday 25 and Tuesday 26 December 2028 are bank holidays.
const holidays = new Set(["2028-12-25", "2028-12-26"]);
const away = (from: string, to: string, authorised = false): AbsenceSpell => ({
  from,
  to,
  authorised,
});

describe("WORK-003 unauthorised absence (Home Office guidance for sponsors; H-900)", () => {
  it.each([
    ["10 working days is not yet reportable", [away("2028-11-06", "2028-11-17")], null],
    ["the 11th working day is", [away("2028-11-06", "2028-11-20")], "2028-11-20"],
    [
      "weekends inside a spell neither count nor break it",
      [away("2028-11-06", "2028-11-12"), away("2028-11-13", "2028-11-20")],
      "2028-11-20",
    ],
    [
      "an authorised day breaks the run",
      [away("2028-11-06", "2028-11-20"), away("2028-11-13", "2028-11-13", true)],
      null,
    ],
    ["bank holidays do not count", [away("2028-12-18", "2029-01-05")], "2029-01-03"],
  ] as const)("%s", (_name, spells, happenedOn) => {
    const result = unauthorisedAbsence(spells, holidays, rates);
    if (happenedOn === null) expect(result.reportable).toBe(false);
    else expect(result).toMatchObject({ reportable: true, happenedOn });
  });

  it("is due within the reporting window of working days after it happened", () => {
    const result = unauthorisedAbsence([away("2028-11-06", "2028-11-20")], holidays, rates);
    expect(result).toMatchObject({ reportable: true, dueOn: "2028-12-04" });
  });
});

describe("visa expiry", () => {
  it.each([
    ["2029-06-30", "2029-01-01", "valid"],
    ["2029-03-31", "2029-01-01", "due_soon"],
    ["2029-01-01", "2029-01-01", "due_soon"],
    ["2028-12-31", "2029-01-01", "expired"],
  ] as const)("expiring %s, today %s: %s", (expiresOn, today, state) => {
    expect(visaExpiryState(expiresOn, today, rates)).toBe(state);
  });
});

describe("Appendix D records", () => {
  it("lists what is not yet held", () => {
    expect(appendixDGaps(["passport_or_travel_document", "right_to_work_check"])).toContain(
      "certificate_of_sponsorship",
    );
    expect(appendixDGaps(["passport_or_travel_document"])).not.toContain(
      "passport_or_travel_document",
    );
  });
});

describe("WORK-007 LDSS claims", () => {
  const none = { reference: null, on: null, reason: null };
  it.each([
    [
      "planned to submitted with a reference and date",
      "planned",
      "submitted",
      { reference: "LDSS-1", on: "2029-01-05", reason: null },
      null,
    ],
    [
      "submitted without a reference",
      "planned",
      "submitted",
      { ...none, on: "2029-01-05" },
      "reference_required",
    ],
    ["paid with its date", "submitted", "paid", { ...none, on: "2029-02-01" }, null],
    ["paid without a date", "submitted", "paid", none, "date_required"],
    ["rejected without a reason", "submitted", "rejected", none, "reason_required"],
    [
      "resubmitted after a rejection",
      "rejected",
      "submitted",
      { reference: "LDSS-2", on: "2029-02-10", reason: null },
      null,
    ],
    ["paid straight from planned", "planned", "paid", { ...none, on: "2029-02-01" }, "not_allowed"],
    ["anything after paid", "paid", "withdrawn", { ...none, reason: "x" }, "not_allowed"],
  ] as const)("%s", (_name, from, to, input, problem) => {
    const result = checkLdssTransition(from, to, input);
    if (problem === null) expect(result).toEqual({ ok: true });
    else expect(result).toMatchObject({ ok: false, problem });
  });
});

describe("WORK-011 staff data protection", () => {
  it("needs the notice version in force acknowledged", () => {
    expect(privacyNoticeAcknowledged(["2028-01"], "2029-01")).toBe(false);
    expect(privacyNoticeAcknowledged(["2028-01", "2029-01"], "2029-01")).toBe(true);
    expect(privacyNoticeAcknowledged([], null)).toBe(false);
  });

  it("uses an image only on the latest decision being consent", () => {
    const events = [
      { purpose: "newsletter", decision: "given", at: "2029-01-01T09:00:00Z" },
      { purpose: "newsletter", decision: "withdrawn", at: "2029-02-01T09:00:00Z" },
      { purpose: "website", decision: "given", at: "2029-01-01T09:00:00Z" },
    ] as const;
    expect(imageConsent(events, "newsletter")).toEqual({ decision: "withdrawn", mayUse: false });
    expect(imageConsent(events, "website")).toEqual({ decision: "given", mayUse: true });
    expect(imageConsent(events, "social_media")).toEqual({ decision: "none", mayUse: false });
  });
});

describe("the rate table", () => {
  it("reads both figures, and fails loudly when one is missing", () => {
    const row = (key: string, value: number) => ({
      key,
      value,
      unit: "x",
      nation: "uk",
      validFrom: "2025-01-01",
      validTo: null,
      tenantId: null,
      verificationStatus: "to-verify",
      source: "test",
    });
    const rows = [
      row("sponsor.unauthorised_absence_working_days", 10),
      row("sponsor.visa_expiry_warning_days", 90),
    ];
    expect(resolveSponsorshipRates(rows as never, "england", "2029-01-01", null)).toEqual({
      unauthorisedAbsenceWorkingDays: 10,
      visaExpiryWarningDays: 90,
    });
    expect(() =>
      resolveSponsorshipRates(rows.slice(0, 1) as never, "england", "2029-01-01", null),
    ).toThrow();
  });
});
