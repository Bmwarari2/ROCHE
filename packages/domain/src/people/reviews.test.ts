import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import { RateNotFoundError, type RateRow } from "../platform/rates";
import { addWorkingDays, workingDaysDeadline } from "../shared/working-days";
import { plusMonths, plusWeeks } from "./dates";
import { PEOPLE_RATE_KEYS, type PeopleRateName, resolvePeopleRates } from "./rates";
import { type ReviewScheduleInput, scheduleReviews } from "./reviews";

const rows = readRateTable();
const rates = resolvePeopleRates(rows, "england", "2026-10-11", null);

describe("people rates come from the rate table", () => {
  it("finds every people key in docs/specs/rates.md for England", () => {
    for (const name of Object.keys(PEOPLE_RATE_KEYS) as PeopleRateName[]) {
      const row = rows.find((r) => r.key === PEOPLE_RATE_KEYS[name] && r.validTo === null);
      expect(row, PEOPLE_RATE_KEYS[name]).toBeDefined();
      expect(rates[name]).toBe(Number(row?.value));
      expect(rates[name]).toBeGreaterThan(0);
    }
  });

  it("fails loudly for a nation whose review figures the nation pack has not added yet", () => {
    expect(() => resolvePeopleRates(rows, "wales", "2026-10-11", null)).toThrow(RateNotFoundError);
  });

  it("lets a tenant override a default", () => {
    const override: RateRow = {
      key: PEOPLE_RATE_KEYS.familyInvolvementIntervalMonths,
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
      resolvePeopleRates([...rows, override], "england", "2026-10-11", "tenant-a")
        .familyInvolvementIntervalMonths,
    ).toBe(3);
  });
});

// England bank holidays in 2026 that these dates cross (docs/specs/calendar.md).
const HOLIDAYS = new Set(["2026-05-25", "2026-08-31", "2026-12-25", "2026-12-28"]);
const ADMITTED_AT = new Date("2026-08-27T14:00:00+01:00");

function input(overrides: Partial<ReviewScheduleInput> = {}): ReviewScheduleInput {
  return {
    status: "active",
    admittedAt: ADMITTED_AT,
    placement: { type: "permanent", startDate: "2026-08-27", localAuthorityFunded: true },
    carePlan: { firstPublishedAt: null, lastReviewedOn: null },
    laReviewsCompleted: [],
    changes: [],
    familyInvolvement: [],
    today: "2026-09-01",
    holidays: HOLIDAYS,
    rates,
    ...overrides,
  };
}

const kinds = (overrides: Partial<ReviewScheduleInput>) =>
  scheduleReviews(input(overrides)).items.map((i) => i.kind);

describe("first care plan", () => {
  it("is due within the working days after admission, skipping the bank holiday", () => {
    const first = scheduleReviews(input()).items.find((i) => i.kind === "first_care_plan");
    const dueOn = addWorkingDays("2026-08-27", rates.carePlanInitialWorkingDays, HOLIDAYS);
    expect(first).toEqual({
      kind: "first_care_plan",
      dueOn,
      windowOpensOn: null,
      dueAt: workingDaysDeadline(ADMITTED_AT, rates.carePlanInitialWorkingDays, HOLIDAYS),
      state: "upcoming",
      changeIds: [],
      basis: ["care_plan.initial_working_days"],
    });
    // The bank holiday on 31 August does not count.
    expect(dueOn > addWorkingDays("2026-08-27", rates.carePlanInitialWorkingDays, new Set())).toBe(
      true,
    );
  });

  it.each<[string, string]>([
    ["upcoming before the due day", "2026-09-01"],
    [
      "due on the due day",
      addWorkingDays("2026-08-27", rates.carePlanInitialWorkingDays, HOLIDAYS),
    ],
    ["overdue after it", "2026-10-01"],
  ])("is %s", (label, today) => {
    const state = scheduleReviews(input({ today })).items.find(
      (i) => i.kind === "first_care_plan",
    )?.state;
    expect(state).toBe(label.split(" ")[0]);
  });
});

describe("care plan reviews", () => {
  const published = new Date("2026-09-03T10:00:00Z");

  it("falls due an interval after the first plan, then after each review", () => {
    expect(
      scheduleReviews(
        input({ carePlan: { firstPublishedAt: published, lastReviewedOn: null } }),
      ).items.find((i) => i.kind === "care_plan_review")?.dueOn,
    ).toBe(plusMonths("2026-09-03", rates.carePlanReviewIntervalMonths));
    expect(
      scheduleReviews(
        input({
          carePlan: { firstPublishedAt: published, lastReviewedOn: "2026-10-01" },
          today: "2026-10-11",
        }),
      ).items.find((i) => i.kind === "care_plan_review"),
    ).toMatchObject({
      dueOn: plusMonths("2026-10-01", rates.carePlanReviewIntervalMonths),
      basis: ["care_plan.review_interval_months"],
    });
  });

  it("stops asking for a first plan once one is published", () => {
    expect(
      kinds({ carePlan: { firstPublishedAt: published, lastReviewedOn: null } }),
    ).not.toContain("first_care_plan");
  });

  it("hazard HZ-008 raises one review on change for several unreviewed changes", () => {
    const result = scheduleReviews(
      input({
        carePlan: { firstPublishedAt: published, lastReviewedOn: "2026-09-20" },
        today: "2026-10-11",
        changes: [
          { id: "c3", kind: "fall", occurredOn: "2026-10-09", reviewedOn: null },
          { id: "c1", kind: "change_in_needs", occurredOn: "2026-09-10", reviewedOn: null },
          { id: "c2", kind: "return_from_hospital", occurredOn: "2026-10-05", reviewedOn: null },
          { id: "c4", kind: "fall", occurredOn: "2026-10-06", reviewedOn: "2026-10-07" },
          { id: "c5", kind: "other", occurredOn: "2026-09-20", reviewedOn: null },
        ],
      }),
    );
    const onChange = result.items.filter((i) => i.kind === "care_plan_review_on_change");
    expect(onChange).toEqual([
      {
        kind: "care_plan_review_on_change",
        dueOn: "2026-09-20",
        windowOpensOn: null,
        dueAt: null,
        state: "overdue",
        changeIds: ["c5", "c2", "c3"],
        basis: [],
      },
    ]);
  });

  it("pauses care plan reviews while the person is in hospital", () => {
    const result = scheduleReviews(
      input({
        status: "in_hospital",
        carePlan: { firstPublishedAt: published, lastReviewedOn: null },
        today: "2026-12-01",
      }),
    );
    expect(result.items.find((i) => i.kind === "care_plan_review")?.state).toBe("paused");
    expect(result.items.find((i) => i.kind === "la_review")?.state).toBe("overdue");
  });
});

describe("local authority review", () => {
  it("opens a window 6 to 8 weeks after the start (figures from the table)", () => {
    expect(scheduleReviews(input()).items.find((i) => i.kind === "la_review")).toMatchObject({
      windowOpensOn: plusWeeks("2026-08-27", rates.laReviewFirstMinWeeks),
      dueOn: plusWeeks("2026-08-27", rates.laReviewFirstMaxWeeks),
      basis: ["la_review.first_min_weeks", "la_review.first_max_weeks"],
    });
  });

  it.each<[string, string]>([
    ["upcoming", plusWeeks("2026-08-27", rates.laReviewFirstMinWeeks - 1)],
    ["due", plusWeeks("2026-08-27", rates.laReviewFirstMinWeeks)],
    ["due", plusWeeks("2026-08-27", rates.laReviewFirstMaxWeeks)],
    ["overdue", plusWeeks("2026-08-27", rates.laReviewFirstMaxWeeks + 1)],
  ])("is %s on %s", (state, today) => {
    expect(scheduleReviews(input({ today })).items.find((i) => i.kind === "la_review")?.state).toBe(
      state,
    );
  });

  it("then falls due yearly from the last review", () => {
    expect(
      scheduleReviews(input({ laReviewsCompleted: ["2026-10-14", "2026-10-02"] })).items.find(
        (i) => i.kind === "la_review",
      ),
    ).toMatchObject({
      dueOn: plusMonths("2026-10-14", rates.laReviewIntervalMonths),
      windowOpensOn: null,
    });
  });

  it.each<[string, Partial<ReviewScheduleInput["placement"]>]>([
    ["self-funded placements", { localAuthorityFunded: false }],
    ["respite stays", { type: "respite" }],
    ["care packages", { type: "package" }],
  ])("is not tracked for %s", (_label, placement) => {
    expect(
      kinds({
        placement: {
          type: "permanent",
          startDate: "2026-08-27",
          localAuthorityFunded: true,
          ...placement,
        },
      }),
    ).not.toContain("la_review");
  });
});

describe("family involvement", () => {
  it("falls due an interval after admission, then after each record", () => {
    expect(scheduleReviews(input()).items.find((i) => i.kind === "family_involvement")?.dueOn).toBe(
      plusMonths("2026-08-27", rates.familyInvolvementIntervalMonths),
    );
    expect(
      scheduleReviews(
        input({
          familyInvolvement: [
            { kind: "attended_review", recordedOn: "2026-09-30" },
            { kind: "invited_declined", recordedOn: "2026-10-05" },
          ],
        }),
      ).items.find((i) => i.kind === "family_involvement")?.dueOn,
    ).toBe(plusMonths("2026-10-05", rates.familyInvolvementIntervalMonths));
  });

  it.each(["person_declines_involvement", "no_family_or_representative"] as const)(
    "is not scheduled when the latest record says %s",
    (kind) => {
      const result = scheduleReviews(
        input({
          familyInvolvement: [
            { kind: "attended_review", recordedOn: "2026-09-01" },
            { kind, recordedOn: "2026-09-10" },
          ],
        }),
      );
      expect(result.familyInvolvement).toBe(kind);
      expect(result.items.map((i) => i.kind)).not.toContain("family_involvement");
    },
  );
});

describe("trial periods and statuses", () => {
  it("asks for the trial review by the end of the trial", () => {
    const trial = {
      type: "trial" as const,
      startDate: "2026-08-27",
      trialEndsOn: "2026-09-24",
      localAuthorityFunded: false,
    };
    expect(
      scheduleReviews(input({ placement: trial })).items.find((i) => i.kind === "trial_review"),
    ).toMatchObject({
      dueOn: "2026-09-24",
      state: "upcoming",
    });
    expect(kinds({ placement: { ...trial, trialReviewedOn: "2026-09-20" } })).not.toContain(
      "trial_review",
    );
  });

  it.each([
    "enquiry",
    "pre_admission",
    "discharged",
    "deceased",
    "archived",
    "not_admitted",
  ] as const)("schedules nothing for a person who is %s", (status) => {
    expect(scheduleReviews(input({ status }))).toEqual({
      items: [],
      familyInvolvement: "not_receiving_care",
    });
  });

  it("lists reviews in due-date order", () => {
    const dates = scheduleReviews(input()).items.map((i) => i.dueOn);
    expect(dates).toEqual([...dates].sort());
  });
});
