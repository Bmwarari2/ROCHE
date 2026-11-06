import { describe, expect, it } from "vitest";
import { type MedicationErrorAnswers, medicationErrorTriage } from "./medication-error";

const answered: MedicationErrorAnswers = {
  kinds: ["wrong_time"],
  reachedPerson: "no",
  controlledDrug: "no",
  deliberateOrRepeated: "no",
};

describe("hazard HZ-003 medication errors and near misses (safety.md Phase 2 rule 7)", () => {
  it("is a near miss with no tasks when nothing reached the person", () => {
    expect(medicationErrorTriage(answered)).toEqual({
      nearMiss: true,
      tasks: [],
      openQuestions: [],
    });
  });

  it.each<[string, Partial<MedicationErrorAnswers>, string[]]>([
    ["it reached the person", { reachedPerson: "yes" }, ["clinical_advice"]],
    ["it may have reached the person", { reachedPerson: "unsure" }, ["clinical_advice"]],
    ["a dose was omitted", { kinds: ["omitted_dose"] }, ["clinical_advice"]],
    ["a controlled drug was involved", { controlledDrug: "yes" }, ["controlled_drug_report"]],
    [
      "it may be deliberate or repeated",
      { deliberateOrRepeated: "unsure" },
      ["safeguarding_consideration"],
    ],
    [
      "everything at once",
      { reachedPerson: "yes", controlledDrug: "yes", deliberateOrRepeated: "yes" },
      ["clinical_advice", "controlled_drug_report", "safeguarding_consideration"],
    ],
  ])("raises tasks when %s", (_, change, tasks) => {
    expect(medicationErrorTriage({ ...answered, ...change }).tasks.map((t) => t.task)).toEqual(
      tasks,
    );
  });

  it("asks every open question and raises every follow-up while they are open", () => {
    const triage = medicationErrorTriage({
      kinds: [],
      reachedPerson: null,
      controlledDrug: null,
      deliberateOrRepeated: null,
    });
    expect(triage.openQuestions).toEqual([
      "kinds",
      "reachedPerson",
      "controlledDrug",
      "deliberateOrRepeated",
    ]);
    expect(triage.nearMiss).toBeNull();
    // Every follow-up is raised until a "no" answer rules it out (clinical review round 1).
    expect(triage.tasks.map((t) => t.task)).toEqual([
      "clinical_advice",
      "controlled_drug_report",
      "safeguarding_consideration",
    ]);
  });
});

import {
  checkMedicationErrorRecord,
  MEDICATION_ERROR_KIND_WORDS,
  MEDICATION_ERROR_KINDS,
  MEDICATION_ERROR_SOURCE,
  MEDICATION_ERROR_STAGE_WORDS,
  MEDICATION_ERROR_STAGES,
  type MedicationErrorRecordInput,
  medicationErrorPrompts,
  medicationErrorTrend,
  monthsBetween,
  presumedControlledDrug,
  ukMonthOf,
} from "./medication-error";

describe("hazard HZ-131 the medication error record (slice 45)", () => {
  const now = new Date("2026-11-01T12:00:00Z");
  const context = {
    now,
    clockToleranceMinutes: 5,
    occurredAt: new Date("2026-11-01T10:00:00Z"),
    medicineCdSchedule: null as string | null,
    today: "2026-11-01",
  };
  const record: MedicationErrorRecordInput = {
    ...answered,
    stage: "administration",
    immediateActions: "Checked the person; no ill effects seen.",
    clinicianToldAt: new Date("2026-11-01T11:00:00Z"),
    clinicianTold: "Out-of-hours GP",
    adviceGiven: "Give the next dose as usual.",
    rootCause: null,
    cdReportedOn: null,
    cdReportReference: null,
  };

  it("names every kind and stage in words, with the source of the categories", () => {
    for (const kind of MEDICATION_ERROR_KINDS)
      expect(MEDICATION_ERROR_KIND_WORDS[kind]).toBeTruthy();
    for (const stage of MEDICATION_ERROR_STAGES)
      expect(MEDICATION_ERROR_STAGE_WORDS[stage]).toBeTruthy();
    expect(MEDICATION_ERROR_SOURCE).toMatch(/NRLS/);
  });

  it("accepts a complete record", () => {
    expect(checkMedicationErrorRecord(record, context)).toEqual([]);
  });

  it.each<[string, Partial<MedicationErrorRecordInput>, Partial<typeof context>, string[]]>([
    ["an unknown kind", { kinds: ["bad" as never] }, {}, ["kind_unknown"]],
    ["a kind twice", { kinds: ["wrong_time", "wrong_time"] }, {}, ["kinds_repeated"]],
    ["a long root cause", { rootCause: "x".repeat(2001) }, {}, ["text_too_long"]],
    [
      "a long CD reference",
      { cdReportReference: "x".repeat(121), cdReportedOn: "2026-11-01", controlledDrug: "yes" },
      {},
      ["reference_too_long"],
    ],
    ["who without when", { clinicianToldAt: null }, {}, ["clinician_incomplete"]],
    ["when without who", { clinicianTold: " " }, {}, ["clinician_incomplete"]],
    [
      "told in the future",
      { clinicianToldAt: new Date("2026-11-01T12:30:00Z") },
      {},
      ["clinician_told_in_future"],
    ],
    [
      "told before the incident happened",
      { clinicianToldAt: new Date("2026-11-01T09:00:00Z") },
      {},
      ["clinician_told_before_incident"],
    ],
    [
      "a CD report date without a reference",
      { cdReportedOn: "2026-11-01", controlledDrug: "yes" },
      {},
      ["cd_report_incomplete"],
    ],
    [
      "a CD report dated in the future",
      { cdReportedOn: "2026-11-02", cdReportReference: "CD-1", controlledDrug: "yes" },
      {},
      ["cd_report_in_future"],
    ],
    [
      "a CD report for no controlled drug",
      { cdReportedOn: "2026-11-01", cdReportReference: "CD-1", controlledDrug: "no" },
      {},
      ["cd_report_without_cd"],
    ],
    [
      "an omitted dose said not to reach the person",
      { kinds: ["omitted_dose"], reachedPerson: "no" },
      {},
      ["omitted_not_reached"],
    ],
    [
      "no controlled drug for a scheduled medicine",
      { controlledDrug: "no" },
      { medicineCdSchedule: "2" },
      ["cd_denied_for_scheduled"],
    ],
  ])("refuses %s", (_, change, ctx, problems) => {
    expect(checkMedicationErrorRecord({ ...record, ...change }, { ...context, ...ctx })).toEqual(
      problems,
    );
  });

  it.each([
    [null, "2", "yes"],
    [null, null, null],
    ["unsure", null, "unsure"],
    ["yes", null, "yes"],
  ] as const)(
    "presumes a controlled drug from the schedule (answer %s, schedule %s) as %s",
    (answer, schedule, expected) => {
      expect(presumedControlledDrug(answer, schedule)).toBe(expected);
    },
  );

  const none = { cdReported: false, clinicalAdviceRecorded: false, safeguardingAnswered: false };
  it.each<[string, Parameters<typeof medicationErrorPrompts>, string[]]>([
    [
      "a near miss with no harm",
      [answered, { ...none, harmGrade: "none" }],
      ["cqc_through_classifier"],
    ],
    [
      "a CD error not yet reported",
      [
        { ...answered, controlledDrug: "yes" },
        { ...none, harmGrade: "none" },
      ],
      ["controlled_drug_report", "cqc_through_classifier"],
    ],
    [
      "a CD error reported, which clears its prompt",
      [
        { ...answered, controlledDrug: "yes" },
        { ...none, cdReported: true, harmGrade: "none" },
      ],
      ["cqc_through_classifier"],
    ],
    [
      "an error that reached the person with moderate harm",
      [
        { ...answered, reachedPerson: "yes" },
        { ...none, harmGrade: "moderate" },
      ],
      ["clinical_advice", "safeguarding_consideration", "cqc_through_classifier"],
    ],
    [
      "an error that may have reached the person with severe harm",
      [
        { ...answered, reachedPerson: "unsure" },
        { ...none, harmGrade: "severe" },
      ],
      ["clinical_advice", "safeguarding_consideration", "cqc_through_classifier"],
    ],
    [
      "an error that reached the person, harm not yet graded",
      [
        { ...answered, reachedPerson: "yes" },
        { ...none, harmGrade: null },
      ],
      ["clinical_advice", "safeguarding_consideration", "cqc_through_classifier"],
    ],
    [
      "an error that reached the person with low harm",
      [
        { ...answered, reachedPerson: "yes" },
        { ...none, harmGrade: "low" },
      ],
      ["clinical_advice", "cqc_through_classifier"],
    ],
    [
      "an omitted dose with no harm, for neglect",
      [
        { ...answered, kinds: ["omitted_dose"] },
        { ...none, harmGrade: "none" },
      ],
      ["clinical_advice", "safeguarding_consideration", "cqc_through_classifier"],
    ],
    [
      "an omitted dose with low harm, for neglect",
      [
        { ...answered, kinds: ["omitted_dose"] },
        { ...none, harmGrade: "low" },
      ],
      ["clinical_advice", "safeguarding_consideration", "cqc_through_classifier"],
    ],
    [
      "an omitted dose with fatal harm, even if said not to reach the person",
      [
        { ...answered, kinds: ["omitted_dose"] },
        { ...none, harmGrade: "fatal" },
      ],
      ["clinical_advice", "safeguarding_consideration", "cqc_through_classifier"],
    ],
    [
      "a repeated error, never prompted twice",
      [
        { ...answered, reachedPerson: "yes", deliberateOrRepeated: "yes" },
        { ...none, harmGrade: "severe" },
      ],
      ["clinical_advice", "safeguarding_consideration", "cqc_through_classifier"],
    ],
    [
      "advice recorded and safeguarding answered, which clears both",
      [
        { ...answered, reachedPerson: "yes", deliberateOrRepeated: "yes" },
        { ...none, harmGrade: "severe", clinicalAdviceRecorded: true, safeguardingAnswered: true },
      ],
      ["cqc_through_classifier"],
    ],
  ])("prompts for %s, sending nothing", (_, args, prompts) => {
    expect(medicationErrorPrompts(...args).map((p) => p.prompt)).toEqual(prompts);
  });

  it("words the prompts without overstating", () => {
    const prompts = medicationErrorPrompts(
      { ...answered, reachedPerson: "yes", controlledDrug: "unsure" },
      { ...none, harmGrade: null },
    );
    const reason = (p: string) => prompts.find((x) => x.prompt === p)?.reason ?? "";
    expect(reason("clinical_advice")).toMatch(/call 999/);
    expect(reason("controlled_drug_report")).toMatch(/^If a controlled drug was or may have been/);
    expect(reason("safeguarding_consideration")).toMatch(/not graded yet/);
    expect(reason("cqc_through_classifier")).toMatch(/for example/);
    expect(reason("cqc_through_classifier")).not.toMatch(/\bonly\b/);
  });

  it.each([
    ["2026-03-31T23:30:00Z", "2026-04"],
    ["2026-03-31T22:59:00Z", "2026-03"],
    ["2026-10-31T23:30:00Z", "2026-10"],
    ["2026-12-31T23:59:00Z", "2026-12"],
  ])("puts %s in the UK month %s", (instant, month) => {
    expect(ukMonthOf(new Date(instant))).toBe(month);
  });

  it("lists every month of a period, across a year end", () => {
    expect(monthsBetween("2026-11", "2027-02")).toEqual([
      "2026-11",
      "2026-12",
      "2027-01",
      "2027-02",
    ]);
  });

  it("counts errors, near misses and those not yet known by month, with empty months as zeros", () => {
    expect(
      medicationErrorTrend(
        [
          {
            month: "2026-10",
            kinds: ["wrong_time"],
            stage: "administration",
            reachedPerson: "yes",
          },
          { month: "2026-08", kinds: ["omitted_dose"], stage: null, reachedPerson: null },
          { month: "2026-10", kinds: ["wrong_dose"], stage: "administration", reachedPerson: "no" },
          { month: "2026-10", kinds: ["wrong_time"], stage: null, reachedPerson: "unsure" },
        ],
        ["2026-08", "2026-09", "2026-10"],
      ),
    ).toEqual([
      {
        month: "2026-08",
        errors: 1,
        nearMisses: 0,
        notYetKnown: 0,
        byKind: { omitted_dose: 1 },
        byStage: {},
      },
      { month: "2026-09", errors: 0, nearMisses: 0, notYetKnown: 0, byKind: {}, byStage: {} },
      {
        month: "2026-10",
        errors: 1,
        nearMisses: 1,
        notYetKnown: 1,
        byKind: { wrong_time: 2, wrong_dose: 1 },
        byStage: { administration: 2 },
      },
    ]);
  });
});
