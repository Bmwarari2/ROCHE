import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import type { RateRow } from "../platform/rates";
import {
  actionsDrivingTasks,
  CARE_PLAN_RATE_KEYS,
  type CarePlanRates,
  carePlanDue,
  checkPlanAction,
  checkPublication,
  checkSignOff,
  firstCarePlanDue,
  PCSP_DOMAIN_LABELS,
  PCSP_DOMAINS,
  type PlanSectionDraft,
  planPublication,
  resolveCarePlanRates,
  reviewOnChange,
  type SignOff,
} from "./care-plan";

/**
 * Care plan timing and publication (care.md section 4 rules 1 and 2; register row CARE-001).
 * Figures come from docs/specs/rates.md; bank holidays here are excerpts of docs/specs/calendar.md.
 */

const rows = readRateTable();
const ENGLAND_RATES = resolveCarePlanRates(rows, "england", "2026-10-11", null);
const ENGLAND = new Set(["2026-12-25", "2026-12-28", "2027-01-01", "2027-03-26", "2027-03-29"]);
const days = ENGLAND_RATES.initialWorkingDays ?? Number.NaN;

const rateValue = (key: string) => Number(rows.find((r) => r.key === key)?.value);

describe("care plan figures come from the rate table", () => {
  it("reads the first-plan working days and the review interval for England", () => {
    expect(ENGLAND_RATES).toEqual({
      initialWorkingDays: rateValue(CARE_PLAN_RATE_KEYS.initialWorkingDays),
      reviewIntervalMonths: rateValue(CARE_PLAN_RATE_KEYS.reviewIntervalMonths),
    });
  });

  it.each(["wales", "scotland", "northern_ireland"] as const)(
    "gives no first-plan deadline in %s rather than guessing one (the figure is England's)",
    (nation) => {
      const rates = resolveCarePlanRates(rows, nation, "2026-10-11", null);
      expect(rates.initialWorkingDays).toBeNull();
      expect(rates.reviewIntervalMonths).toBe(ENGLAND_RATES.reviewIntervalMonths);
    },
  );

  it("lets a tenant override the review interval", () => {
    const override: RateRow = {
      key: CARE_PLAN_RATE_KEYS.reviewIntervalMonths,
      value: "3",
      unit: "months",
      nation: "all",
      validFrom: "2026-01-01",
      validTo: null,
      tenantId: "tenant-a",
      verificationStatus: "tenant",
      source: "tenant policy",
    };
    expect(
      resolveCarePlanRates([...rows, override], "england", "2026-10-11", "tenant-a")
        .reviewIntervalMonths,
    ).toBe(3);
  });

  it("still fails loudly when the review interval itself is missing", () => {
    expect(() => resolveCarePlanRates([], "england", "2026-10-11", null)).toThrow(/No rate/);
  });
});

describe("rule 1: the first care plan is due within the working days after admission", () => {
  it.each([
    // Admission day never counts; weekends and the nation's bank holidays are skipped.
    ["2026-10-12", ENGLAND, "an ordinary Monday admission"],
    ["2026-10-17", ENGLAND, "a Saturday admission counts from Monday"],
    ["2026-12-21", ENGLAND, "over Christmas, the substitute Boxing Day and New Year's Day"],
    ["2027-03-24", ENGLAND, "over Good Friday and Easter Monday"],
    ["2026-12-21", new Set<string>(), "the same admission without bank holidays"],
  ])("admitted %s: due on the working day the rate table names (%s)", (admittedOn, holidays) => {
    const due = firstCarePlanDue(admittedOn, days, holidays);
    // Count the working days between admission and the due date independently of the helper.
    let counted = 0;
    const cursor = new Date(`${admittedOn}T00:00:00Z`);
    while (cursor.toISOString().slice(0, 10) < due.dueOn) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      const iso = cursor.toISOString().slice(0, 10);
      const weekday = cursor.getUTCDay();
      if (weekday !== 0 && weekday !== 6 && !holidays.has(iso)) counted++;
    }
    expect(counted).toBe(days);
  });

  it("skips bank holidays, so the Christmas deadline is later than without them", () => {
    const withHolidays = firstCarePlanDue("2026-12-21", days, ENGLAND);
    const without = firstCarePlanDue("2026-12-21", days, new Set());
    expect(withHolidays.dueOn > without.dueOn).toBe(true);
    expect(withHolidays.deadline.getTime()).toBeGreaterThan(without.deadline.getTime());
  });

  it("runs out at midnight UK time at the end of the due day", () => {
    const due = firstCarePlanDue("2026-11-02", days, ENGLAND);
    const [y, m, d] = due.dueOn.split("-").map(Number) as [number, number, number];
    const nextDay = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
    // November is GMT: midnight UK time is midnight UTC.
    expect(due.deadline.toISOString()).toBe(`${nextDay}T00:00:00.000Z`);
  });

  it("refuses an admission date that is not a real date", () => {
    expect(() => firstCarePlanDue("2026-02-30", days, ENGLAND)).toThrow(RangeError);
  });
});

describe("rule 1: reviews every review interval and on change", () => {
  const due = (today: string, activeReviewDueOn: string | null, firstPlanDueOn: string | null) =>
    carePlanDue({ today, activeReviewDueOn, firstPlanDueOn });

  it.each([
    ["2026-10-20", null, "2026-10-21", { kind: "first_plan", dueOn: "2026-10-21", overdue: false }],
    ["2026-10-21", null, "2026-10-21", { kind: "first_plan", dueOn: "2026-10-21", overdue: false }],
    ["2026-10-22", null, "2026-10-21", { kind: "first_plan", dueOn: "2026-10-21", overdue: true }],
    ["2026-10-22", null, null, { kind: "first_plan", dueOn: null, overdue: false }],
    ["2026-11-10", "2026-11-11", null, { kind: "review", dueOn: "2026-11-11", overdue: false }],
    ["2026-11-11", "2026-11-11", null, { kind: "review", dueOn: "2026-11-11", overdue: false }],
    [
      "2026-11-12",
      "2026-11-11",
      "2026-01-01",
      { kind: "review", dueOn: "2026-11-11", overdue: true },
    ],
  ] as const)("on %s with review %s and first plan %s", (today, review, first, expected) => {
    expect(due(today, review, first)).toEqual(expected);
  });

  it.each([
    [null, "2026-10-15", "2026-10-15", "no review date yet"],
    ["2026-11-11", "2026-10-15", "2026-10-15", "a change brings the review forward"],
    ["2026-10-01", "2026-10-15", "2026-10-01", "a change never puts a review back"],
  ])("current %s, changed %s: review due %s (%s)", (current, changedOn, expected, _label) => {
    expect(reviewOnChange(current, changedOn)).toBe(expected);
  });
});

const section = (overrides: Partial<PlanSectionDraft> = {}): PlanSectionDraft => ({
  domain: "mobility",
  need: "Needs help to stand from a chair.",
  outcome: "I want to walk to the garden every day.",
  actions: [{ generatesTasks: false, recurrence: null, roleKey: null }],
  ...overrides,
});

describe("rule 2: publication", () => {
  it("uses the 16 PCSP need domains, each with a sentence-case label", () => {
    expect(PCSP_DOMAINS).toHaveLength(16);
    expect(new Set(PCSP_DOMAINS).size).toBe(16);
    for (const domain of PCSP_DOMAINS) {
      const label = PCSP_DOMAIN_LABELS[domain];
      expect(label.charAt(0)).toBe(label.charAt(0).toUpperCase());
      expect(label.slice(1)).toBe(label.slice(1).toLowerCase());
    }
  });

  it.each([
    ["a complete draft", "draft", [section()], []],
    ["an active plan", "active", [section()], ["not_a_draft"]],
    ["a superseded plan", "superseded", [section()], ["not_a_draft"]],
    ["a draft with no sections", "draft", [], ["no_sections"]],
    ["a section with no need", "draft", [section({ need: " " })], ["section_incomplete"]],
    ["a section with no outcome", "draft", [section({ outcome: null })], ["section_incomplete"]],
    [
      "a task-generating action with no schedule",
      "draft",
      [section({ actions: [{ generatesTasks: true, recurrence: null, roleKey: "care_worker" }] })],
      ["action_incomplete"],
    ],
  ] as const)("checks %s", (_label, status, sections, problems) => {
    const check = checkPublication({ status, sections });
    expect(check.ok ? [] : check.issues.map((i) => i.problem)).toEqual(problems);
  });

  it("names the domain of an incomplete section in the message", () => {
    const check = checkPublication({
      status: "draft",
      sections: [section({ domain: "skin", outcome: "" })],
    });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.issues[0]?.message).toContain("Skin");
  });

  it.each([
    [null, "2026-10-11", 1, null, "the first version"],
    [
      { id: "plan-1", publishedVersion: 1 },
      "2026-10-11",
      2,
      "plan-1",
      "the second supersedes the first",
    ],
    [{ id: "plan-4", publishedVersion: 4 }, "2026-10-11", 5, "plan-4", "versions keep counting"],
  ])(
    "publishing with %j on %s gives version %i superseding %s (%s)",
    (active, today, version, supersedes, _label) => {
      const result = planPublication({ active, today, requestedReviewOn: null }, ENGLAND_RATES);
      expect(result).toMatchObject({ publishedVersion: version, supersedesPlanId: supersedes });
    },
  );

  const rates: CarePlanRates = ENGLAND_RATES;
  it.each([
    [null, "the review interval from the rate table"],
    ["2026-10-25", "an earlier review the clinician asks for"],
  ])("sets the review date from %s (%s)", (requested, _label) => {
    const result = planPublication(
      { active: null, today: "2026-10-11", requestedReviewOn: requested },
      rates,
    );
    const latest = new Date(Date.UTC(2026, 9 + rates.reviewIntervalMonths, 11))
      .toISOString()
      .slice(0, 10);
    expect(result).toEqual({
      publishedVersion: 1,
      supersedesPlanId: null,
      reviewDueOn: requested ?? latest,
    });
  });

  it.each([
    ["2026-10-10", "a review date in the past"],
    ["2027-10-11", "a review date beyond the interval"],
    ["11/10/2026", "a date that is not yyyy-mm-dd"],
  ])("refuses %s (%s)", (requested, _label) => {
    expect(() =>
      planPublication({ active: null, today: "2026-10-11", requestedReviewOn: requested }, rates),
    ).toThrow(RangeError);
  });
});

describe("rule 2: only an active plan drives tasks", () => {
  const actions = [
    { id: "a1", generatesTasks: true },
    { id: "a2", generatesTasks: false },
  ];
  it.each([
    ["active", ["a1"]],
    ["draft", []],
    ["superseded", []],
  ] as const)("a %s plan drives %j", (status, expected) => {
    expect(actionsDrivingTasks({ status, actions }).map((a) => a.id)).toEqual(expected);
  });
});

describe("rule 2: plan actions slice 5 turns into tasks", () => {
  const daily = { freq: "daily", times: ["08:00", "20:00"] } as const;
  it.each([
    ["an as-needed action", { generatesTasks: false, recurrence: null, roleKey: null }, null],
    [
      "a scheduled action",
      { generatesTasks: true, recurrence: daily, roleKey: "care_worker" },
      null,
    ],
    [
      "no recurrence",
      { generatesTasks: true, recurrence: null, roleKey: "care_worker" },
      "recurrence",
    ],
    ["no role", { generatesTasks: true, recurrence: daily, roleKey: null }, "role"],
    [
      "an impossible time",
      {
        generatesTasks: true,
        recurrence: { freq: "daily", times: ["25:00"] },
        roleKey: "care_worker",
      },
      "recurrence",
    ],
  ] as const)("%s", (_label, action, problemField) => {
    const check = checkPlanAction(action, "2026-10-11");
    expect(check.ok ? null : check.field).toBe(problemField);
  });
});

describe("rule 2: sign-off records who agreed, or why not", () => {
  it.each<[string, SignOff, string | null]>([
    ["the person agreed", { agreedBy: "person" }, null],
    [
      "an attorney agreed",
      {
        agreedBy: "representative",
        representativeName: "Eve Example",
        authority: "lpa_health_welfare",
      },
      null,
    ],
    [
      "a representative without a name",
      { agreedBy: "representative", representativeName: " ", authority: "deputy" },
      "representativeName",
    ],
    [
      "a representative without an authority",
      { agreedBy: "representative", representativeName: "Eve Example", authority: null },
      "authority",
    ],
    [
      "unable, with a reason",
      { agreedBy: "unable", reason: "Asleep during every review visit." },
      null,
    ],
    ["unable, with no reason", { agreedBy: "unable", reason: "" }, "reason"],
    ["unable, with a token reason", { agreedBy: "unable", reason: "n/a" }, "reason"],
  ])("%s", (_label, signOff, field) => {
    const check = checkSignOff(signOff);
    expect(check.ok ? null : check.field).toBe(field);
  });
});
