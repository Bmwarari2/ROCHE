import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import {
  type CertificateRecord,
  certificateStatus,
  type DsptSubmission,
  dsptDeadline,
  dsptStatus,
} from "./quality-data-security";
import { addDays, addMonths } from "./quality-dates";
import { resolveQualityPhase2Rates } from "./quality-rates";

const rates = resolveQualityPhase2Rates(readRateTable(), "england", "2026-10-31", null);
const pad = (n: number) => String(n).padStart(2, "0");
/** The deadline in a year, from the rate table (30 June). */
const deadlineIn = (year: number) =>
  `${year}-${pad(rates.dsptDeadlineMonth)}-${pad(rates.dsptDeadlineDay)}`;

describe("data security evidence (quality.md 17.3 rules 29 to 31; QUAL-012)", () => {
  it.each<[string, string, string, string]>([
    ["before this year's deadline", "2026-03-01", deadlineIn(2026), "2025/26"],
    ["on the deadline", deadlineIn(2026), deadlineIn(2026), "2025/26"],
    ["after it", addDays(deadlineIn(2026), 1), deadlineIn(2027), "2026/27"],
  ])("rule 29 gives the next deadline %s from the rate table", (_, on, deadline, year) => {
    expect(dsptDeadline(on, rates)).toEqual({ deadline, financialYear: year });
  });

  it("rule 29 refuses a date that is not one", () => {
    expect(() => dsptDeadline("June", rates)).toThrow(RangeError);
  });

  const submitted = (
    financialYear: string,
    outcome: DsptSubmission["outcome"] = "standards_met",
  ): DsptSubmission => ({
    financialYear,
    submittedOn: "2026-05-01",
    outcome,
  });

  it.each<[string, string, DsptSubmission[], string, boolean]>([
    ["well before the deadline", "2026-01-15", [submitted("2024/25")], "due", false],
    [
      "within the reminder window",
      addDays(deadlineIn(2026), -rates.renewalReminderDays),
      [submitted("2024/25")],
      "due_soon",
      false,
    ],
    [
      "submitted for the year",
      "2026-06-01",
      [submitted("2024/25"), submitted("2025/26")],
      "submitted",
      false,
    ],
    [
      "submitted with standards not met",
      "2026-06-01",
      [submitted("2024/25"), submitted("2025/26", "standards_not_met")],
      "submitted",
      true,
    ],
    ["past the deadline without a submission", addDays(deadlineIn(2026), 1), [], "overdue", false],
    [
      "past the deadline, last year's submitted",
      addDays(deadlineIn(2026), 1),
      [submitted("2025/26")],
      "due",
      false,
    ],
  ])("rule 30 says the DSPT is %s", (_, on, submissions, status, flagged) => {
    const result = dsptStatus(submissions, on, rates);
    expect(result.status).toBe(status);
    expect(result.flagged).toBe(flagged);
  });

  const record = (
    kind: CertificateRecord["kind"],
    issuedOn: string,
    expiresOn: string | null = null,
  ): CertificateRecord => ({
    kind,
    reference: "REF-0001",
    issuedOn,
    expiresOn,
  });

  it("rule 31 says missing, never current, when there is no record", () => {
    expect(certificateStatus([], "cyber_essentials", "2026-10-31", rates)).toEqual({
      status: "missing",
      expiresOn: null,
    });
  });

  it.each<[string, CertificateRecord[], string, string, string]>([
    [
      "Cyber Essentials in date",
      [record("cyber_essentials", "2026-03-01")],
      "2026-10-31",
      "current",
      addMonths("2026-03-01", rates.cyberEssentialsValidMonths),
    ],
    [
      "Cyber Essentials within the reminder window",
      [record("cyber_essentials", "2026-01-01")],
      addDays(addMonths("2026-01-01", rates.cyberEssentialsValidMonths), -1),
      "due_soon",
      addMonths("2026-01-01", rates.cyberEssentialsValidMonths),
    ],
    [
      "Cyber Essentials past expiry",
      [record("cyber_essentials", "2025-01-01")],
      "2026-10-31",
      "expired",
      addMonths("2025-01-01", rates.cyberEssentialsValidMonths),
    ],
    [
      "the certificate's own expiry wins",
      [record("cyber_essentials_plus", "2026-03-01", "2026-12-01")],
      "2026-10-31",
      "due_soon",
      "2026-12-01",
    ],
    [
      "the newest record counts",
      [record("ico_registration", "2025-01-01"), record("ico_registration", "2026-02-01")],
      "2026-10-31",
      "current",
      addMonths("2026-02-01", rates.icoRenewalMonths),
    ],
  ])("rule 31: %s", (_, records, on, status, expiresOn) => {
    const kind = records[0]?.kind ?? "cyber_essentials";
    expect(certificateStatus(records, kind, on, rates)).toEqual({ status, expiresOn });
  });
});
