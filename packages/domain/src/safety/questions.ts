/**
 * The classifier's question set (safety.md sections 2 and 4; SAFE-002). Each question has a stable
 * key that the API stores in `classifier_answer` (append-only; the latest answer per key counts).
 * Wording that quotes a regulation uses its words. Questions ask for numbers of days or hours
 * rather than "28 days or more?" so that every threshold comes from the rate table.
 *
 * Opinions about harm are, in the regulations' words, "in the reasonable opinion of a health care
 * professional": staff record the opinion of the GP, nurse or paramedic, or answer "unsure".
 */

import { type Citation, cite, SOURCES } from "../shared/citation";

export const CLASSIFIER_QUESTION_KEYS = [
  "harm.impairment_days",
  "harm.body_structure_changed",
  "harm.pain_days",
  "harm.psychological_harm_days",
  "harm.life_expectancy_shortened",
  "harm.treatment_to_prevent",
  "candour.unintended_or_unexpected",
  "candour.death_related_to_incident",
  "safeguarding.concern",
  "safeguarding.types",
  "pressure_ulcer.neglect_concern",
  "pressure_ulcer.severe_impact",
  "police.involved",
  "service.threatens_safe_running",
  "service.insufficient_staff",
  "service.utility_interruption_hours",
  "service.premises_damage",
  "service.safety_device_failure_hours",
  "riddor.work_connected",
  "riddor.excluded_cause",
  "riddor.worker_specified_injury",
  "riddor.worker_incapacity_days",
  "riddor.non_worker_to_hospital",
  "riddor.dangerous_occurrence",
  "falls.head_injury",
  "falls.anticoagulant",
] as const;

export type ClassifierQuestionKey = (typeof CLASSIFIER_QUESTION_KEYS)[number];

export type ClassifierAnswerKind = "yes_no_unsure" | "days" | "hours" | "choice" | "choices";

export interface ClassifierOption {
  readonly value: string;
  readonly label: string;
}

export interface ClassifierQuestion {
  readonly key: ClassifierQuestionKey;
  readonly kind: ClassifierAnswerKind;
  readonly text: string;
  readonly help: string | null;
  readonly options: readonly ClassifierOption[];
  readonly sources: readonly Citation[];
}

/** "unsure" is always allowed: it produces a provisional draft so the clock stays visible. */
export type ClassifierAnswerValue = "yes" | "no" | "unsure" | number | string | readonly string[];

export interface ClassifierAnswer {
  readonly key: ClassifierQuestionKey;
  readonly value: ClassifierAnswerValue;
  readonly answeredAt: Date;
  readonly answeredBy: string;
}

const REG18 = (p: string) => cite("CQC (Registration) Regulations 2009", p, SOURCES.cqcReg18);
const REG20 = (p: string) =>
  cite(
    "Health and Social Care Act 2008 (Regulated Activities) Regulations 2014",
    p,
    SOURCES.candourReg20,
  );
const RIDDOR = (p: string, url: string) => cite("RIDDOR 2013", p, url);
const HSIS1 = cite(
  "HSE",
  "HSIS1 Reporting injuries in health and social care (Rev4)",
  SOURCES.hseHealthAndSocialCare,
);

const HCP = "In the reasonable opinion of a health care professional";

/** Care and support statutory guidance 14.17: the types of abuse and neglect. */
export const ABUSE_TYPES: readonly ClassifierOption[] = [
  { value: "physical", label: "Physical abuse" },
  { value: "domestic", label: "Domestic violence" },
  { value: "sexual", label: "Sexual abuse" },
  { value: "psychological", label: "Psychological abuse" },
  { value: "financial_or_material", label: "Financial or material abuse" },
  { value: "modern_slavery", label: "Modern slavery" },
  { value: "discriminatory", label: "Discriminatory abuse" },
  { value: "organisational", label: "Organisational abuse" },
  { value: "neglect", label: "Neglect and acts of omission" },
  { value: "self_neglect", label: "Self-neglect" },
];

/** RIDDOR 2013 reg 4(1)(a) to (h), in the regulation's words. */
export const SPECIFIED_INJURIES: readonly ClassifierOption[] = [
  {
    value: "fracture",
    label:
      "Any bone fracture diagnosed by a registered medical practitioner, other than to a finger, thumb or toe",
  },
  { value: "amputation", label: "Amputation of an arm, hand, finger, thumb, leg, foot or toe" },
  {
    value: "sight",
    label:
      "Any injury diagnosed by a registered medical practitioner as being likely to cause permanent blinding or reduction in sight in one or both eyes",
  },
  {
    value: "crush",
    label:
      "Any crush injury to the head or torso causing damage to the brain or internal organs in the chest or abdomen",
  },
  {
    value: "burn",
    label:
      "Any burn injury (including scalding) which covers more than 10% of the whole body's total surface area, or causes significant damage to the eyes, respiratory system or other vital organs",
  },
  { value: "scalping", label: "Any degree of scalping requiring hospital treatment" },
  {
    value: "loss_of_consciousness",
    label: "Loss of consciousness caused by head injury or asphyxia",
  },
  {
    value: "enclosed_space",
    label:
      "Any other injury arising from working in an enclosed space which leads to hypothermia or heat-induced illness, or requires resuscitation or admittance to hospital for more than 24 hours",
  },
  { value: "none", label: "None of these" },
];

/** Causes that HSE says are not reportable (HSIS1 Rev4; RIDDOR reg 2(1) "accident"). */
export const RIDDOR_EXCLUDED_CAUSES: readonly ClassifierOption[] = [
  { value: "none", label: "None of these" },
  {
    value: "suicide_or_self_harm",
    label: "Suicide or deliberate self-harm (these are not accidents)",
  },
  {
    value: "violence_to_person_not_at_work",
    label: "Physical violence to a person not at work, such as a resident hurt by another resident",
  },
  {
    value: "medical_treatment",
    label:
      "An operation, examination or other medical treatment carried out by or under the supervision of a doctor or dentist",
  },
];

const YES_NO: readonly ClassifierOption[] = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
  { value: "unsure", label: "Not sure yet" },
];

function q(
  key: ClassifierQuestionKey,
  kind: ClassifierAnswerKind,
  text: string,
  sources: readonly Citation[],
  help: string | null = null,
  options: readonly ClassifierOption[] = kind === "yes_no_unsure" ? YES_NO : [],
): ClassifierQuestion {
  return { key, kind, text, help, options, sources };
}

export const CLASSIFIER_QUESTIONS: Readonly<Record<ClassifierQuestionKey, ClassifierQuestion>> = {
  "harm.impairment_days": q(
    "harm.impairment_days",
    "days",
    `${HCP}, for how many days has the incident impaired the person's sensory, motor or intellectual functions, or how long is it likely to? Enter 0 if there is no impairment.`,
    [REG18("reg 18(2)(a)(i) and (5)(g)(ii)"), REG20("reg 20(9)(a)(ii)")],
  ),
  "harm.body_structure_changed": q(
    "harm.body_structure_changed",
    "yes_no_unsure",
    `${HCP}, has the incident resulted in changes to the structure of the person's body?`,
    [REG18("reg 18(2)(a)(ii)"), REG20("reg 20(9)(a)(iii)")],
    "For example a fracture or the loss of a limb.",
  ),
  "harm.pain_days": q(
    "harm.pain_days",
    "days",
    `${HCP}, for how many days in a row has the person experienced pain because of the incident, or how long are they likely to? Enter 0 if none.`,
    [REG18("reg 18(2)(a)(iii) and (5)(g)(i)"), REG20("reg 20(7) and (9)(a)(iv)")],
  ),
  "harm.psychological_harm_days": q(
    "harm.psychological_harm_days",
    "days",
    `${HCP}, for how many days in a row has the person experienced psychological harm because of the incident, or how long are they likely to? Enter 0 if none.`,
    [REG18("reg 18(2)(a)(iii) and (5)(g)(i)"), REG20("reg 20(7) and (9)(a)(iv)")],
  ),
  "harm.life_expectancy_shortened": q(
    "harm.life_expectancy_shortened",
    "yes_no_unsure",
    `${HCP}, has the incident resulted in the shortening of the life expectancy of the person?`,
    [REG18("reg 18(2)(a)(iv)"), REG20("reg 20(9)(a)(v)")],
  ),
  "harm.treatment_to_prevent": q(
    "harm.treatment_to_prevent",
    "yes_no_unsure",
    `${HCP}, does the person need treatment by a health care professional to prevent their death, or to prevent an injury that, if left untreated, would lead to one of the outcomes above?`,
    [REG18("reg 18(2)(b)"), REG20("reg 20(9)(b)")],
  ),
  "candour.unintended_or_unexpected": q(
    "candour.unintended_or_unexpected",
    "yes_no_unsure",
    "Was this an unintended or unexpected incident that happened to the person while care was being provided?",
    [REG20("reg 20(9)")],
  ),
  "candour.death_related_to_incident": q(
    "candour.death_related_to_incident",
    "yes_no_unsure",
    `${HCP}, does the death relate directly to the incident rather than to the natural course of the person's illness or underlying condition?`,
    [REG20("reg 20(9)(a)(i)")],
  ),
  "safeguarding.concern": q(
    "safeguarding.concern",
    "yes_no_unsure",
    "Is there abuse or neglect of a person using the service, or an allegation or suspicion of it?",
    [
      cite("Care Act 2014", "s.42(1)", SOURCES.careActS42),
      cite("Care and support statutory guidance", "14.2 and 14.17", SOURCES.careStatutoryGuidance),
      REG18("reg 18(2)(e) and (5)(b)"),
    ],
  ),
  "safeguarding.types": q(
    "safeguarding.types",
    "choices",
    "Which types of abuse or neglect are involved? Choose all that apply.",
    [cite("Care and support statutory guidance", "14.17", SOURCES.careStatutoryGuidance)],
    null,
    ABUSE_TYPES,
  ),
  "pressure_ulcer.neglect_concern": q(
    "pressure_ulcer.neglect_concern",
    "yes_no_unsure",
    "Is there a concern that abuse or neglect can be directly associated with the pressure damage?",
    [
      cite(
        "DHSC",
        "Pressure ulcers: safeguarding adults protocol (2024)",
        SOURCES.pressureUlcerProtocol,
      ),
    ],
  ),
  "pressure_ulcer.severe_impact": q(
    "pressure_ulcer.severe_impact",
    "yes_no_unsure",
    "Is the pressure damage severe in its impact on the person (for example, pain)?",
    [
      cite(
        "DHSC",
        "Pressure ulcers: safeguarding adults protocol (2024)",
        SOURCES.pressureUlcerProtocol,
      ),
    ],
  ),
  "police.involved": q(
    "police.involved",
    "yes_no_unsure",
    "Has the incident been reported to the police, or are the police investigating it?",
    [REG18("reg 18(2)(f)")],
  ),
  "service.threatens_safe_running": q(
    "service.threatens_safe_running",
    "yes_no_unsure",
    "Does this event prevent, or appear likely to threaten to prevent, the service carrying on safely, or in accordance with its registration requirements?",
    [REG18("reg 18(2)(g)")],
    "For example a fire or a flood.",
  ),
  "service.insufficient_staff": q(
    "service.insufficient_staff",
    "yes_no_unsure",
    "Is there an insufficient number of suitably qualified, skilled and experienced staff to carry on the service?",
    [REG18("reg 18(2)(g)(i)")],
  ),
  "service.utility_interruption_hours": q(
    "service.utility_interruption_hours",
    "hours",
    "If the supply of electricity, gas, water or sewerage to the premises was interrupted, for how many continuous hours? Enter 0 if there was no interruption.",
    [REG18("reg 18(2)(g)(ii)")],
  ),
  "service.premises_damage": q(
    "service.premises_damage",
    "yes_no_unsure",
    "Has physical damage to the premises had, or is it likely to have, a detrimental effect on the treatment or care provided?",
    [REG18("reg 18(2)(g)(iii)")],
  ),
  "service.safety_device_failure_hours": q(
    "service.safety_device_failure_hours",
    "hours",
    "If fire alarms or other safety devices failed or malfunctioned, for how many continuous hours? Enter 0 if they did not.",
    [REG18("reg 18(2)(g)(iv)")],
  ),
  "riddor.work_connected": q(
    "riddor.work_connected",
    "yes_no_unsure",
    "Did the accident arise out of or in connection with work: the way the work was carried out, organised or supervised, the equipment or substances used, or the condition of the premises? Answer no if it arose from the person's own condition with no such factor.",
    [RIDDOR("reg 2(1) and (2)", SOURCES.riddorReg2), HSIS1],
    "For example: a trip on a damaged carpet, a hoist failure or a fall where the care plan said the person needed help that was not given is work-related. A fall by someone assessed as not needing supervision, with nothing wrong in the premises or equipment, is not.",
  ),
  "riddor.excluded_cause": q(
    "riddor.excluded_cause",
    "choice",
    "Was the cause one of these?",
    [RIDDOR('reg 2(1) "accident"', SOURCES.riddorReg2), HSIS1],
    null,
    RIDDOR_EXCLUDED_CAUSES,
  ),
  "riddor.worker_specified_injury": q(
    "riddor.worker_specified_injury",
    "choices",
    "Did a worker suffer any of these injuries? Choose all that apply.",
    [RIDDOR("reg 4(1)", SOURCES.riddorReg4)],
    null,
    SPECIFIED_INJURIES,
  ),
  "riddor.worker_incapacity_days": q(
    "riddor.worker_incapacity_days",
    "days",
    "How many consecutive days has the worker been unable to do their normal work because of the injury? Do not count the day of the accident; do count weekends and rest days.",
    [RIDDOR("reg 4(2)", SOURCES.riddorReg4), HSIS1],
  ),
  "riddor.non_worker_to_hospital": q(
    "riddor.non_worker_to_hospital",
    "yes_no_unsure",
    "Was a person who was not at work (a resident or visitor) taken from the place of the accident directly to hospital for treatment of the injury?",
    [RIDDOR("reg 5(a)", SOURCES.riddorReg5), HSIS1],
    "Examinations and diagnostic tests alone are not treatment.",
  ),
  "riddor.dangerous_occurrence": q(
    "riddor.dangerous_occurrence",
    "yes_no_unsure",
    "Was this a dangerous occurrence listed in RIDDOR Schedule 2, such as a hoist collapsing or overturning, or a needlestick from a sharp known to carry a blood-borne virus?",
    [RIDDOR("reg 7 and Schedule 2", SOURCES.riddorSchedule2), HSIS1],
  ),
  "falls.head_injury": q(
    "falls.head_injury",
    "yes_no_unsure",
    "Did the person hit their head, or can a head injury not be ruled out (for example, nobody saw the fall)?",
    [cite("NICE NG232", "1.2.4", SOURCES.niceNg232)],
  ),
  "falls.anticoagulant": q(
    "falls.anticoagulant",
    "yes_no_unsure",
    "Is the person currently having anticoagulant or antiplatelet treatment (except aspirin on its own)?",
    [cite("NICE NG232", "1.2.4", SOURCES.niceNg232)],
    "Check the medicines record.",
  ),
};

/** Checks one answer before it is stored; returns the problem, or null when it is acceptable. */
export function classifierAnswerProblem(
  key: ClassifierQuestionKey,
  value: ClassifierAnswerValue,
): string | null {
  const question = CLASSIFIER_QUESTIONS[key];
  if (value === "unsure") return null;
  switch (question.kind) {
    case "yes_no_unsure":
      return value === "yes" || value === "no" ? null : "Answer yes, no or not sure yet.";
    case "days":
    case "hours":
      return typeof value === "number" && Number.isInteger(value) && value >= 0
        ? null
        : `Enter a whole number of ${question.kind}, or not sure yet.`;
    case "choice":
      return typeof value === "string" && question.options.some((o) => o.value === value)
        ? null
        : "Choose one of the options.";
    case "choices": {
      const ok =
        Array.isArray(value) &&
        value.length > 0 &&
        new Set(value).size === value.length &&
        value.every((v) => question.options.some((o) => o.value === v)) &&
        !(value.includes("none") && value.length > 1);
      return ok ? null : "Choose one or more of the options, or none of these on its own.";
    }
  }
}
