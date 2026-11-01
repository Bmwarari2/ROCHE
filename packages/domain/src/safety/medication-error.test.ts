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
  presumedControlledDrug,
} from "./medication-error";

describe("hazard HZ-131 the medication error record (slice 45)", () => {
  const now = new Date("2026-11-01T12:00:00Z");
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
    expect(checkMedicationErrorRecord(record, now, 5)).toEqual([]);
  });

  it.each<[string, Partial<MedicationErrorRecordInput>, string[]]>([
    ["an unknown kind", { kinds: ["bad" as never] }, ["kind_unknown"]],
    ["a kind twice", { kinds: ["wrong_time", "wrong_time"] }, ["kinds_repeated"]],
    ["a long root cause", { rootCause: "x".repeat(2001) }, ["text_too_long"]],
    [
      "a long CD reference",
      { cdReportReference: "x".repeat(121), cdReportedOn: "2026-11-01", controlledDrug: "yes" },
      ["text_too_long"],
    ],
    ["who without when", { clinicianToldAt: null }, ["clinician_incomplete"]],
    ["when without who", { clinicianTold: " " }, ["clinician_incomplete"]],
    [
      "told in the future",
      { clinicianToldAt: new Date("2026-11-01T12:30:00Z") },
      ["clinician_told_in_future"],
    ],
    [
      "a CD report date without a reference",
      { cdReportedOn: "2026-11-01", controlledDrug: "yes" },
      ["cd_report_incomplete"],
    ],
    [
      "a CD report for no controlled drug",
      { cdReportedOn: "2026-11-01", cdReportReference: "CD-1", controlledDrug: "no" },
      ["cd_report_without_cd"],
    ],
  ])("refuses %s", (_, change, problems) => {
    expect(checkMedicationErrorRecord({ ...record, ...change }, now, 5)).toEqual(problems);
  });

  it.each([
    [null, "2", "yes"],
    [null, null, null],
    ["no", "2", "no"],
    ["unsure", null, "unsure"],
  ] as const)(
    "presumes a controlled drug from the schedule (answer %s, schedule %s) as %s",
    (answer, schedule, expected) => {
      expect(presumedControlledDrug(answer, schedule)).toBe(expected);
    },
  );

  it.each<[string, Parameters<typeof medicationErrorPrompts>, string[]]>([
    [
      "a near miss with no harm",
      [answered, { cdReported: false, harmGrade: "none" }],
      ["cqc_through_classifier"],
    ],
    [
      "a CD error not yet reported",
      [
        { ...answered, controlledDrug: "yes" },
        { cdReported: false, harmGrade: "none" },
      ],
      ["controlled_drug_report", "cqc_through_classifier"],
    ],
    [
      "a CD error reported, which clears its prompt",
      [
        { ...answered, controlledDrug: "yes" },
        { cdReported: true, harmGrade: "none" },
      ],
      ["cqc_through_classifier"],
    ],
    [
      "an error that reached the person with moderate harm",
      [
        { ...answered, reachedPerson: "yes" },
        { cdReported: false, harmGrade: "moderate" },
      ],
      ["clinical_advice", "safeguarding_consideration", "cqc_through_classifier"],
    ],
    [
      "an error that reached the person, harm not yet graded",
      [
        { ...answered, reachedPerson: "yes" },
        { cdReported: false, harmGrade: null },
      ],
      ["clinical_advice", "safeguarding_consideration", "cqc_through_classifier"],
    ],
    [
      "an error that reached the person with low harm",
      [
        { ...answered, reachedPerson: "yes" },
        { cdReported: false, harmGrade: "low" },
      ],
      ["clinical_advice", "cqc_through_classifier"],
    ],
    [
      "a repeated error, never prompted twice",
      [
        { ...answered, reachedPerson: "yes", deliberateOrRepeated: "yes" },
        { cdReported: false, harmGrade: "severe" },
      ],
      ["clinical_advice", "safeguarding_consideration", "cqc_through_classifier"],
    ],
  ])("prompts for %s, sending nothing", (_, args, prompts) => {
    expect(medicationErrorPrompts(...args).map((p) => p.prompt)).toEqual(prompts);
  });

  it("counts errors and near misses by month, kind and stage, months in order", () => {
    expect(
      medicationErrorTrend([
        { month: "2026-10", kinds: ["wrong_time"], stage: "administration", reachedPerson: "yes" },
        { month: "2026-09", kinds: ["omitted_dose"], stage: null, reachedPerson: "unsure" },
        {
          month: "2026-10",
          kinds: ["wrong_time", "wrong_dose"],
          stage: "administration",
          reachedPerson: "no",
        },
      ]),
    ).toEqual([
      { month: "2026-09", errors: 1, nearMisses: 0, byKind: { omitted_dose: 1 }, byStage: {} },
      {
        month: "2026-10",
        errors: 1,
        nearMisses: 1,
        byKind: { wrong_time: 2, wrong_dose: 1 },
        byStage: { administration: 2 },
      },
    ]);
  });
});
