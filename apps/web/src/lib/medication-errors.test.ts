import type { Translator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  defaultPeriod,
  defaultTrendPeriod,
  ERROR_FIELD_FOR_PROBLEM,
  ERROR_KINDS,
  ERROR_STAGES,
  fieldsFromRefusal,
  medicationErrorHref,
  overrideRows,
  personReviewsHref,
  promptChip,
  REVIEW_FIELD_FOR_PROBLEM,
  reachedChip,
  readCancelReview,
  readEditMedicationError,
  readNewMedicationError,
  readPeriod,
  readRescheduleReview,
  readReviewDone,
  readScheduleReview,
  reportHref,
  reviewChip,
  reviewEntryChip,
  trendTables,
  usageRows,
} from "./medication-errors";

/**
 * Medication errors, reviews and reports on the web (slice 55; MEDS-012, MEDS-013; medicines.md
 * section 14; HZ-134, with HZ-003 for an omitted dose and HZ-119 for the override report). The
 * translator here echoes its key and values, so each test proves which words are asked for
 * without depending on the catalogue.
 */

const t = Object.assign(
  (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${JSON.stringify(values)}` : key,
  { locale: "en-GB" as const },
) as unknown as Translator;

const form = (values: Record<string, string | readonly string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) {
    if (typeof v === "string") f.set(k, v);
    else for (const each of v) f.append(k, each);
  }
  return f;
};

const PERSON = "0194d000-0000-7000-8000-00000000b001";
const MED = "0194d000-0000-7000-8000-00000000b002";
const DOSE = "0194d000-0000-7000-8000-00000000b003";
const NOW = new Date("2026-11-06T12:00:00Z");
const OCCURRED = "2026-11-06T08:00:00.000Z";
const context = { occurredAt: OCCURRED, now: NOW, personIds: [PERSON] };

const told = {
  "clinicianToldAt-day": "6",
  "clinicianToldAt-month": "11",
  "clinicianToldAt-year": "2026",
  "clinicianToldAt-hour": "09",
  "clinicianToldAt-minute": "30",
};
const reported = {
  "cdReportedOn-day": "6",
  "cdReportedOn-month": "11",
  "cdReportedOn-year": "2026",
};

describe("hazard HZ-134 the medication error form is read into the contract", () => {
  it("reads every detail, with the person, the medicine and the dose record", () => {
    const read = readNewMedicationError(
      form({
        personId: PERSON,
        medicationId: MED,
        administrationId: DOSE,
        kinds: ["wrong_dose", "wrong_time", "wrong_dose"],
        stage: "administration",
        reachedPerson: "yes",
        controlledDrug: "unsure",
        deliberateOrRepeated: "no",
        immediateActions: " Observed for an hour ",
        ...told,
        clinicianTold: "Out-of-hours GP",
        adviceGiven: "Monitor and call back if unwell",
        ...reported,
        cdReportReference: "CDAO-EX-1",
      }),
      t,
      context,
    );
    expect(read).toEqual({
      ok: true,
      body: {
        personId: PERSON,
        medicationId: MED,
        administrationId: DOSE,
        kinds: ["wrong_dose", "wrong_time"],
        stage: "administration",
        reachedPerson: "yes",
        controlledDrug: "unsure",
        deliberateOrRepeated: "no",
        immediateActions: "Observed for an hour",
        clinicianToldAt: "2026-11-06T09:30:00.000Z",
        clinicianTold: "Out-of-hours GP",
        adviceGiven: "Monitor and call back if unwell",
        rootCause: null,
        cdReportedOn: "2026-11-06",
        cdReportReference: "CDAO-EX-1",
      },
    });
  });

  it("sends nothing unanswered as an answer: empty is null, never no", () => {
    const read = readEditMedicationError(form({}), t, { ...context, version: 3 });
    expect(read).toEqual({
      ok: true,
      body: {
        medicationId: null,
        administrationId: null,
        kinds: [],
        stage: null,
        reachedPerson: null,
        controlledDrug: null,
        deliberateOrRepeated: null,
        immediateActions: null,
        clinicianToldAt: null,
        clinicianTold: null,
        adviceGiven: null,
        rootCause: null,
        cdReportedOn: null,
        cdReportReference: null,
        version: 3,
      },
    });
  });

  it.each([
    [
      "a person not on the incident",
      { personId: "0194d000-0000-7000-8000-00000000ffff" },
      "personId",
    ],
    ["a medicine that is not an id", { personId: PERSON, medicationId: "x" }, "medicationId"],
    [
      "a dose record that is not an id",
      { personId: PERSON, administrationId: "1" },
      "administrationId",
    ],
    ["an unknown kind", { personId: PERSON, kinds: ["made_up"] }, "kinds"],
    ["an unknown stage", { personId: PERSON, stage: "made_up" }, "stage"],
    ["an unknown answer", { personId: PERSON, controlledDrug: "maybe" }, "controlledDrug"],
    [
      "hazard HZ-003 an omitted dose answered as not reaching the person",
      { personId: PERSON, kinds: ["omitted_dose"], reachedPerson: "no" },
      "reachedPerson",
    ],
    ["who was told without when", { personId: PERSON, clinicianTold: "GP" }, "clinicianToldAt"],
    ["when without who", { personId: PERSON, ...told }, "clinicianTold"],
    [
      "told before the incident happened",
      { personId: PERSON, ...told, "clinicianToldAt-hour": "07", clinicianTold: "GP" },
      "clinicianToldAt",
    ],
    [
      "told in the future",
      { personId: PERSON, ...told, "clinicianToldAt-day": "8", clinicianTold: "GP" },
      "clinicianToldAt",
    ],
    ["a report date without its reference", { personId: PERSON, ...reported }, "cdReportReference"],
    ["a reference without its date", { personId: PERSON, cdReportReference: "R1" }, "cdReportedOn"],
    [
      "a report dated in the future",
      { personId: PERSON, ...reported, "cdReportedOn-day": "9", cdReportReference: "R1" },
      "cdReportedOn",
    ],
    [
      "a report with no controlled drug",
      { personId: PERSON, controlledDrug: "no", ...reported, cdReportReference: "R1" },
      "controlledDrug",
    ],
    ["advice too long", { personId: PERSON, adviceGiven: "a".repeat(2001) }, "adviceGiven"],
    [
      "a reference too long",
      { personId: PERSON, ...reported, cdReportReference: "r".repeat(121) },
      "cdReportReference",
    ],
  ] as const)("says %s at its field", (_name, values, field) => {
    const read = readNewMedicationError(form(values), t, context);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(Object.keys(read.errors)).toContain(field);
  });

  it("offers every kind and stage the contract has, once", () => {
    expect(new Set(ERROR_KINDS).size).toBe(16);
    expect(new Set(ERROR_STAGES).size).toBe(7);
  });
});

describe("hazard HZ-134 the escalations are shown in the API's order as icon and word, never sent", () => {
  it.each([
    ["clinical_advice", "due"],
    ["controlled_drug_report", "due"],
    ["safeguarding_consideration", "due"],
    ["cqc_through_classifier", "info"],
  ] as const)("%s is %s with its name", (prompt, status) => {
    const chip = promptChip(prompt, t);
    expect(chip.status).toBe(status);
    expect(chip.icon).toBeTruthy();
    expect(chip.label).toContain(prompt);
  });

  it.each([
    [null, "notRecorded", "unknown"],
    [true, "info", "near_miss"],
    [false, "overdue", "reached"],
  ] as const)("whether it reached the person (%s) is %s, in words", (nearMiss, status, state) => {
    const chip = reachedChip(nearMiss, t);
    expect(chip.status).toBe(status);
    expect(chip.label).toContain(state);
  });
});

describe("hazard HZ-134 the API's refusals show at their fields", () => {
  const words = {
    clinician_incomplete: "Say both who was told and when, or neither.",
    cd_report_in_future: "The controlled drug report cannot be dated in the future.",
    text_too_long: "Keep each answer to 2,000 characters or fewer.",
  };
  it("finds each known sentence in the joined refusal", () => {
    const detail = `${words.clinician_incomplete} ${words.cd_report_in_future} ${words.text_too_long}`;
    expect(fieldsFromRefusal(detail, words, ERROR_FIELD_FOR_PROBLEM)).toEqual({
      clinicianTold: words.clinician_incomplete,
      cdReportedOn: words.cd_report_in_future,
    });
  });
  it("puts nothing at a field for words it does not know", () => {
    expect(fieldsFromRefusal("Something else.", words, ERROR_FIELD_FOR_PROBLEM)).toEqual({});
  });
  it("maps the review problems to the review form's fields", () => {
    expect(
      fieldsFromRefusal(
        "Name the clinician who did the review.",
        { clinician_required: "Name the clinician who did the review." },
        REVIEW_FIELD_FOR_PROBLEM,
      ),
    ).toEqual({ clinicianName: "Name the clinician who did the review." });
  });
});

describe("hazard HZ-134 medication reviews: status as icon and words, each change with its reason", () => {
  it.each([
    ["overdue", "overdue"],
    ["due_soon", "due"],
    ["scheduled", "done"],
    ["not_booked", "due"],
    ["not_scheduled", "notRecorded"],
  ] as const)("a tracker line %s is %s with the API's words", (status, chip) => {
    const read = reviewChip(status, "Words from the API");
    expect(read.status).toBe(chip);
    expect(read.label).toBe("Words from the API");
    expect(read.icon).toBeTruthy();
  });

  it.each([
    [{ doneOn: "2026-10-01" }, "done"],
    [{ doneOn: null }, "due"],
  ] as const)("a review on the person's list (%o) is %s", (review, status) => {
    expect(reviewEntryChip(review, t).status).toBe(status);
  });

  const due = { "dueOn-day": "1", "dueOn-month": "12", "dueOn-year": "2026" };
  const done = {
    "doneOn-day": "5",
    "doneOn-month": "11",
    "doneOn-year": "2026",
    clinicianName: "Dr Ada Example",
    clinicianRole: "gp",
    outcome: "No changes.",
  };

  it("schedules on the date typed", () => {
    expect(readScheduleReview(form(due), t)).toEqual({ ok: true, body: { dueOn: "2026-12-01" } });
    expect(readScheduleReview(form({}), t).ok).toBe(false);
  });

  it("records a review done, and a correction only with its reason", () => {
    expect(readReviewDone(form(done), t, { version: 2, correcting: false, now: NOW })).toEqual({
      ok: true,
      body: {
        doneOn: "2026-11-05",
        clinicianName: "Dr Ada Example",
        clinicianRole: "gp",
        outcome: "No changes.",
        correctionReason: null,
        version: 2,
      },
    });
    const correcting = readReviewDone(form(done), t, { version: 2, correcting: true, now: NOW });
    expect(correcting.ok).toBe(false);
    if (!correcting.ok) expect(Object.keys(correcting.errors)).toEqual(["correctionReason"]);
  });

  it.each([
    ["a date still to come", { ...done, "doneOn-day": "7" }, "doneOn"],
    ["no clinician", { ...done, clinicianName: " " }, "clinicianName"],
    ["an unknown role", { ...done, clinicianRole: "nurse" }, "clinicianRole"],
    ["no outcome", { ...done, outcome: "" }, "outcome"],
    ["an outcome too long", { ...done, outcome: "o".repeat(4001) }, "outcome"],
  ] as const)("refuses a review done with %s", (_name, values, field) => {
    const read = readReviewDone(form(values), t, { version: 1, correcting: false, now: NOW });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(Object.keys(read.errors)).toContain(field);
  });

  it("moves a booked review with a reason, and cancels one with a reason", () => {
    expect(readRescheduleReview(form({ ...due, reason: "GP away" }), t, 4)).toEqual({
      ok: true,
      body: { dueOn: "2026-12-01", reason: "GP away", version: 4 },
    });
    const noReason = readRescheduleReview(form(due), t, 4);
    expect(noReason.ok).toBe(false);
    expect(readCancelReview(form({ reason: "Booked twice" }), t, 4)).toEqual({
      ok: true,
      body: { reason: "Booked twice", version: 4 },
    });
    const cancel = readCancelReview(form({ reason: "r".repeat(501) }), t, 4);
    expect(cancel.ok).toBe(false);
  });
});

describe("hazard HZ-134 hazard HZ-119 the reports: periods, and tables readable without colour", () => {
  it("defaults to the days up to today, and six months for the trend", () => {
    expect(defaultPeriod(28, NOW)).toEqual({ from: "2026-10-10", to: "2026-11-06" });
    expect(defaultTrendPeriod(NOW)).toEqual({ from: "2026-06-01", to: "2026-11-06" });
    expect(defaultTrendPeriod(new Date("2026-02-10T12:00:00Z")).from).toBe("2025-09-01");
  });

  const fallback = { from: "2026-10-10", to: "2026-11-06" };
  it.each([
    ["nothing chosen", {}, { ok: true, period: fallback }],
    [
      "dates in the address",
      { from: "2026-01-01", to: "2026-01-31" },
      { ok: true, period: { from: "2026-01-01", to: "2026-01-31" } },
    ],
    [
      "the period form's boxes",
      {
        "from-day": "1",
        "from-month": "9",
        "from-year": "2026",
        "to-day": "30",
        "to-month": "9",
        "to-year": "2026",
      },
      { ok: true, period: { from: "2026-09-01", to: "2026-09-30" } },
    ],
  ] as const)("reads %s", (_name, params, expected) => {
    expect(readPeriod(params, t, fallback)).toEqual(expected);
  });

  it.each([
    ["a date that is not real", { from: "2026-02-30", to: "2026-03-01" }, "from"],
    ["an end before the start", { from: "2026-03-02", to: "2026-03-01" }, "to"],
    [
      "boxes half filled",
      { "from-day": "1", "to-day": "2", "to-month": "3", "to-year": "2026" },
      "from",
    ],
  ] as const)("says %s at its field and reads nothing", (_name, params, field) => {
    const read = readPeriod(params, t, fallback);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(Object.keys(read.errors)).toContain(field);
  });

  it("puts every month in a column, totals each row, and lists only kinds that happened", () => {
    const tables = trendTables(
      {
        months: [
          {
            month: "2026-10",
            errors: 2,
            nearMisses: 1,
            notYetKnown: 0,
            byKind: { omitted_dose: 2, wrong_time: 1 },
            byStage: { administration: 3 },
          },
          { month: "2026-11", errors: 0, nearMisses: 0, notYetKnown: 1, byKind: {}, byStage: {} },
        ],
      },
      t,
    );
    expect(tables.months).toHaveLength(2);
    expect(tables.reached.map((r) => [r.id, r.cells])).toEqual([
      ["errors", ["2", "0", "2"]],
      ["nearMisses", ["1", "0", "1"]],
      ["notYetKnown", ["0", "1", "1"]],
    ]);
    expect(tables.kinds.map((r) => [r.id, r.cells])).toEqual([
      ["omitted_dose", ["2", "0", "2"]],
      ["wrong_time", ["1", "0", "1"]],
    ]);
    expect(tables.stages.map((r) => r.id)).toEqual(["administration"]);
  });

  it("hazard HZ-119 counts overrides per member, a member without a name said so", () => {
    const rows = overrideRows(
      {
        items: [
          {
            memberId: "m1",
            name: null,
            competenceOverride: 2,
            competenceNotCurrent: 1,
            givenBeforeRecorded: 0,
          },
        ],
      },
      t,
    );
    expect(rows).toEqual([
      { id: "m1", label: "medicines.errors.overrides.unnamed", cells: ["2", "1", "0"] },
    ]);
  });

  it("lists PRN and psychotropic counts per person, then per medicine", () => {
    const rows = usageRows(
      {
        items: [
          {
            personId: "p1",
            name: "Ada Example",
            prnGiven: 3,
            psychotropicGiven: 1,
            psychotropicPrnGiven: 1,
            byMedicine: [
              { medicineId: "x", name: "Example medicine", prnGiven: 3, psychotropicGiven: 1 },
            ],
          },
        ],
      },
      t,
    );
    expect(rows.map((r) => r.cells)).toEqual([
      ["3", "1", "1"],
      ["3", "1", ""],
    ]);
  });
});

describe("addresses", () => {
  it("builds each page's address", () => {
    expect(medicationErrorHref("i")).toBe("/incidents/i/medication-error");
    expect(personReviewsHref("p")).toBe("/people/p/medicines/reviews");
    expect(reportHref("l", "trend")).toBe("/medicines-reports/l/trend");
  });
});
