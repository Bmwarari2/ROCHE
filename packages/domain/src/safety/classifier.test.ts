import { describe, expect, it } from "vitest";
import { tableBankHolidays, tableSafetyRates } from "../../test/rate-table";
import { addUkDays, formatUkTime } from "../shared/time";
import { workingDaysDeadline } from "../shared/working-days";
import {
  CLASSIFIER_VERSION,
  type ClassifierInput,
  type ClassifierResult,
  classifyIncident,
} from "./classifier";
import type { IncidentFacts, IncidentPersonFacts, IncidentType } from "./incident";
import {
  NOTIFICATION_KINDS,
  notificationClockState,
  STATUTORY_NOTIFICATION_KINDS,
  type StatutoryNotificationKind,
} from "./notifications";
import { detectOutbreaks } from "./outbreak";
import {
  CLASSIFIER_QUESTION_KEYS,
  CLASSIFIER_QUESTIONS,
  type ClassifierAnswerValue,
  type ClassifierQuestionKey,
  classifierAnswerProblem,
} from "./questions";

/**
 * The incident classifier (safety.md section 4 rules 1 to 12). Hazard HZ-013: statutory
 * notification missed or late. Figures come from docs/specs/rates.md and bank holidays from
 * docs/specs/calendar.md. Invented people only; references are opaque ids.
 */

const rates = tableSafetyRates();
const ENGLAND = tableBankHolidays("england");
/** Wednesday 14 October 2026, 14:30 BST. */
const OCCURRED = new Date("2026-10-14T13:30:00Z");

type AnswerMap = Partial<Record<ClassifierQuestionKey, ClassifierAnswerValue>>;

const resident = (o: Partial<IncidentPersonFacts> = {}): IncidentPersonFacts => ({
  ref: "person-ada",
  kind: "service_user",
  role: "affected",
  aged18OrOver: true,
  ...o,
});
const otherResident = resident({ ref: "person-bea", role: "involved" });
const worker = (o: Partial<IncidentPersonFacts> = {}): IncidentPersonFacts => ({
  ref: "staff-cal",
  kind: "worker",
  role: "affected",
  ...o,
});

const NO_HARM: AnswerMap = {
  "harm.impairment_days": 0,
  "harm.body_structure_changed": "no",
  "harm.pain_days": 0,
  "harm.psychological_harm_days": 0,
  "harm.life_expectancy_shortened": "no",
  "harm.treatment_to_prevent": "no",
};
const NOTHING_TO_REPORT: AnswerMap = {
  ...NO_HARM,
  "candour.unintended_or_unexpected": "no",
  "safeguarding.concern": "no",
  "police.involved": "no",
  "riddor.work_connected": "no",
};
const NO_FALL_RISKS: AnswerMap = { "falls.head_injury": "no", "falls.anticoagulant": "no" };

interface Scenario {
  readonly type: IncidentType;
  readonly people: readonly IncidentPersonFacts[];
  readonly answers: AnswerMap;
  readonly extra?: Partial<ClassifierInput>;
}

function input(s: Scenario, occurredAt = OCCURRED): ClassifierInput {
  const facts: IncidentFacts = { type: s.type, occurredAt, nation: "england", people: s.people };
  return {
    facts,
    answers: Object.entries(s.answers).map(([key, value]) => ({
      key: key as ClassifierQuestionKey,
      value: value as ClassifierAnswerValue,
      answeredAt: new Date(occurredAt.getTime() + 3_600_000),
      answeredBy: "staff-manager",
    })),
    rates,
    holidays: ENGLAND,
    ...s.extra,
  };
}

const run = (s: Scenario, occurredAt = OCCURRED) => classifyIncident(input(s, occurredAt));
const kindsOf = (r: ClassifierResult) => r.outputs.map((o) => o.kind).sort();
const output = (r: ClassifierResult, kind: StatutoryNotificationKind) =>
  r.outputs.find((o) => o.kind === kind);
const exclusion = (r: ClassifierResult, kind: StatutoryNotificationKind) =>
  r.exclusions.find((e) => e.kind === kind)?.reason ?? "";

const twoAriCases = detectOutbreaks(
  [
    {
      ref: "obs-1",
      syndrome: "acute_respiratory",
      onsetAt: new Date("2026-10-10T08:00:00Z"),
      couldBeLinkedWithinSetting: true,
    },
    {
      ref: "obs-2",
      syndrome: "acute_respiratory",
      onsetAt: new Date("2026-10-13T08:00:00Z"),
      couldBeLinkedWithinSetting: null,
    },
  ],
  rates,
);

const S = {
  expectedDeathLd: {
    type: "injury",
    people: [resident({ died: true, learningDisability: true })],
    answers: { ...NOTHING_TO_REPORT, "candour.death_related_to_incident": "no" },
  },
  fatalHoistFall: {
    type: "fall",
    people: [resident({ died: true })],
    answers: {
      ...NO_HARM,
      ...NO_FALL_RISKS,
      "candour.unintended_or_unexpected": "yes",
      "candour.death_related_to_incident": "yes",
      "safeguarding.concern": "no",
      "police.involved": "no",
      "riddor.work_connected": "yes",
      "riddor.excluded_cause": "none",
      "riddor.dangerous_occurrence": "no",
    },
  },
  ownConditionFracture: {
    type: "fall",
    people: [resident()],
    answers: {
      "harm.impairment_days": 60,
      "harm.body_structure_changed": "yes",
      "harm.pain_days": 42,
      "harm.psychological_harm_days": 0,
      "harm.life_expectancy_shortened": "no",
      "harm.treatment_to_prevent": "yes",
      "candour.unintended_or_unexpected": "yes",
      "safeguarding.concern": "no",
      "police.involved": "no",
      "riddor.work_connected": "no",
      "falls.head_injury": "no",
      "falls.anticoagulant": "yes",
    },
  },
  damagedCarpet: {
    type: "fall",
    people: [resident()],
    answers: {
      ...NO_FALL_RISKS,
      "harm.impairment_days": 10,
      "harm.body_structure_changed": "no",
      "harm.pain_days": 10,
      "harm.psychological_harm_days": 0,
      "harm.life_expectancy_shortened": "no",
      "harm.treatment_to_prevent": "yes",
      "candour.unintended_or_unexpected": "yes",
      "safeguarding.concern": "no",
      "police.involved": "no",
      "riddor.work_connected": "yes",
      "riddor.excluded_cause": "none",
      "riddor.non_worker_to_hospital": "yes",
      "riddor.dangerous_occurrence": "no",
    },
  },
  workerFracture: {
    type: "staff_injury",
    people: [worker(), otherResident],
    answers: {
      "riddor.work_connected": "yes",
      "riddor.worker_specified_injury": ["fracture"],
      "riddor.worker_incapacity_days": 10,
      "riddor.dangerous_occurrence": "no",
      "police.involved": "no",
      "safeguarding.concern": "no",
    },
  },
  workerShortAbsence: {
    type: "staff_injury",
    people: [worker()],
    answers: {
      "riddor.work_connected": "yes",
      "riddor.worker_specified_injury": ["none"],
      "riddor.worker_incapacity_days": 5,
      "riddor.dangerous_occurrence": "no",
      "police.involved": "no",
    },
  },
  assaultOnWorker: {
    type: "violence_to_staff",
    people: [worker(), otherResident],
    answers: {
      "riddor.work_connected": "yes",
      "riddor.worker_specified_injury": ["loss_of_consciousness"],
      "riddor.worker_incapacity_days": 3,
      "police.involved": "yes",
      "safeguarding.concern": "no",
    },
  },
  financialAbuse: {
    type: "safeguarding_concern",
    people: [resident()],
    answers: {
      ...NOTHING_TO_REPORT,
      "safeguarding.concern": "yes",
      "safeguarding.types": ["financial_or_material"],
      "police.involved": "yes",
    },
  },
  selfNeglect: {
    type: "safeguarding_concern",
    people: [resident()],
    answers: {
      ...NOTHING_TO_REPORT,
      "safeguarding.concern": "yes",
      "safeguarding.types": ["self_neglect"],
    },
  },
  powerCut: {
    type: "environmental",
    people: [],
    answers: {
      "service.threatens_safe_running": "no",
      "service.insufficient_staff": "no",
      "service.utility_interruption_hours": rates.reg18InterruptionHours + 6,
      "service.premises_damage": "no",
      "service.safety_device_failure_hours": 0,
      "police.involved": "no",
      "riddor.work_connected": "no",
    },
  },
  shortPowerCut: {
    type: "environmental",
    people: [],
    answers: {
      "service.threatens_safe_running": "no",
      "service.insufficient_staff": "no",
      "service.utility_interruption_hours": rates.reg18InterruptionHours,
      "service.premises_damage": "no",
      "service.safety_device_failure_hours": 0,
      "police.involved": "no",
      "riddor.work_connected": "no",
    },
  },
  fireAlarmFailure: {
    type: "environmental",
    people: [],
    answers: {
      "service.threatens_safe_running": "no",
      "service.insufficient_staff": "no",
      "service.utility_interruption_hours": 0,
      "service.premises_damage": "no",
      "service.safety_device_failure_hours": rates.reg18InterruptionHours + 1,
      "police.involved": "no",
      "riddor.work_connected": "no",
    },
  },
  missingUnderDols: {
    type: "missing_person",
    people: [resident({ subjectToDols: true })],
    answers: {
      ...NO_HARM,
      "candour.unintended_or_unexpected": "no",
      "safeguarding.concern": "no",
      "riddor.work_connected": "no",
    },
  },
  missingNotReported: {
    type: "missing_person",
    people: [resident()],
    answers: NOTHING_TO_REPORT,
  },
  abscondingUnderMha: {
    type: "absconding",
    people: [resident({ subjectToMentalHealthAct: true })],
    answers: { ...NOTHING_TO_REPORT, "police.involved": "yes" },
  },
  medicationPsychologicalHarm: {
    type: "medication",
    people: [resident()],
    answers: {
      ...NOTHING_TO_REPORT,
      "harm.psychological_harm_days": rates.reg18ProlongedHarmDays,
      "candour.unintended_or_unexpected": "yes",
    },
  },
  hoistCollapse: {
    type: "near_miss",
    people: [],
    answers: {
      "riddor.work_connected": "yes",
      "riddor.dangerous_occurrence": "yes",
      "police.involved": "no",
    },
  },
  selfHarmHospital: {
    type: "self_harm",
    people: [resident()],
    answers: {
      ...NOTHING_TO_REPORT,
      "harm.pain_days": 3,
      "harm.psychological_harm_days": 10,
      "harm.treatment_to_prevent": "yes",
      "riddor.work_connected": "yes",
      "riddor.non_worker_to_hospital": "yes",
    },
  },
  residentAssault: {
    type: "behaviour",
    people: [resident(), otherResident],
    answers: {
      ...NOTHING_TO_REPORT,
      "harm.pain_days": 5,
      "harm.treatment_to_prevent": "yes",
      "safeguarding.concern": "yes",
      "safeguarding.types": ["physical"],
      "riddor.work_connected": "yes",
      "riddor.excluded_cause": "violence_to_person_not_at_work",
      "riddor.non_worker_to_hospital": "yes",
    },
  },
  respiratoryOutbreak: {
    type: "ipc",
    people: [resident()],
    answers: {
      ...NOTHING_TO_REPORT,
      "service.threatens_safe_running": "no",
      "service.insufficient_staff": "no",
      "service.utility_interruption_hours": 0,
      "service.premises_damage": "no",
      "service.safety_device_failure_hours": 0,
    },
    extra: { outbreak: twoAriCases },
  },
  dataBreach: { type: "data_breach", people: [], answers: { "police.involved": "no" } },
} satisfies Record<string, Scenario>;

describe("hazard HZ-013 classifier produces the required notifications for each incident scenario", () => {
  it.each<[keyof typeof S, StatutoryNotificationKind[]]>([
    ["expectedDeathLd", ["cqc_reg16_death", "leder", "medical_examiner"]],
    ["fatalHoistFall", ["candour", "cqc_reg16_death", "medical_examiner", "riddor_death"]],
    ["ownConditionFracture", ["candour", "cqc_reg18_serious_injury"]],
    ["damagedCarpet", ["candour", "cqc_reg18_serious_injury", "riddor_non_worker_hospital"]],
    ["workerFracture", ["riddor_over_7_day", "riddor_specified_injury"]],
    ["workerShortAbsence", []],
    ["assaultOnWorker", ["cqc_reg18_police", "riddor_specified_injury"]],
    ["financialAbuse", ["cqc_reg18_abuse", "safeguarding_s42"]],
    ["selfNeglect", ["safeguarding_s42"]],
    ["powerCut", ["cqc_reg18_service_disruption"]],
    ["shortPowerCut", []],
    ["fireAlarmFailure", ["cqc_reg18_service_disruption"]],
    ["missingUnderDols", ["cqc_reg18_police", "police_missing_person"]],
    ["missingNotReported", ["police_missing_person"]],
    ["abscondingUnderMha", ["cqc_reg18_police", "police_missing_person"]],
    ["medicationPsychologicalHarm", ["candour", "cqc_reg18_serious_injury"]],
    ["hoistCollapse", ["riddor_dangerous_occurrence"]],
    ["selfHarmHospital", ["cqc_reg18_serious_injury"]],
    ["residentAssault", ["cqc_reg18_abuse", "cqc_reg18_serious_injury", "safeguarding_s42"]],
    ["respiratoryOutbreak", ["ukhsa_outbreak"]],
    ["dataBreach", []],
  ])("%s", (name, expected) => {
    const result = run(S[name]);
    expect(result.nationSupported).toBe(true);
    expect(kindsOf(result)).toEqual([...expected].sort());
    expect(result.outputs.every((o) => !o.provisional)).toBe(true);
  });

  it("covers every output kind in at least one scenario, apart from the DoLS outcome (from the register)", () => {
    const seen = new Set(Object.values(S).flatMap((s) => run(s).outputs.map((o) => o.kind)));
    expect(STATUTORY_NOTIFICATION_KINDS.filter((k) => !seen.has(k))).toEqual([
      "cqc_reg18_dols_outcome",
    ]);
  });

  it("accounts for every kind once: required, not required or waiting", () => {
    for (const scenario of Object.values(S)) {
      const r = run(scenario);
      const all = [
        ...r.outputs.map((o) => o.kind),
        ...r.exclusions.map((e) => e.kind),
        ...r.pending.map((p) => p.kind),
      ];
      expect(all.sort()).toEqual([...STATUTORY_NOTIFICATION_KINDS].sort());
      expect(r.reasoning).toHaveLength(STATUTORY_NOTIFICATION_KINDS.length);
      expect(r.classifierVersion).toBe(CLASSIFIER_VERSION);
    }
  });

  it("names the people each output is about", () => {
    expect(output(run(S.expectedDeathLd), "cqc_reg16_death")?.personRefs).toEqual(["person-ada"]);
    expect(output(run(S.workerFracture), "riddor_specified_injury")?.personRefs).toEqual([
      "staff-cal",
    ]);
    expect(output(run(S.financialAbuse), "safeguarding_s42")?.personRefs).toEqual(["person-ada"]);
  });

  it("quotes the regulation's contents where it sets them", () => {
    expect(output(run(S.expectedDeathLd), "cqc_reg16_death")?.requiredContent).toEqual([
      "A description of the circumstances of the death (reg 16(3))",
    ]);
    expect(output(run(S.damagedCarpet), "candour")?.requiredContent.join(" ")).toMatch(
      /An apology \(reg 20\(3\)\(d\)\)/,
    );
  });

  it("cites the regulation on legislation.gov.uk for every statutory output", () => {
    for (const scenario of Object.values(S)) {
      for (const o of run(scenario).outputs) {
        expect(o.sources.length).toBeGreaterThan(0);
        if (NOTIFICATION_KINDS[o.kind].statutory) expect(o.sources[0]?.url).toMatch(/^https:\/\//);
      }
    }
    expect(output(run(S.damagedCarpet), "cqc_reg18_serious_injury")?.sources[0]?.url).toBe(
      "https://www.legislation.gov.uk/uksi/2009/3112/regulation/18",
    );
  });
});

describe("hazard HZ-013 classifier exclusions say why", () => {
  const nearMiss: Scenario = {
    type: "near_miss",
    people: [resident()],
    answers: { "police.involved": "no", "riddor.work_connected": "no" },
  };
  const under18: Scenario = {
    type: "injury",
    people: [resident({ died: true, autistic: true, aged18OrOver: false })],
    answers: NOTHING_TO_REPORT,
  };
  const treatmentInjury: Scenario = {
    ...S.damagedCarpet,
    answers: { ...S.damagedCarpet.answers, "riddor.excluded_cause": "medical_treatment" },
  };
  it.each<[StatutoryNotificationKind, Scenario, RegExp]>([
    ["cqc_reg16_death", S.ownConditionFracture, /No person using the service died/],
    [
      "cqc_reg18_serious_injury",
      S.expectedDeathLd,
      /No injury meeting regulation 18\(2\)\(a\) or \(b\)/,
    ],
    ["cqc_reg18_serious_injury", S.powerCut, /No person using the service was affected/],
    ["cqc_reg18_serious_injury", nearMiss, /near miss/],
    ["cqc_reg18_abuse", S.selfNeglect, /not abuse as regulation 18\(5\)\(b\) defines it/],
    ["cqc_reg18_abuse", S.expectedDeathLd, /No abuse or allegation of abuse/],
    ["cqc_reg18_abuse", S.powerCut, /No person using the service is involved/],
    ["cqc_reg18_police", S.financialAbuse, /goes on the abuse or allegation of abuse notification/],
    ["cqc_reg18_police", S.missingNotReported, /The police are not involved/],
    [
      "cqc_reg18_service_disruption",
      S.expectedDeathLd,
      /Not an event that affects the running of the service/,
    ],
    ["cqc_reg18_service_disruption", S.shortPowerCut, /Nothing prevents or threatens/],
    ["cqc_reg18_dols_outcome", S.expectedDeathLd, /DoLS register/],
    ["riddor_death", S.damagedCarpet, /Nobody died/],
    ["riddor_death", S.expectedDeathLd, /own condition/],
    ["riddor_death", S.dataBreach, /No death, injury or dangerous occurrence that RIDDOR covers/],
    ["riddor_specified_injury", S.workerShortAbsence, /No specified injury to a worker/],
    ["riddor_specified_injury", S.expectedDeathLd, /No worker was injured/],
    [
      "riddor_non_worker_hospital",
      S.ownConditionFracture,
      /own condition, with no failing in the premises/,
    ],
    [
      "riddor_non_worker_hospital",
      S.selfHarmHospital,
      /Suicide and deliberate self-harm are not accidents/,
    ],
    ["riddor_non_worker_hospital", S.residentAssault, /violence to a person who is not at work/],
    ["riddor_non_worker_hospital", treatmentInjury, /medical treatment/],
    ["riddor_non_worker_hospital", S.workerFracture, /No person who was not at work was injured/],
    ["riddor_over_7_day", S.workerShortAbsence, /5 consecutive days so far/],
    ["riddor_over_7_day", S.damagedCarpet, /No worker was injured/],
    ["riddor_dangerous_occurrence", S.assaultOnWorker, /^Not a dangerous occurrence\.$/],
    [
      "riddor_dangerous_occurrence",
      S.damagedCarpet,
      /Not a dangerous occurrence listed in RIDDOR Schedule 2/,
    ],
    ["safeguarding_s42", S.expectedDeathLd, /No abuse or neglect/],
    ["safeguarding_s42", S.powerCut, /No person using the service is involved/],
    ["candour", S.expectedDeathLd, /Not a notifiable safety incident under reg 20\(9\)/],
    ["candour", S.workerFracture, /No person using the service was affected/],
    ["candour", nearMiss, /reg 20\(9\) applies only where harm appears to have resulted/],
    ["leder", S.fatalHoistFall, /did not have a learning disability and was not autistic/],
    ["leder", under18, /Child Death Review/],
    ["leder", S.ownConditionFracture, /No person using the service died/],
    ["ukhsa_outbreak", S.expectedDeathLd, /not run with this incident/],
    [
      "ukhsa_outbreak",
      { ...S.powerCut, extra: { outbreak: { signals: [], casesToReviewForLinks: [] } } },
      /No outbreak reporting threshold/,
    ],
    ["medical_examiner", S.ownConditionFracture, /No person using the service died/],
    ["police_missing_person", S.expectedDeathLd, /Not a missing person incident/],
  ])("%s not required: %#", (kind, scenario, reason) => {
    expect(exclusion(run(scenario), kind)).toMatch(reason);
  });
});

describe("hazard HZ-013 RIDDOR asks the work-activity, premises or equipment question first", () => {
  const unanswered: Scenario = { type: "fall", people: [resident()], answers: {} };

  it("asks only the work question until it is answered, and waits for it", () => {
    const r = run(unanswered);
    expect(r.openQuestions).toContain("riddor.work_connected");
    expect(r.openQuestions).not.toContain("riddor.non_worker_to_hospital");
    expect(r.pending.find((p) => p.kind === "riddor_non_worker_hospital")?.waitingFor).toContain(
      "riddor.work_connected",
    );
  });

  it("then asks the follow-up questions when the answer is yes", () => {
    const r = run({ ...unanswered, answers: { "riddor.work_connected": "yes" } });
    expect(r.openQuestions).toEqual(
      expect.arrayContaining([
        "riddor.excluded_cause",
        "riddor.non_worker_to_hospital",
        "riddor.dangerous_occurrence",
      ]),
    );
  });

  it("records the reasoning when a fall arose from the person's own condition", () => {
    const r = run(S.ownConditionFracture);
    for (const kind of ["riddor_non_worker_hospital", "riddor_dangerous_occurrence"] as const) {
      expect(exclusion(r, kind)).toMatch(
        /arose from the person's own condition, with no failing in the premises, the equipment or the way work was done/,
      );
    }
    expect(r.reasoning.find((line) => line.startsWith("riddor_non_worker_hospital"))).toMatch(
      /not required/,
    );
    expect(r.openQuestions).not.toContain("riddor.non_worker_to_hospital");
  });

  it("drafts a provisional RIDDOR report when staff are not sure yet", () => {
    const r = run({
      ...S.damagedCarpet,
      answers: { ...S.damagedCarpet.answers, "riddor.work_connected": "unsure" },
    });
    expect(output(r, "riddor_non_worker_hospital")?.provisional).toBe(true);
    expect(output(r, "riddor_non_worker_hospital")?.reasons.join(" ")).toMatch(/Not sure yet/);
  });

  it("treats a worker hurt while helping a resident who self-harmed as an accident at work", () => {
    const r = run({
      type: "self_harm",
      people: [worker(), resident()],
      answers: {
        ...NOTHING_TO_REPORT,
        "riddor.work_connected": "yes",
        "riddor.worker_specified_injury": ["fracture"],
        "riddor.worker_incapacity_days": 2,
        "riddor.non_worker_to_hospital": "yes",
      },
    });
    expect(kindsOf(r)).toEqual(["riddor_specified_injury"]);
    expect(exclusion(r, "riddor_non_worker_hospital")).toMatch(/self-harm/);
  });

  it("excludes a worker's self-harm only when it is answered", () => {
    const r = run({
      ...S.workerFracture,
      answers: { ...S.workerFracture.answers, "riddor.excluded_cause": "suicide_or_self_harm" },
    });
    expect(exclusion(r, "riddor_specified_injury")).toMatch(/Suicide and deliberate self-harm/);
  });
});

describe("hazard HZ-013 harm thresholds come from the rate table", () => {
  const harm = (
    days: number,
    key: "harm.pain_days" | "harm.psychological_harm_days" | "harm.impairment_days",
  ) =>
    run({
      type: "medication",
      people: [resident()],
      answers: { ...NOTHING_TO_REPORT, [key]: days, "candour.unintended_or_unexpected": "yes" },
    });
  it.each(["harm.pain_days", "harm.psychological_harm_days", "harm.impairment_days"] as const)(
    "%s: one day under the threshold is not notifiable; the threshold is",
    (key) => {
      expect(kindsOf(harm(rates.candourProlongedHarmDays - 1, key))).toEqual([]);
      expect(kindsOf(harm(rates.candourProlongedHarmDays, key))).toEqual([
        "candour",
        "cqc_reg18_serious_injury",
      ]);
      expect(kindsOf(harm(rates.reg18ProlongedHarmDays, key))).toContain(
        "cqc_reg18_serious_injury",
      );
    },
  );

  it.each([
    ["harm.body_structure_changed", "(9)(a)(iii)"],
    ["harm.life_expectancy_shortened", "(9)(a)(v)"],
    ["harm.treatment_to_prevent", "(9)(b)"],
  ] as const)("%s makes the incident notifiable under reg 20%s", (key, provision) => {
    const r = run({
      type: "medication",
      people: [resident()],
      answers: { ...NOTHING_TO_REPORT, [key]: "yes", "candour.unintended_or_unexpected": "yes" },
    });
    expect(output(r, "candour")?.reasons.join(" ")).toContain(`reg 20${provision}`);
  });

  it("needs the incident to be unintended or unexpected for candour", () => {
    const r = run({
      type: "medication",
      people: [resident()],
      answers: { ...NOTHING_TO_REPORT, "harm.treatment_to_prevent": "yes" },
    });
    expect(kindsOf(r)).toEqual(["cqc_reg18_serious_injury"]);
  });

  it("follows the recorded threshold decision over the answers", () => {
    const decidedAt = new Date("2026-10-15T09:00:00Z");
    const no = run({
      ...S.damagedCarpet,
      extra: { candourDecision: { notifiable: false, decidedAt } },
    });
    expect(exclusion(no, "candour")).toMatch(/threshold decision recorded/);
    const yes = run({
      ...S.expectedDeathLd,
      extra: { candourDecision: { notifiable: true, decidedAt } },
    });
    expect(output(yes, "candour")?.reasons[0]).toMatch(/threshold decision recorded/);
  });

  it("uses a tenant's own figure when the rate table has one (clock periods are never literals)", () => {
    const shorter = { ...rates, riddorReportDays: rates.riddorReportDays - 3 };
    const r = classifyIncident({ ...input(S.damagedCarpet), rates: shorter });
    const report = output(r, "riddor_non_worker_hospital")?.deadlines.find(
      (d) => d.key === "report_received",
    );
    expect(report?.dueAt).toEqual(addUkDays(OCCURRED, shorter.riddorReportDays));
  });
});

describe("hazard HZ-013 deadline clocks", () => {
  it("makes without-delay kinds due at the event, so they are overdue at once until submitted", () => {
    const r = run(S.financialAbuse);
    const abuse = output(r, "cqc_reg18_abuse");
    expect(abuse?.dueAt).toEqual(OCCURRED);
    expect(abuse?.deadlines[0]?.statutory).toBe(true);
    expect(notificationClockState(OCCURRED, "draft", OCCURRED)).toBe("overdue");
    expect(notificationClockState(OCCURRED, "submitted", OCCURRED)).toBe("done");
    expect(output(r, "safeguarding_s42")?.deadlines[0]?.wording).toMatch(/Harbour sets this/);
  });

  it("starts an offline incident's clock at the recorded event time, not when it synced", () => {
    const offline = input(S.expectedDeathLd);
    const lateAnswers = offline.answers.map((a) => ({ ...a, answeredAt: addUkDays(OCCURRED, 3) }));
    const r = classifyIncident({ ...offline, answers: lateAnswers });
    expect(output(r, "cqc_reg16_death")?.dueAt).toEqual(OCCURRED);
  });

  it.each([
    ["the October clock change", new Date("2026-10-20T14:00:00Z")],
    ["the March clock change", new Date("2027-03-25T10:00:00Z")],
  ])("keeps RIDDOR's UK wall-clock deadlines across %s", (_name, occurredAt) => {
    const r = run(S.damagedCarpet, occurredAt);
    const riddor = output(r, "riddor_non_worker_hospital");
    expect(riddor?.dueAt).toEqual(occurredAt);
    const report = riddor?.deadlines.find((d) => d.key === "report_received")?.dueAt as Date;
    expect(report).toEqual(addUkDays(occurredAt, rates.riddorReportDays));
    expect(formatUkTime(report)).toBe(formatUkTime(occurredAt));
    expect(report.getUTCHours()).not.toBe(occurredAt.getUTCHours());
    const over7 = output(run(S.workerFracture, occurredAt), "riddor_over_7_day");
    expect(over7?.dueAt).toEqual(addUkDays(occurredAt, rates.riddorOver7DayReportDays));
  });

  it("gives candour a written target in working days that skips bank holidays (ADR-0021)", () => {
    const decidedAt = new Date("2026-12-23T10:00:00Z");
    const r = run({
      ...S.damagedCarpet,
      extra: { candourDecision: { notifiable: true, decidedAt } },
    });
    const candour = output(r, "candour");
    const target = candour?.deadlines.find((d) => d.key === "written_notification_target");
    expect(target?.dueAt).toEqual(
      workingDaysDeadline(decidedAt, rates.candourWrittenWorkingDays, ENGLAND),
    );
    expect(target?.dueAt.getTime()).toBeGreaterThan(
      workingDaysDeadline(decidedAt, rates.candourWrittenWorkingDays, new Set()).getTime(),
    );
    expect(target?.statutory).toBe(false);
    expect(target?.wording).toMatch(
      /^Target: written notification within \d+ working days\. The law requires notification as soon as reasonably practicable\.$/,
    );
    expect(candour?.dueAt).toEqual(decidedAt);
  });

  it("runs the candour clock from the incident until a threshold decision is recorded", () => {
    const candour = output(run(S.damagedCarpet), "candour");
    expect(candour?.dueAt).toEqual(OCCURRED);
    expect(candour?.deadlines[1]?.dueAt).toEqual(
      workingDaysDeadline(OCCURRED, rates.candourWrittenWorkingDays, ENGLAND),
    );
  });

  it("starts the outbreak clock when the threshold was reached", () => {
    expect(output(run(S.respiratoryOutbreak), "ukhsa_outbreak")?.dueAt).toEqual(
      new Date("2026-10-13T08:00:00Z"),
    );
  });

  it("notifies RIDDOR deaths, specified injuries and dangerous occurrences without delay", () => {
    for (const [scenario, kind] of [
      [S.fatalHoistFall, "riddor_death"],
      [S.workerFracture, "riddor_specified_injury"],
      [S.hoistCollapse, "riddor_dangerous_occurrence"],
    ] as const) {
      const o = output(run(scenario), kind);
      expect(o?.deadlines.map((d) => d.key)).toEqual(["notify_without_delay", "report_received"]);
      expect(o?.dueAt).toEqual(OCCURRED);
    }
  });
});

describe("hazard HZ-013 open questions, provisional drafts and tasks", () => {
  it("lists the questions that apply and waits for them, with a task to answer them now", () => {
    const r = run({ type: "fall", people: [resident()], answers: {} });
    expect(r.openQuestions).toEqual([
      "harm.impairment_days",
      "harm.body_structure_changed",
      "harm.pain_days",
      "harm.psychological_harm_days",
      "harm.life_expectancy_shortened",
      "harm.treatment_to_prevent",
      "candour.unintended_or_unexpected",
      "safeguarding.concern",
      "police.involved",
      "riddor.work_connected",
      "falls.head_injury",
      "falls.anticoagulant",
    ]);
    expect(r.outputs).toEqual([]);
    expect(r.pending.map((p) => p.kind)).toEqual(
      expect.arrayContaining([
        "cqc_reg18_serious_injury",
        "cqc_reg18_abuse",
        "cqc_reg18_police",
        "candour",
        "safeguarding_s42",
      ]),
    );
    expect(r.tasks.find((t) => t.task === "answer_classifier_questions")?.dueAt).toEqual(OCCURRED);
  });

  it("drafts provisional notifications when a number of days is not known yet", () => {
    const r = run({
      type: "medication",
      people: [resident()],
      answers: {
        ...NOTHING_TO_REPORT,
        "harm.pain_days": "unsure",
        "candour.unintended_or_unexpected": "yes",
      },
    });
    expect(output(r, "cqc_reg18_serious_injury")?.provisional).toBe(true);
    expect(output(r, "candour")?.provisional).toBe(true);
  });

  it("drafts a provisional notification on an unsure answer", () => {
    const r = run({
      ...S.missingNotReported,
      answers: { ...S.missingNotReported.answers, "police.involved": "unsure" },
    });
    expect(output(r, "cqc_reg18_police")?.provisional).toBe(true);
  });

  it("asks which types of abuse once there is a concern, and ignores answers that fail validation", () => {
    const r = run({
      type: "safeguarding_concern",
      people: [resident()],
      answers: { ...NOTHING_TO_REPORT, "safeguarding.concern": "unsure", "harm.pain_days": -4 },
    });
    expect(r.openQuestions).toEqual(["harm.pain_days", "safeguarding.types"]);
    expect(output(r, "safeguarding_s42")?.provisional).toBe(true);
  });

  it("uses the latest answer to each question", () => {
    const base = input(S.financialAbuse);
    const later = {
      key: "safeguarding.concern" as const,
      value: "no",
      answeredAt: addUkDays(OCCURRED, 1),
      answeredBy: "staff-manager",
    };
    // With no abuse alleged, police involvement needs its own notification again.
    expect(kindsOf(classifyIncident({ ...base, answers: [...base.answers, later] }))).toEqual([
      "cqc_reg18_police",
    ]);
  });

  it.each<[string, Scenario, string[]]>([
    [
      "a fall without head injury or anticoagulants",
      S.damagedCarpet,
      [
        "post_fall_injury_check",
        "post_fall_monitoring",
        "gp_contact",
        "ng249_falls_pathway",
        "bone_health_review",
        "candour_threshold_decision",
      ],
    ],
    [
      "a fall on anticoagulants",
      S.ownConditionFracture,
      [
        "post_fall_injury_check",
        "urgent_medical_advice",
        "post_fall_observations",
        "gp_contact",
        "ng249_falls_pathway",
        "bone_health_review",
        "candour_threshold_decision",
      ],
    ],
    [
      "a missing person",
      S.missingNotReported,
      ["herbert_protocol_to_police", "missing_person_search_log", "return_welfare_check"],
    ],
    ["a death", S.expectedDeathLd, ["medical_examiner_pack"]],
    ["a worker off for a few days", S.workerShortAbsence, ["riddor_absence_check"]],
  ])("raises the tasks for %s", (_name, scenario, tasks) => {
    expect(
      run(scenario)
        .tasks.map((t) => t.task)
        .sort(),
    ).toEqual([...tasks].sort());
  });

  it("checks a worker's absence the day after the RIDDOR threshold passes", () => {
    const check = run(S.workerShortAbsence).tasks.find((t) => t.task === "riddor_absence_check");
    expect(check?.dueAt).toEqual(addUkDays(OCCURRED, rates.riddorOver7DayThresholdDays + 1));
  });

  it.each<[string, IncidentPersonFacts["pressureUlcers"], AnswerMap, boolean]>([
    ["category 3", ["category_3"], {}, true],
    ["category 4", ["category_4"], {}, true],
    ["unstageable", ["unstageable"], {}, true],
    ["deep tissue injury", ["deep_tissue_injury"], {}, true],
    ["multiple category 2", ["category_2", "category_2"], {}, true],
    [
      "a single category 2 with a neglect concern",
      ["category_2"],
      { "pressure_ulcer.neglect_concern": "yes" },
      true,
    ],
    [
      "a single category 2 with severe impact",
      ["category_2"],
      { "pressure_ulcer.severe_impact": "unsure" },
      true,
    ],
    [
      "a single category 2 with no concern",
      ["category_2"],
      { "pressure_ulcer.neglect_concern": "no", "pressure_ulcer.severe_impact": "no" },
      false,
    ],
    ["category 1", ["category_1"], {}, false],
  ])("runs the safeguarding decision guide for %s", (_name, ulcers, answers, guide) => {
    const r = run({
      type: "skin",
      people: [resident({ pressureUlcers: ulcers })],
      answers: { ...NOTHING_TO_REPORT, ...answers },
    });
    const task = r.tasks.find((t) => t.task === "safeguarding_decision_guide");
    expect(Boolean(task)).toBe(guide);
    if (task)
      expect(task.dueAt?.getTime()).toBe(
        OCCURRED.getTime() + rates.pressureUlcerDecisionGuideHours * 3_600_000,
      );
  });

  it("asks the pressure ulcer questions for a single category 2", () => {
    const r = run({
      type: "skin",
      people: [resident({ pressureUlcers: ["category_2"] })],
      answers: NOTHING_TO_REPORT,
    });
    expect(r.openQuestions).toEqual([
      "pressure_ulcer.neglect_concern",
      "pressure_ulcer.severe_impact",
    ]);
  });

  it("asks staff to decide whether unreviewed diarrhoea and vomiting cases are linked", () => {
    const outbreak = detectOutbreaks(
      [
        {
          ref: "obs-1",
          syndrome: "diarrhoea_vomiting",
          onsetAt: OCCURRED,
          couldBeLinkedWithinSetting: null,
          link: null,
        },
        {
          ref: "obs-2",
          syndrome: "diarrhoea_vomiting",
          onsetAt: OCCURRED,
          couldBeLinkedWithinSetting: null,
          link: null,
        },
      ],
      rates,
    );
    const r = run({ ...S.respiratoryOutbreak, extra: { outbreak } });
    expect(r.tasks.map((t) => t.task)).toContain("outbreak_link_review");
  });
});

describe("hazard HZ-013 nations and questions", () => {
  it.each(["wales", "scotland", "northern_ireland"] as const)(
    "does not pretend to check %s before its nation pack",
    (nation) => {
      const base = input(S.financialAbuse);
      const r = classifyIncident({ ...base, facts: { ...base.facts, nation } });
      expect(r).toMatchObject({ nationSupported: false, outputs: [], exclusions: [], tasks: [] });
      expect(r.reasoning[0]).toMatch(/Phase 7/);
    },
  );

  it("has wording, a kind and a source for every question key", () => {
    for (const key of CLASSIFIER_QUESTION_KEYS) {
      const q = CLASSIFIER_QUESTIONS[key];
      expect(q.key).toBe(key);
      expect(q.text).not.toBe("");
      expect(q.sources.length).toBeGreaterThan(0);
      if (q.kind === "choice" || q.kind === "choices" || q.kind === "yes_no_unsure")
        expect(q.options.length).toBeGreaterThan(1);
    }
  });

  it("puts no statutory figure in a question's wording, except where quoting a regulation's list", () => {
    for (const key of CLASSIFIER_QUESTION_KEYS) {
      expect(CLASSIFIER_QUESTIONS[key].text).not.toMatch(/\b(7|10|15|24|28|48)\b/);
    }
  });

  it.each<[ClassifierQuestionKey, ClassifierAnswerValue, boolean]>([
    ["police.involved", "yes", true],
    ["police.involved", "unsure", true],
    ["police.involved", "maybe", false],
    ["harm.pain_days", 0, true],
    ["harm.pain_days", 2.5, false],
    ["harm.pain_days", -1, false],
    ["service.utility_interruption_hours", "unsure", true],
    ["riddor.excluded_cause", "none", true],
    ["riddor.excluded_cause", "weather", false],
    ["safeguarding.types", ["physical", "neglect"], true],
    ["safeguarding.types", [], false],
    ["safeguarding.types", ["physical", "physical"], false],
    ["riddor.worker_specified_injury", ["none", "fracture"], false],
    ["riddor.worker_specified_injury", ["none"], true],
  ])("%s accepts %j: %s", (key, value, ok) => {
    expect(classifierAnswerProblem(key, value) === null).toBe(ok);
  });
});
