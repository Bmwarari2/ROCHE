import { describe, expect, it } from "vitest";
import {
  connectionRefusal,
  DEFAULT_HR_OWNERS,
  editRefusal,
  effectiveLeavingDate,
  type HrEmployee,
  type HrOwners,
  hrStaleness,
  inboundAbsence,
  leaverMaySignIn,
  leaverSignInEndsAt,
  matchEmployee,
  OUTBOUND_FIELDS,
  outboundExtraFields,
  outboundProblems,
  ownersProblems,
  payRouteChangeProblem,
  payrollExportAllowed,
  payUnitsToHrAllowed,
  type StaffCandidate,
  stalenessLimitProblem,
} from "./thapsus-hr";

const at = (iso: string) => new Date(iso);

describe("hazard HZ-133 one owner for each kind of staff data (rule 2)", () => {
  it.each([
    ["employee_record", "harbour", "managed_elsewhere"],
    ["employee_record", "thapsus_hr", null],
    ["leave_and_sickness", "harbour", "managed_elsewhere"],
    ["care_shifts", "harbour", null],
    ["care_shifts", "thapsus_hr", "managed_elsewhere"],
    ["clocking", "thapsus_hr", "managed_elsewhere"],
    ["timesheets_and_pay_units", "harbour", null],
  ] as const)("%s edited by %s: %s", (kind, editor, want) => {
    expect(editRefusal(DEFAULT_HR_OWNERS, kind, editor)).toBe(want);
  });

  it("refuses moving care-specific records, clocking or (until slice 88) the rota to Thapsus-HR", () => {
    const owners: HrOwners = {
      ...DEFAULT_HR_OWNERS,
      recruitment_and_vetting: "thapsus_hr",
      clocking: "thapsus_hr",
      care_shifts: "thapsus_hr",
    };
    expect(ownersProblems(owners).map((p) => p.kind)).toEqual([
      "care_shifts",
      "clocking",
      "recruitment_and_vetting",
    ]);
    expect(ownersProblems(DEFAULT_HR_OWNERS)).toEqual([]);
  });
});

describe("hazard HZ-133 the link is refused outside the UK (rule 1)", () => {
  const base = {
    homeRegion: "uk",
    apiBaseUrl: "https://api.uk.thapsus.example/v1",
    thapsusDomain: "thapsus.example",
  };
  it.each([
    ["a UK workspace on the UK host", {}, null],
    ["the host in capitals", { apiBaseUrl: "https://API.UK.THAPSUS.EXAMPLE/v1" }, null],
    ["an EU workspace", { homeRegion: "eu" }, "not_uk_region"],
    ["a US workspace", { homeRegion: "us" }, "not_uk_region"],
    ["the EU host", { apiBaseUrl: "https://api.eu.thapsus.example/v1" }, "not_uk_host"],
    [
      "a look-alike host",
      { apiBaseUrl: "https://api.uk.thapsus.example.evil.example/v1" },
      "not_uk_host",
    ],
    ["another port", { apiBaseUrl: "https://api.uk.thapsus.example:8443/v1" }, "not_uk_host"],
    [
      "a trailing dot on the host",
      { apiBaseUrl: "https://api.uk.thapsus.example./v1" },
      "not_uk_host",
    ],
    [
      "credentials in the URL",
      { apiBaseUrl: "https://user:secret@api.uk.thapsus.example/v1" },
      "not_uk_host",
    ],
    ["an empty domain", { apiBaseUrl: "https://api.uk./v1", thapsusDomain: "" }, "not_uk_host"],
    ["plain HTTP", { apiBaseUrl: "http://api.uk.thapsus.example/v1" }, "not_https"],
    ["not a URL", { apiBaseUrl: "api.uk.thapsus.example" }, "not_uk_host"],
  ])("%s", (_name, over, want) => {
    expect(connectionRefusal({ ...base, ...over })).toBe(want);
  });
});

const employee = (over: Partial<HrEmployee> = {}): HrEmployee => ({
  id: "hr-1",
  employeeNumber: "E100",
  workEmail: "ada.example@example.invalid",
  dateOfBirth: "1990-05-01",
  givenName: "Ada",
  familyName: "Example",
  ...over,
});
const staff = (over: Partial<StaffCandidate> = {}): StaffCandidate => ({
  memberId: "m1",
  employeeNumber: "E100",
  workEmail: "ada.example@example.invalid",
  dateOfBirth: "1990-05-01",
  linked: false,
  ...over,
});

describe("hazard HZ-133 matching never relies on a name (rule 3)", () => {
  it.each([
    [
      "the employee number",
      employee(),
      [staff()],
      { kind: "matched", memberId: "m1", how: "employee_number" },
    ],
    [
      "the work email with the date of birth, in any case",
      employee({ employeeNumber: null, workEmail: "ADA.Example@example.invalid" }),
      [staff({ employeeNumber: null })],
      { kind: "matched", memberId: "m1", how: "email_and_birth_date" },
    ],
    [
      "a number match whose date of birth disagrees",
      employee(),
      [staff({ dateOfBirth: "1991-05-01" })],
      { kind: "review", reason: "conflict" },
    ],
    [
      "a number match whose email disagrees",
      employee(),
      [staff({ workEmail: "someone.else@example.invalid" })],
      { kind: "review", reason: "conflict" },
    ],
    [
      "a number match while another member has the email and birth date",
      employee(),
      [staff({ workEmail: null }), staff({ memberId: "m2", employeeNumber: null })],
      { kind: "review", reason: "conflict" },
    ],
    [
      "the same email and birth date on a member with a different number",
      employee({ employeeNumber: "E1" }),
      [staff({ employeeNumber: "E2" })],
      { kind: "review", reason: "conflict" },
    ],
    [
      "two members with the number",
      employee(),
      [staff(), staff({ memberId: "m2" })],
      { kind: "review", reason: "ambiguous" },
    ],
    [
      "an email without a date of birth",
      employee({ employeeNumber: null, dateOfBirth: null }),
      [staff({ employeeNumber: null })],
      { kind: "review", reason: "no_match" },
    ],
    [
      "an email whose date of birth differs",
      employee({ employeeNumber: null, dateOfBirth: "1990-05-02" }),
      [staff({ employeeNumber: null })],
      { kind: "review", reason: "no_match" },
    ],
    [
      "the same name only",
      employee({ employeeNumber: null, workEmail: null }),
      [staff({ employeeNumber: null, workEmail: null })],
      { kind: "review", reason: "no_match" },
    ],
    [
      "a member already linked",
      employee(),
      [staff({ linked: true })],
      { kind: "review", reason: "already_linked" },
    ],
    ["nobody", employee(), [], { kind: "review", reason: "no_match" }],
  ] as const)("%s", (_name, e, candidates, want) => {
    expect(matchEmployee(e, candidates)).toEqual(want);
  });
});

describe("hazard HZ-133 only allowed fields cross (rules 4 and 10)", () => {
  it.each([
    [
      "shift",
      {
        harbourRef: "s1",
        employeeId: "e1",
        locationId: "l1",
        role: "carer",
        startsAt: "x",
        endsAt: "y",
        breakMinutes: 30,
      },
      [],
    ],
    [
      "shift",
      { harbourRef: "s1", personId: "p1", visitAddress: "1 Example Road" },
      ["personId", "visitAddress"],
    ],
    ["shift", { harbourRef: "s1", careNote: "n" }, ["careNote"]],
    [
      "clock_event",
      {
        harbourRef: "c1",
        employeeId: "e1",
        kind: "in",
        at: "t",
        locationId: "l1",
        position: "51.5,-0.1",
      },
      ["position"],
    ],
    [
      "pay_units",
      { employeeId: "e1", payPeriodId: "pp", payCode: "SLEEP", units: 1, rate: 1000 },
      ["rate"],
    ],
    ["starter", { givenName: "Ada", familyName: "Example", niNumber: "QQ123456C" }, ["niNumber"]],
  ] as const)("%s with %j", (flow, payload, extra) => {
    expect(outboundExtraFields(flow, payload)).toEqual(extra);
  });

  it.each([
    [
      "a nested object in an allowed field",
      "shift",
      { harbourRef: "s1", role: { visit: { address: "1 Example Road" } } },
      ["role"],
    ],
    ["a list in an allowed field", "pay_units", { employeeId: "e1", units: [1, 2] }, ["units"]],
    ["a break clock kind", "clock_event", { harbourRef: "c1", kind: "break_start" }, ["kind"]],
    ["a long text", "shift", { harbourRef: "x".repeat(201) }, ["harbourRef"]],
    ["a field not allowed", "shift", { harbourRef: "s1", personId: "p1" }, ["personId"]],
    [
      "nothing wrong",
      "clock_event",
      { harbourRef: "c1", employeeId: "e1", kind: "out", at: "t", atLocal: "t", locationId: "l1" },
      [],
    ],
  ] as const)("outbound problems: %s", (_name, flow, payload, want) => {
    expect(outboundProblems(flow, payload)).toEqual(want);
  });

  it("refuses an object that is not a plain record", () => {
    class Shift {
      harbourRef = "s1";
    }
    expect(outboundProblems("shift", new Shift())).toEqual(["(payload)"]);
  });

  it("never lists anything about a person receiving care", () => {
    const all = Object.values(OUTBOUND_FIELDS).flat().join(" ").toLowerCase();
    for (const word of ["person", "resident", "visit", "address", "note", "nhs", "care"]) {
      expect(all).not.toContain(word);
    }
  });

  it("takes sickness as dates and type only, dropping reasons and fit notes", () => {
    expect(
      inboundAbsence({
        id: "a1",
        employeeId: "e1",
        type: "Sickness",
        startsOn: "2026-11-02",
        endsOn: "2026-11-04",
        status: "approved",
        reason: "Flu",
        fitNote: "doc-1",
        notes: "Off with a chest infection",
      }),
    ).toEqual({
      id: "a1",
      employeeId: "e1",
      type: "sickness",
      startsOn: "2026-11-02",
      endsOn: "2026-11-04",
      status: "approved",
    });
  });

  it.each([
    ["no identifier", { employeeId: "e1", startsOn: "2026-11-02", status: "approved" }],
    [
      "an end before the start",
      {
        id: "a",
        employeeId: "e1",
        startsOn: "2026-11-02",
        endsOn: "2026-11-01",
        status: "approved",
      },
    ],
    ["an unknown status", { id: "a", employeeId: "e1", startsOn: "2026-11-02", status: "maybe" }],
    [
      "a date that is not a date",
      { id: "a", employeeId: "e1", startsOn: "2 Nov", status: "approved" },
    ],
    [
      "a day that does not exist",
      { id: "a", employeeId: "e1", startsOn: "2026-13-45", status: "approved" },
    ],
    [
      "an identifier that is free text",
      {
        id: "Off sick with flu, see note",
        employeeId: "e1",
        startsOn: "2026-11-02",
        status: "approved",
      },
    ],
  ])("refuses an absence with %s, to quarantine", (_name, raw) => {
    expect(inboundAbsence(raw)).toBeNull();
  });
});

describe("hazard HZ-133 staleness is said, at the limit and one minute past (rule 9)", () => {
  const sync = at("2026-11-06T10:00:00Z");
  it.each([
    ["at the default limit", "2026-11-06T10:15:00Z", 15, false, 15],
    ["one minute past", "2026-11-06T10:16:00Z", 15, true, 16],
    ["a lowered limit, past it", "2026-11-06T10:06:00Z", 5, true, 6],
    ["just synced", "2026-11-06T10:00:30Z", 15, false, 0],
  ] as const)("%s", (_name, now, limit, stale, minutes) => {
    expect(hrStaleness(sync, at(now), limit)).toEqual({ stale, minutesSince: minutes });
  });

  it.each([
    ["a limit that is not a number counts as 15", Number.NaN, "2026-11-06T10:16:00Z", true],
    ["a limit over 60 counts as 15", 600, "2026-11-06T10:16:00Z", true],
    ["a last sync in the future is not trusted", 15, "2026-11-06T09:59:00Z", true],
  ])("%s", (_name, limit, now, stale) => {
    expect(hrStaleness(sync, at(now), limit).stale).toBe(stale);
  });

  it("is stale when there has never been a good sync", () => {
    expect(hrStaleness(null, at("2026-11-06T10:00:00Z"))).toEqual({
      stale: true,
      minutesSince: null,
    });
  });

  it.each([
    [1, null],
    [15, null],
    [60, null],
    [61, "out_of_range"],
    [0, "out_of_range"],
    [7.5, "out_of_range"],
  ])("a limit of %s minutes: %s", (minutes, want) => {
    expect(stalenessLimitProblem(minutes)).toBe(want);
  });
});

describe("hazard HZ-133 a leaver's sign-in ends with their leaving day, even if later syncs fail or drop it (rule 8)", () => {
  it("ends at midnight UK time after the leaving day, in summer and in winter", () => {
    expect(leaverSignInEndsAt("2026-07-31").toISOString()).toBe("2026-07-31T23:00:00.000Z");
    expect(leaverSignInEndsAt("2026-12-31").toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it.each([
    ["on the leaving day", "2026-12-31T23:59:00Z", true],
    ["after it, with every sync since failed", "2027-01-01T00:00:00Z", false],
    ["weeks after it", "2027-02-01T09:00:00Z", false],
  ])("%s", (_name, now, may) => {
    expect(leaverMaySignIn("2026-12-31", at(now))).toBe(may);
  });

  it.each([["2026-02-30"], ["bad"]])(
    "refuses sign-in on a leaving date that is not a real day: %s",
    (date) => {
      expect(leaverMaySignIn(date, at("2026-01-01T09:00:00Z"))).toBe(false);
    },
  );

  it.each([
    ["first known", null, "2026-12-31", "2026-12-31"],
    ["a sync that drops it", "2026-12-31", null, "2026-12-31"],
    ["a sync that moves it later", "2026-12-31", "2027-03-31", "2026-12-31"],
    ["a sync that brings it forward", "2026-12-31", "2026-12-15", "2026-12-15"],
    ["a sync with a day that does not exist", "2026-12-31", "2026-02-30", "2026-12-31"],
  ])("keeps the leaving date: %s", (_name, known, incoming, want) => {
    expect(effectiveLeavingDate(known, incoming)).toBe(want);
  });

  it("lets a member with no leaving date sign in", () => {
    expect(leaverMaySignIn(null, at("2027-01-01T00:00:00Z"))).toBe(true);
  });
});

describe("hazard HZ-133 nobody is paid twice (rule 12)", () => {
  it.each([
    ["Harbour's export, no change waiting", "harbour_export", null, null, "2026-11-01", true],
    ["Thapsus-HR's route", "thapsus_hr", null, null, "2026-11-01", false],
    [
      "a move to Thapsus-HR from next period, this period",
      "harbour_export",
      "thapsus_hr",
      "2026-12-01",
      "2026-11-01",
      true,
    ],
    [
      "a move to Thapsus-HR from next period, next period",
      "harbour_export",
      "thapsus_hr",
      "2026-12-01",
      "2026-12-01",
      false,
    ],
    [
      "a move back to Harbour, not yet in force",
      "thapsus_hr",
      "harbour_export",
      "2026-12-01",
      "2026-11-01",
      false,
    ],
  ] as const)("%s", (_name, currentRoute, pendingRoute, pendingFrom, periodStart, want) => {
    const input = { currentRoute, pendingRoute, pendingFrom, periodStart };
    expect(payrollExportAllowed(input)).toBe(want);
    // Exactly one route pays a period: never both, never neither.
    expect(payUnitsToHrAllowed(input)).toBe(!want);
  });

  it("pays nothing through either route when a date is not a real day", () => {
    const input = {
      currentRoute: "harbour_export",
      pendingRoute: null,
      pendingFrom: null,
      periodStart: "2026-11-6",
    } as const;
    expect([payrollExportAllowed(input), payUnitsToHrAllowed(input)]).toEqual([false, false]);
  });

  it.each([
    ["the next period", "2026-12-01", "2026-11-01", null],
    ["the current period", "2026-11-01", "2026-11-01", "not_a_later_period"],
    ["an earlier period", "2026-10-01", "2026-11-01", "not_a_later_period"],
  ])("a route change from %s", (_name, from, currentPeriodStart, want) => {
    expect(payRouteChangeProblem({ from, currentPeriodStart })).toBe(want);
  });
});
