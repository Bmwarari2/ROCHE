import { describe, expect, it } from "vitest";
import { t } from "./i18n";
import {
  absenceChip,
  absencesShown,
  coverChip,
  exceptionChip,
  hoursAndMinutes,
  myTimeShown,
  PAY_APPROVE,
  PAY_MANAGE,
  payRunChip,
  payShown,
  pounds,
  ROTA_APPROVE,
  ROTA_MANAGE,
  readDecision,
  readLeaveRequest,
  readOverride,
  readPayRun,
  readRuleSet,
  ruleSetChip,
  SELF,
  timesheetChip,
  timesheetsShown,
} from "./pay-time";

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const date = (name: string, d: string, m: string, y: string) => ({
  [`${name}-day`]: d,
  [`${name}-month`]: m,
  [`${name}-year`]: y,
});
const LOCATION = "0194d000-0000-7000-8000-00000000c001";

describe("pay and time gates", () => {
  it.each([
    [[SELF], { mine: true, sheets: false, absences: true, pay: false }],
    [[ROTA_MANAGE], { mine: false, sheets: true, absences: true, pay: false }],
    [[ROTA_APPROVE], { mine: false, sheets: true, absences: true, pay: false }],
    [[PAY_MANAGE], { mine: false, sheets: false, absences: false, pay: true }],
    [[PAY_APPROVE], { mine: false, sheets: false, absences: false, pay: true }],
    [[], { mine: false, sheets: false, absences: false, pay: false }],
  ])("shows screens for %j", (perms, want) => {
    expect({
      mine: myTimeShown(perms),
      sheets: timesheetsShown(perms),
      absences: absencesShown(perms),
      pay: payShown(perms),
    }).toEqual(want);
  });
});

describe("status chips say it in words with an icon", () => {
  it.each([
    [{ status: "draft", superseded: false }, "Waiting for approval", "file-pen"],
    [{ status: "approved", superseded: false }, "Approved", "circle-check"],
    [{ status: "approved", superseded: true }, "Corrected", "circle-minus"],
    [{ status: "odd", superseded: false }, "Not known", "triangle-alert"],
  ])("timesheet %j", (entry, label, icon) => {
    expect(timesheetChip(entry, t)).toMatchObject({ label, icon });
  });

  it.each([
    ["requested", "Waiting for a decision"],
    ["approved", "Approved"],
    ["declined", "Declined"],
    ["cancelled", "Cancelled"],
    ["recorded", "Recorded"],
    ["strange", "Not known"],
  ])("absence %s", (state, label) => {
    const c = absenceChip(state, t);
    expect(c.label).toBe(label);
    expect(c.icon).toBeTruthy();
  });

  it("hazard HZ-123 says how many shifts an absence leaves needing cover, and nothing at none", () => {
    expect(coverChip(0, t)).toBeNull();
    expect(coverChip(1, t)).toMatchObject({ label: "1 shift needs cover", icon: "triangle-alert" });
    expect(coverChip(3, t)?.label).toBe("3 shifts need cover");
  });

  it.each([
    [{ status: "locked", openExceptions: 0, calculation: 2 }, "Locked"],
    [{ status: "draft", openExceptions: 0, calculation: 0 }, "Not calculated"],
    [{ status: "draft", openExceptions: 2, calculation: 1 }, "2 open exceptions"],
    [{ status: "draft", openExceptions: 0, calculation: 1 }, "Ready to check and lock"],
  ])("pay run %j", (run, label) => {
    expect(payRunChip(run, t).label).toBe(label);
  });

  it("exceptions and rule sets", () => {
    expect(exceptionChip("open", t).label).toBe("Open");
    expect(exceptionChip("overridden", t).label).toBe("Overridden");
    expect(ruleSetChip("approved", t).label).toBe("Approved");
    expect(ruleSetChip("draft", t).label).toBe("Draft, waiting for approval");
  });
});

describe("money and time", () => {
  it.each([
    [0, "£0.00"],
    [5, "£0.05"],
    [123456, "£1,234.56"],
    [-250, "-£2.50"],
    [null, ""],
  ])("pounds(%s)", (pence, want) => {
    expect(pounds(pence)).toBe(want);
  });

  it("hours and minutes", () => {
    expect(hoursAndMinutes(450, t)).toBe("7 h 30 min");
    expect(hoursAndMinutes(0, t)).toBe("0 h 0 min");
  });
});

describe("readLeaveRequest", () => {
  it("reads a request", () => {
    const r = readLeaveRequest(
      form({
        kind: "annual_leave",
        ...date("startsOn", "2", "11", "2026"),
        ...date("endsOn", "6", "11", "2026"),
      }),
      t,
      LOCATION,
    );
    expect(r).toEqual({
      ok: true,
      body: {
        locationId: LOCATION,
        kind: "annual_leave",
        startsOn: "2026-11-02",
        endsOn: "2026-11-06",
        selfCertified: false,
      },
    });
  });

  it.each([
    ["sickness is recorded by a manager, not asked for", { kind: "sickness" }, "kind"],
    ["an end before the start", { kind: "annual_leave", end: "1" }, "endsOn"],
    ["a missing start", { kind: "annual_leave", start: "" }, "startsOn"],
  ])("refuses %s", (_name, opts, field) => {
    const r = readLeaveRequest(
      form({
        kind: opts.kind,
        ...date(
          "startsOn",
          "start" in opts ? (opts.start as string) : "2",
          "start" in opts ? "" : "11",
          "start" in opts ? "" : "2026",
        ),
        ...date("endsOn", "end" in opts ? (opts.end as string) : "6", "11", "2026"),
      }),
      t,
      LOCATION,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors)).toContain(field);
  });
});

describe("readDecision and readOverride", () => {
  it.each([
    [{ decision: "approve" }, { ok: true, body: { version: 3, decision: "approve" } }],
    [
      { decision: "approve", reason: "Cover found" },
      { ok: true, body: { version: 3, decision: "approve", reason: "Cover found" } },
    ],
    [
      { decision: "decline", reason: "No" },
      { ok: false, errors: { reason: "Give a reason of at least 3 characters when you decline." } },
    ],
    [{}, { ok: false, errors: { decision: "Choose approve or decline." } }],
  ])("decision %j", (fields, want) => {
    expect(readDecision(form(fields), t, 3)).toEqual(want);
  });

  it("an override needs a reason of 3 to 500 characters", () => {
    expect(readOverride(form({ reason: "ok" }), t, 1).ok).toBe(false);
    expect(readOverride(form({ reason: "x".repeat(501) }), t, 1).ok).toBe(false);
    expect(readOverride(form({ reason: " Paid by hand " }), t, 1)).toEqual({
      ok: true,
      body: { version: 1, reason: "Paid by hand" },
    });
  });
});

describe("readPayRun", () => {
  it.each([
    ["weekly", ["2", "11", "2026"], ["8", "11", "2026"], true],
    ["weekly", ["2", "11", "2026"], ["9", "11", "2026"], false],
    ["monthly", ["1", "11", "2026"], ["30", "11", "2026"], true],
    ["monthly", ["1", "2", "2027"], ["28", "2", "2027"], true],
    ["monthly", ["1", "11", "2026"], ["20", "11", "2026"], false],
    ["fortnightly", ["2", "11", "2026"], ["15", "11", "2026"], false],
  ])("%s from %j to %j is %s", (frequency, s, e, ok) => {
    const r = readPayRun(
      form({
        frequency,
        ...date("periodStart", ...(s as [string, string, string])),
        ...date("periodEnd", ...(e as [string, string, string])),
      }),
      t,
    );
    expect(r.ok).toBe(ok);
  });
});

describe("readRuleSet", () => {
  const base = { name: "Standard rates", ...date("effectiveFrom", "1", "4", "2027") };

  it("reads role rates in pounds as pence", () => {
    const r = readRuleSet(
      form({
        ...base,
        roleRates: "carer = 12.50\nsenior_carer = £13\n",
        sleepIn: "60",
        mileage: "0.45",
      }),
      t,
    );
    expect(r).toMatchObject({
      ok: true,
      body: {
        name: "Standard rates",
        effectiveFrom: "2027-04-01",
        roleRates: { carer: 1250, senior_carer: 1300 },
        sleepInFlatPence: 6000,
        mileagePencePerMile: 45,
      },
    });
  });

  it.each([
    ["no rates", { roleRates: "" }, "roleRates"],
    ["a rate without a role", { roleRates: "= 12" }, "roleRates"],
    ["a rate with three decimals", { roleRates: "carer = 12.505" }, "roleRates"],
    ["a sleep-in that is not money", { roleRates: "carer = 12", sleepIn: "lots" }, "sleepIn"],
    ["no name", { roleRates: "carer = 12", name: "" }, "name"],
  ])("refuses %s", (_name, fields, field) => {
    const r = readRuleSet(form({ ...base, ...fields }), t);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors)).toContain(field);
  });
});
