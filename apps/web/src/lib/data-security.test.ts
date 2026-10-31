import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  assertionChip,
  dataSecurityShown,
  dsptChip,
  isFinancialYear,
  metWithoutEvidence,
  readAssertion,
  readAssertionStatus,
  readCertificate,
  readSubmission,
  renewalChip,
} from "./data-security";

const t = createTranslator("en-GB");

const form = (entries: Record<string, string>) => ({
  get: (name: string) => entries[name] ?? null,
  getAll: (name: string) => (entries[name] === undefined ? [] : [entries[name] as string]),
});
const date = (name: string, d: string, m: string, y: string) => ({
  [`${name}-day`]: d,
  [`${name}-month`]: m,
  [`${name}-year`]: y,
});

describe("statuses in words with an icon", () => {
  it("never shows a missing certificate as current", () => {
    expect(renewalChip("missing", t)).toMatchObject({
      status: "overdue",
      label: "Missing: no record",
    });
    expect(renewalChip("current", t)).toMatchObject({ status: "done", label: "Current" });
    expect(renewalChip("expired", t).label).toBe("Expired");
  });

  it("says the DSPT deadline in words", () => {
    expect(dsptChip("overdue", "30/06/2026", t).label).toBe("Overdue: was due 30/06/2026");
    expect(dsptChip("submitted", "30/06/2026", t).label).toBe("Submitted");
  });

  it("says each assertion status, and met without evidence apart", () => {
    expect(assertionChip("not_applicable", t)).toMatchObject({ status: "notApplicable" });
    expect(metWithoutEvidence({ status: "met", evidence: [] })).toBe(true);
    expect(metWithoutEvidence({ status: "met", evidence: [{}] })).toBe(false);
    expect(metWithoutEvidence({ status: "in_progress", evidence: [] })).toBe(false);
  });

  it("is for those who manage data protection", () => {
    expect(dataSecurityShown(["quality.dsar.manage"])).toBe(true);
    expect(dataSecurityShown(["quality.audit.manage"])).toBe(false);
    expect(isFinancialYear("2026/27")).toBe(true);
    expect(isFinancialYear("2026-27")).toBe(false);
  });
});

describe("reading the forms", () => {
  it("reads an assertion with the toolkit's numbering", () => {
    expect(
      readAssertion(
        form({ assertionRef: "1.1.1", title: "Data protection lead named" }),
        "2026/27",
        t,
      ),
    ).toEqual({
      ok: true,
      body: {
        financialYear: "2026/27",
        assertionRef: "1.1.1",
        title: "Data protection lead named",
      },
    });
    expect(readAssertion(form({ assertionRef: "one", title: "x" }), "2026/27", t).ok).toBe(false);
  });

  it.each([
    ["met", "", true],
    ["not_met", "", false],
    ["not_applicable", "We hold no paper records", true],
    ["made_up", "", false],
  ])("a %s status with notes %j", (status, notes, ok) => {
    expect(readAssertionStatus(form({ status, notes }), t).ok).toBe(ok);
  });

  it("reads a submission and refuses a missing outcome", () => {
    expect(
      readSubmission(
        form({ ...date("submittedOn", "20", "6", "2026"), outcome: "standards_met" }),
        t,
      ),
    ).toEqual({
      ok: true,
      body: { submittedOn: "2026-06-20", outcome: "standards_met", reference: null },
    });
    expect(readSubmission(form(date("submittedOn", "20", "6", "2026")), t).ok).toBe(false);
  });

  it("reads a certificate, the expiry optional but after issue", () => {
    const base = {
      kind: "cyber_essentials",
      reference: "CE-123",
      ...date("issuedOn", "1", "4", "2026"),
    };
    expect(readCertificate(form(base), [], t)).toMatchObject({
      ok: true,
      body: { kind: "cyber_essentials", issuedOn: "2026-04-01", expiresOn: null, documentId: null },
    });
    const early = readCertificate(form({ ...base, ...date("expiresOn", "1", "3", "2026") }), [], t);
    expect(early.ok).toBe(false);
    if (!early.ok)
      expect(early.errors.expiresOn).toBe("The expiry date must be after the date issued");
  });
});
