import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import { addMonths } from "./dates";
import { type DbsRecord, dbsClearance, updateServiceCheckDue } from "./dbs";
import { resolveWorkforceRates } from "./rates";

const months = resolveWorkforceRates(
  readRateTable(),
  "england",
  "2026-10-31",
  null,
).dbsUpdateServiceCheckMonths;
const TODAY = "2026-10-31";
const clearCert = {
  level: "enhanced_adults_barred" as const,
  issuedOn: "2026-01-15",
  result: "clear" as const,
};
const none: DbsRecord = { certificate: null, updateService: null, preClearance: null };

describe("DBS clearance (workforce.md rule 3)", () => {
  it.each<[string, DbsRecord, string]>([
    ["no certificate", none, "not_clear"],
    [
      "an enhanced certificate with the adults' barred list",
      { ...none, certificate: clearCert },
      "clear",
    ],
    [
      "a standard certificate",
      { ...none, certificate: { ...clearCert, level: "standard" } },
      "not_clear",
    ],
    [
      "a disclosure not yet assessed",
      { ...none, certificate: { ...clearCert, result: "information_disclosed" } },
      "not_clear",
    ],
    [
      "a disclosure assessed and accepted",
      {
        ...none,
        certificate: { ...clearCert, result: "information_disclosed", disclosureAccepted: true },
      },
      "clear",
    ],
    [
      "a barred list check and a signed risk assessment only",
      {
        ...none,
        preClearance: { barredListClearOn: "2026-10-20", riskAssessmentSignedOn: "2026-10-21" },
      },
      "supervised_only",
    ],
    [
      "a barred list check without the risk assessment",
      { ...none, preClearance: { barredListClearOn: "2026-10-20", riskAssessmentSignedOn: null } },
      "not_clear",
    ],
    [
      "an Update Service check with new information",
      {
        ...none,
        certificate: clearCert,
        updateService: {
          subscribed: true,
          lastCheckedOn: "2026-06-01",
          lastResult: "new_information",
        },
      },
      "not_clear",
    ],
  ])("%s gives %s", (_, record, kind) => {
    expect(dbsClearance(record, TODAY, months).kind).toBe(kind);
  });

  it("dates the next Update Service check from the last one, or the certificate", () => {
    const subscribed: DbsRecord = {
      ...none,
      certificate: clearCert,
      updateService: { subscribed: true, lastCheckedOn: null, lastResult: null },
    };
    const first = dbsClearance(subscribed, TODAY, months);
    expect(first).toEqual({
      kind: "clear",
      updateServiceCheckDueOn: addMonths(clearCert.issuedOn, months),
    });
    const checked = dbsClearance(
      {
        ...subscribed,
        updateService: {
          subscribed: true,
          lastCheckedOn: "2026-09-01",
          lastResult: "no_new_information",
        },
      },
      TODAY,
      months,
    );
    expect(checked).toEqual({
      kind: "clear",
      updateServiceCheckDueOn: addMonths("2026-09-01", months),
    });
    expect(updateServiceCheckDue(checked, addMonths("2026-09-01", months))).toBe(true);
    expect(updateServiceCheckDue(checked, "2026-09-02")).toBe(false);
  });

  it("asks for no Update Service check for an unsubscribed certificate", () => {
    const result = dbsClearance({ ...none, certificate: clearCert }, TODAY, months);
    expect(result).toEqual({ kind: "clear", updateServiceCheckDueOn: null });
    expect(updateServiceCheckDue(result, "2030-01-01")).toBe(false);
  });

  it("ignores a certificate dated after today", () => {
    expect(
      dbsClearance(
        { ...none, certificate: { ...clearCert, issuedOn: "2026-11-01" } },
        TODAY,
        months,
      ).kind,
    ).toBe("not_clear");
  });
});
