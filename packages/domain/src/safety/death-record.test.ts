import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import { addUkDays } from "../shared/time";
import {
  currentDeathStepEntry,
  DEATH_CORRECTION_REASON_MAX,
  DEATH_CORRECTION_REASON_MIN,
  DEATH_REASON_MIN,
  type DeathRecordFacts,
  deathRecordPlan,
  deathRecordView,
  deathReviewProblems,
  deathStepCorrectionProblems,
  deathStepProblems,
  type RecordedDeathStep,
} from "./death-record";
import { resolveSafetyPhase2Rates } from "./phase2-rates";

const rates = resolveSafetyPhase2Rates(readRateTable(), "england", "2026-10-31", null);
const DIED = new Date("2026-10-25T01:30:00Z");
const NOW = new Date("2026-10-26T09:00:00Z");
const judged: DeathRecordFacts = {
  diedAt: DIED,
  expected: true,
  possiblyUnnatural: false,
  learningDisabilityOrAutism: false,
};
const noReview = { findings: null, lessons: null, reviewedAt: null };
const done = (step: RecordedDeathStep["step"], at = NOW): RecordedDeathStep => ({
  step,
  outcome: "done",
  at,
});
const enough = "x".repeat(DEATH_REASON_MIN);

describe("hazard HZ-013 the death record (slice 37)", () => {
  it("assumes an unexpected death that may be unnatural until the clinician's judgement is recorded", () => {
    const unknown = { ...judged, expected: null, possiblyUnnatural: null };
    const view = deathRecordView({
      facts: unknown,
      recorded: [],
      notifications: {},
      review: noReview,
      now: NOW,
      rates,
    });
    expect(view.plan.steps).toContain("police_informed");
    expect(view.plan.steps).toContain("preserve_room_and_equipment");
    expect(view.missingFacts).toEqual(["expected", "possiblyUnnatural"]);
    expect(view.closeProblems.slice(0, 2)).toEqual([
      "Record whether the death was expected, in the clinician's judgement.",
      "Record whether the cause may be unnatural or the circumstances suspicious, in the clinician's judgement.",
    ]);
    // An expected death judged natural needs no police steps.
    expect(deathRecordPlan(judged, rates).steps).not.toContain("police_informed");
  });

  it.each([
    ["submitted", "done"],
    ["not_required", "done"],
    ["draft", "waiting"],
    ["ready", "waiting"],
  ] as const)(
    "follows the notification centre: a regulator's notification %s is %s",
    (status, state) => {
      const view = deathRecordView({
        facts: judged,
        recorded: [],
        notifications: { cqc_reg16_death: status },
        review: noReview,
        now: NOW,
        rates,
      });
      const step = view.steps.find((s) => s.step === "cqc_reg16_notification");
      expect(step).toMatchObject({ state, notificationStatus: status });
    },
  );

  it("never counts a notification step done on a tick here, and says when none was drafted", () => {
    const view = deathRecordView({
      facts: judged,
      recorded: [{ step: "medical_examiner_pack", outcome: "done", at: NOW }],
      notifications: {},
      review: noReview,
      now: NOW,
      rates,
    });
    expect(view.steps.find((s) => s.step === "medical_examiner_pack")?.state).toBe("outstanding");
    expect(
      deathStepProblems(
        view.plan,
        DIED,
        { step: "medical_examiner_pack", outcome: "done", at: NOW, note: null },
        NOW,
      ),
    ).toEqual([
      "This step is settled in the notification centre: submit the notification there, or decide there that it is not required.",
    ]);
  });

  it.each(["medical_examiner_pack", "cqc_reg16_notification", "leder_notification"] as const)(
    "hazard HZ-013 never marks %s not needed on the death record (H-950)",
    (step) => {
      const ld = deathRecordView({
        facts: { ...judged, learningDisabilityOrAutism: true },
        recorded: [],
        notifications: {},
        review: noReview,
        now: NOW,
        rates,
      });
      const enough = "The person died in hospital, so the hospital notifies.";
      expect(
        deathStepProblems(
          ld.plan,
          DIED,
          { step, outcome: "not_needed", at: NOW, note: enough },
          NOW,
        ),
      ).toEqual([
        "This step is settled in the notification centre: submit the notification there, or decide there that it is not required.",
      ]);
      // A "not needed" recorded here earlier never settles it: only the notification does.
      const earlier = deathRecordView({
        facts: { ...judged, learningDisabilityOrAutism: true },
        recorded: [{ step, outcome: "not_needed", at: NOW }],
        notifications: {},
        review: noReview,
        now: NOW,
        rates,
      });
      expect(earlier.steps.find((s) => s.step === step)?.state).toBe("outstanding");
      expect(earlier.closeProblems.some((p) => p.includes("notification centre"))).toBe(true);
    },
  );

  it("closes only with every step done or not needed and the review recorded", () => {
    const all = deathRecordView({
      facts: judged,
      recorded: [done("verification_of_death"), done("family_informed")],
      notifications: { cqc_reg16_death: "submitted", medical_examiner: "submitted" },
      review: { findings: enough, lessons: enough, reviewedAt: NOW },
      now: NOW,
      rates,
    });
    expect(all.closeProblems).toEqual([]);
    const without = deathRecordView({
      facts: judged,
      recorded: [done("verification_of_death")],
      notifications: { cqc_reg16_death: "draft" },
      review: noReview,
      now: NOW,
      rates,
    });
    expect(without.closeProblems).toEqual([
      "Record telling the family, or why it is not needed.",
      "Submit the medical examiner information, or decide it is not required, in the notification centre.",
      "Submit the regulator's death notification, or decide it is not required, in the notification centre.",
      "Record the mortality review: its findings and lessons.",
    ]);
  });

  it("the latest record of a step counts", () => {
    const view = deathRecordView({
      facts: judged,
      recorded: [
        { step: "family_informed", outcome: "not_needed", at: NOW },
        { step: "family_informed", outcome: "done", at: NOW },
      ],
      notifications: {},
      review: noReview,
      now: NOW,
      rates,
    });
    expect(view.steps.find((s) => s.step === "family_informed")?.state).toBe("done");
  });

  it("dates the mortality review from the rate table and says when it is overdue", () => {
    const due = addUkDays(DIED, rates.mortalityReviewDueDays);
    const at = (now: Date) =>
      deathRecordView({
        facts: judged,
        recorded: [],
        notifications: {},
        review: noReview,
        now,
        rates,
      });
    expect(at(NOW).reviewDueAt).toEqual(due);
    expect(at(due).reviewOverdue).toBe(false);
    expect(at(new Date(due.getTime() + 60_000)).reviewOverdue).toBe(true);
  });

  it.each<[string, Parameters<typeof deathStepProblems>[2], string[]]>([
    ["a step done", { step: "family_informed", outcome: "done", at: NOW, note: null }, []],
    [
      "not needed without a reason",
      { step: "family_informed", outcome: "not_needed", at: NOW, note: "No family." },
      [`Say why it is not needed, in at least ${DEATH_REASON_MIN} characters.`],
    ],
    [
      "not needed with a reason",
      { step: "family_informed", outcome: "not_needed", at: NOW, note: enough },
      [],
    ],
    [
      "a step not in the plan",
      { step: "police_informed", outcome: "done", at: NOW, note: null },
      ["This step is not needed for this death as recorded."],
    ],
    [
      "the review as a step",
      { step: "mortality_review", outcome: "done", at: NOW, note: null },
      ["Record the mortality review on its own, with its findings and lessons."],
    ],
    [
      "a time in the future",
      {
        step: "family_informed",
        outcome: "done",
        at: new Date(NOW.getTime() + 60_000),
        note: null,
      },
      ["The time cannot be in the future."],
    ],
    [
      "a time before the death",
      {
        step: "family_informed",
        outcome: "done",
        at: new Date(DIED.getTime() - 60_000),
        note: null,
      },
      ["The time cannot be before the death."],
    ],
  ])("a step: %s", (_name, step, problems) => {
    expect(deathStepProblems(deathRecordPlan(judged, rates), DIED, step, NOW)).toEqual(problems);
  });

  it("the review needs its findings and lessons", () => {
    expect(deathReviewProblems({ findings: null, lessons: "short" })).toHaveLength(2);
    expect(deathReviewProblems({ findings: enough, lessons: enough })).toEqual([]);
    expect(
      deathReviewProblems({ findings: `  ${"x".repeat(DEATH_REASON_MIN - 1)} `, lessons: enough }),
    ).toHaveLength(1);
  });
});

describe("hazard HZ-013 the police steps stand until the clinician's judgement (slice 63)", () => {
  const unjudged: DeathRecordFacts = {
    diedAt: DIED,
    expected: null,
    possiblyUnnatural: null,
    learningDisabilityOrAutism: false,
  };
  const refused =
    "The clinician's judgement is not recorded yet, so this police step cannot be marked not needed. Record the judgement first.";
  it.each<[string, DeathRecordFacts, Parameters<typeof deathStepProblems>[2], string[]]>([
    [
      "police told, not needed, no judgement",
      unjudged,
      { step: "police_informed", outcome: "not_needed", at: NOW, note: enough },
      [refused],
    ],
    [
      "room left, not needed, no judgement",
      unjudged,
      { step: "preserve_room_and_equipment", outcome: "not_needed", at: NOW, note: enough },
      [refused],
    ],
    [
      "police told, done, no judgement",
      unjudged,
      { step: "police_informed", outcome: "done", at: NOW, note: null },
      [],
    ],
    [
      "police told, not needed, expected only",
      { ...unjudged, expected: true },
      { step: "police_informed", outcome: "not_needed", at: NOW, note: enough },
      [refused],
    ],
    [
      "another step, not needed, no judgement",
      unjudged,
      { step: "family_informed", outcome: "not_needed", at: NOW, note: enough },
      [],
    ],
    [
      "police told, not needed, judged may be unnatural",
      { ...unjudged, expected: false, possiblyUnnatural: true },
      { step: "police_informed", outcome: "not_needed", at: NOW, note: enough },
      [
        "The clinician judged this death may be unnatural or suspicious, so this police step cannot be marked not needed.",
      ],
    ],
  ])("%s", (_name, facts, step, problems) => {
    expect(
      deathStepProblems(deathRecordPlan(facts, rates), DIED, step, NOW, {
        expected: facts.expected,
        possiblyUnnatural: facts.possiblyUnnatural,
      }),
    ).toEqual(problems);
  });
});

describe("hazard HZ-013 a recorded step is corrected by a new entry, never changed (section 5.5)", () => {
  const A = "0199f000-0000-7000-8000-00000000d001";
  const B = "0199f000-0000-7000-8000-00000000d002";
  const reason = "Recorded against the wrong time.";

  it.each([
    ["a first entry", null, { supersedesId: null, correctionReason: null }, []],
    [
      "a correction of nothing",
      null,
      { supersedesId: A, correctionReason: reason },
      ["This step is not recorded yet, so there is nothing to correct."],
    ],
    [
      "a second entry without naming the first",
      { id: A },
      { supersedesId: null, correctionReason: null },
      [
        "This step is already recorded: correct the entry that stands, saying why.",
        `Say why it is corrected, in ${DEATH_CORRECTION_REASON_MIN} to ${DEATH_CORRECTION_REASON_MAX} characters.`,
      ],
    ],
    [
      "a correction of an entry that no longer stands",
      { id: B },
      { supersedesId: A, correctionReason: reason },
      ["This step is already recorded: correct the entry that stands, saying why."],
    ],
    [
      "a correction without a reason",
      { id: A },
      { supersedesId: A, correctionReason: "Wrong." },
      [
        `Say why it is corrected, in ${DEATH_CORRECTION_REASON_MIN} to ${DEATH_CORRECTION_REASON_MAX} characters.`,
      ],
    ],
    ["a correction with its reason", { id: A }, { supersedesId: A, correctionReason: reason }, []],
  ] as const)("%s", (_, current, input, problems) => {
    expect(deathStepCorrectionProblems(current, input)).toEqual(problems);
  });

  it("finds the entry that stands for a step", () => {
    const entries = [
      { id: A, step: "police_informed", supersedesId: null },
      { id: B, step: "police_informed", supersedesId: A },
      { id: "c", step: "family_informed", supersedesId: null },
    ];
    expect(currentDeathStepEntry(entries, "police_informed")?.id).toBe(B);
    expect(currentDeathStepEntry(entries, "family_informed")?.id).toBe("c");
    expect(currentDeathStepEntry(entries, "preserve_room_and_equipment")).toBeNull();
  });
});
