import { describe, expect, it } from "vitest";
import { type MedicationErrorAnswers, medicationErrorTriage } from "./medication-error";

const answered: MedicationErrorAnswers = {
  kinds: ["wrong_time"],
  reachedPerson: "no",
  controlledDrug: "no",
  deliberateOrRepeated: "no",
};

describe("medication errors and near misses (safety.md Phase 2 rule 7)", () => {
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

  it("asks every open question and errs towards advice while they are open", () => {
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
    expect(triage.tasks.map((t) => t.task)).toEqual(["clinical_advice"]);
  });
});
