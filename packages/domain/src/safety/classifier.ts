/**
 * The incident classifier (safety.md section 4 rules 1 to 12; SAFE-002 to SAFE-005, SAFE-007 to
 * SAFE-009; hazard HZ-013). It reads the incident's facts and the answers to its questions and
 * returns every statutory output kind that applies, with its due time and the reasoning, every kind
 * that does not apply and why, the kinds still waiting for answers, and the tasks to raise.
 *
 * - "yes" makes an output required; "unsure" makes it required but provisional (a draft whose clock
 *   is visible, which a holder of `safety.notification.submit` can mark not required with a
 *   reason); an unanswered question leaves the output pending and raises a task to answer it.
 * - Clocks start at `occurred_at` (offline incidents included), never at sync time. "Without delay"
 *   kinds are due at once. Every period comes from the rate table.
 * - The classifier supports, and never replaces, the Registered Manager's judgement (HZ-013).
 *
 * Phase 1 checks incidents at locations in England. Other nations return `nationSupported: false`
 * until their nation pack (Phase 7).
 */

import { type Citation, cite, SOURCES } from "../shared/citation";
import { addUkDays } from "../shared/time";
import type { BankHolidays } from "../shared/working-days";
import { candourClocks } from "./candour";
import type { IncidentFacts, IncidentPersonFacts, IncidentType } from "./incident";
import { MEDICAL_EXAMINER_SOURCES } from "./medical-examiner";
import {
  NOTIFICATION_KINDS,
  STATUTORY_NOTIFICATION_KINDS,
  type StatutoryNotificationKind,
} from "./notifications";
import type { OutbreakAssessment } from "./outbreak";
import { type PostFallTaskKind, postFallChecklist, type YesNoUnsure } from "./post-fall";
import {
  CLASSIFIER_QUESTION_KEYS,
  CLASSIFIER_QUESTIONS,
  type ClassifierAnswer,
  type ClassifierAnswerValue,
  type ClassifierQuestionKey,
  classifierAnswerProblem,
} from "./questions";
import { CLASSIFIER_NATIONS, type SafetyRates } from "./rates";

/** Stored on the incident with every run, so a result can be traced to the rules that made it. */
export const CLASSIFIER_VERSION = "safety-classifier-2026.10.1";

export interface ClassifierInput {
  readonly facts: IncidentFacts;
  readonly answers: readonly ClassifierAnswer[];
  readonly rates: SafetyRates;
  /** Bank holidays for the location's nation (working-day clocks). */
  readonly holidays: BankHolidays;
  /** The candour record's threshold decision, once made (ADR-0021: the written clock starts here). */
  readonly candourDecision?: { readonly notifiable: boolean; readonly decidedAt: Date } | null;
  /** `detectOutbreaks` over the location's cases, for infection incidents. */
  readonly outbreak?: OutbreakAssessment | null;
}

export interface OutputDeadline {
  readonly key:
    | "without_delay"
    | "notify_without_delay"
    | "report_received"
    | "report"
    | "verbal_notification"
    | "written_notification_target";
  readonly dueAt: Date;
  readonly wording: string;
  /** False for a Harbour or tenant target (for example the candour written target). */
  readonly statutory: boolean;
}

export interface RequiredOutput {
  readonly kind: StatutoryNotificationKind;
  /** The people the output is about; one draft each for kinds made per person. */
  readonly personRefs: readonly string[];
  /** The earliest deadline: drives the countdown, the dashboard and escalation. */
  readonly dueAt: Date;
  readonly deadlines: readonly OutputDeadline[];
  readonly reasons: readonly string[];
  readonly sources: readonly Citation[];
  /** Rests on an "unsure" answer: drafted so the clock is visible, to be confirmed. */
  readonly provisional: boolean;
  /** What the regulation says the notification must contain. */
  readonly requiredContent: readonly string[];
}

export interface ExcludedOutput {
  readonly kind: StatutoryNotificationKind;
  readonly reason: string;
  readonly sources: readonly Citation[];
}

export interface PendingOutput {
  readonly kind: StatutoryNotificationKind;
  readonly waitingFor: readonly ClassifierQuestionKey[];
}

export type ClassifierTaskKind =
  | PostFallTaskKind
  | "answer_classifier_questions"
  | "candour_threshold_decision"
  | "safeguarding_decision_guide"
  | "herbert_protocol_to_police"
  | "missing_person_search_log"
  | "return_welfare_check"
  | "medical_examiner_pack"
  | "riddor_absence_check"
  | "outbreak_link_review";

export interface ClassifierTask {
  readonly task: ClassifierTaskKind;
  readonly reason: string;
  /** Null when the tenant's task defaults set the due time. */
  readonly dueAt: Date | null;
  readonly until?: Date;
  readonly personRefs: readonly string[];
  readonly sources: readonly Citation[];
}

export interface ClassifierResult {
  readonly classifierVersion: string;
  readonly nationSupported: boolean;
  readonly outputs: readonly RequiredOutput[];
  readonly exclusions: readonly ExcludedOutput[];
  readonly pending: readonly PendingOutput[];
  readonly tasks: readonly ClassifierTask[];
  /** Questions that apply to this incident and have no answer yet, in the order to ask them. */
  readonly openQuestions: readonly ClassifierQuestionKey[];
  /** One line per output kind, for the audit trail. */
  readonly reasoning: readonly string[];
}

// ---------------------------------------------------------------------------------------------
// Three-state findings

type Tri = "yes" | "no" | "unsure" | "unanswered";

interface Finding {
  readonly value: Tri;
  readonly because: readonly string[];
  readonly waitingFor: readonly ClassifierQuestionKey[];
}

const found = (
  value: Tri,
  because: string[] = [],
  waitingFor: ClassifierQuestionKey[] = [],
): Finding => ({
  value,
  because,
  waitingFor,
});

function anyOf(...findings: readonly Finding[]): Finding {
  const pick = (v: Tri) => findings.filter((f) => f.value === v);
  const yes = pick("yes");
  if (yes.length > 0)
    return found(
      "yes",
      yes.flatMap((f) => f.because),
    );
  const unsure = pick("unsure");
  const unanswered = pick("unanswered");
  const waiting = [...unsure, ...unanswered].flatMap((f) => f.waitingFor);
  if (unsure.length > 0)
    return found(
      "unsure",
      unsure.flatMap((f) => f.because),
      waiting,
    );
  if (unanswered.length > 0) return found("unanswered", [], waiting);
  return found(
    "no",
    findings.flatMap((f) => f.because),
  );
}

function allOf(...findings: readonly Finding[]): Finding {
  const pick = (v: Tri) => findings.filter((f) => f.value === v);
  const no = pick("no");
  if (no.length > 0)
    return found(
      "no",
      no.flatMap((f) => f.because),
    );
  const unanswered = pick("unanswered");
  const unsure = pick("unsure");
  const waiting = [...unanswered, ...unsure].flatMap((f) => f.waitingFor);
  if (unanswered.length > 0) return found("unanswered", [], waiting);
  const because = findings.flatMap((f) => f.because);
  return unsure.length > 0 ? found("unsure", because, waiting) : found("yes", because);
}

const fact = (value: boolean, yes: string, no?: string): Finding =>
  value ? found("yes", [yes]) : found("no", no ? [no] : []);

/** The latest valid answer per question (classifier_answer is append-only). */
class AnswerBook {
  private readonly latest = new Map<ClassifierQuestionKey, ClassifierAnswerValue>();

  constructor(answers: readonly ClassifierAnswer[]) {
    const ordered = [...answers].sort((a, b) => a.answeredAt.getTime() - b.answeredAt.getTime());
    for (const a of ordered) {
      if (classifierAnswerProblem(a.key, a.value) === null) this.latest.set(a.key, a.value);
    }
  }

  get(key: ClassifierQuestionKey): ClassifierAnswerValue | undefined {
    return this.latest.get(key);
  }

  has(key: ClassifierQuestionKey): boolean {
    return this.latest.has(key);
  }

  tri(key: ClassifierQuestionKey): Tri {
    const value = this.get(key);
    if (value === undefined) return "unanswered";
    return value === "yes" || value === "no" || value === "unsure" ? value : "unanswered";
  }

  yesNo(key: ClassifierQuestionKey, yes: string, no: string): Finding {
    const value = this.tri(key);
    if (value === "yes") return found("yes", [yes]);
    if (value === "no") return found("no", [no]);
    if (value === "unsure") return found("unsure", [`Not sure yet: ${yes.toLowerCase()}`], [key]);
    return found("unanswered", [], [key]);
  }

  /** A count of days or hours compared with a threshold from the rate table. */
  count(
    key: ClassifierQuestionKey,
    meets: (n: number) => boolean,
    yes: (n: number) => string,
    no: (n: number) => string,
  ): Finding {
    const value = this.get(key);
    if (value === "unsure")
      return found("unsure", [`Not sure yet: ${CLASSIFIER_QUESTIONS[key].text}`], [key]);
    if (typeof value !== "number") return found("unanswered", [], [key]);
    return meets(value) ? found("yes", [yes(value)]) : found("no", [no(value)]);
  }

  choices(key: ClassifierQuestionKey): readonly string[] | "unsure" | undefined {
    const value = this.get(key);
    if (value === "unsure") return "unsure";
    if (Array.isArray(value)) return value as readonly string[];
    if (typeof value === "string") return [value];
    return undefined;
  }

  yesNoUnsure(key: ClassifierQuestionKey): YesNoUnsure | null {
    const value = this.tri(key);
    return value === "unanswered" ? null : value;
  }
}

// ---------------------------------------------------------------------------------------------
// Sources

const REG16 = (p: string) => cite("CQC (Registration) Regulations 2009", p, SOURCES.cqcReg16);
const REG18 = (p: string) => cite("CQC (Registration) Regulations 2009", p, SOURCES.cqcReg18);
const REG20 = (p: string) =>
  cite(
    "Health and Social Care Act 2008 (Regulated Activities) Regulations 2014",
    p,
    SOURCES.candourReg20,
  );
const RIDDOR_REG2 = cite("RIDDOR 2013", "reg 2(1) and (2)", SOURCES.riddorReg2);
const RIDDOR_SCH1 = cite("RIDDOR 2013", "Schedule 1 para 1(1)", SOURCES.riddorSchedule1);
const HSIS1 = cite(
  "HSE",
  "HSIS1 Reporting injuries in health and social care (Rev4)",
  SOURCES.hseHealthAndSocialCare,
);
const HSE_WHEN = cite("HSE", "When do I need to report an incident?", SOURCES.hseWhenToReport);
const CQC_POLICE_FORM = cite(
  "CQC",
  "Police involvement in an incident: notification form",
  SOURCES.cqcPoliceForm,
);
const CQC_ABSENCE_FORM = cite(
  "CQC",
  "Unauthorised absence: notification form",
  SOURCES.cqcAbsenceForm,
);
const CARE_ACT = cite("Care Act 2014", "s.42(1)", SOURCES.careActS42);
const CSG = cite(
  "Care and support statutory guidance",
  "14.2 and 14.17",
  SOURCES.careStatutoryGuidance,
);
const PU_PROTOCOL = cite(
  "DHSC",
  "Pressure ulcers: safeguarding adults protocol (2024)",
  SOURCES.pressureUlcerProtocol,
);
const LEDER = cite(
  "LeDeR",
  "Report the death of someone with a learning disability or an autistic person",
  SOURCES.leder,
);
const MASTER = (section: string) =>
  cite("Harbour master prompt", section, "docs/00-MASTER-PROMPT.md");

// ---------------------------------------------------------------------------------------------
// Rules

const NEAR_MISS: readonly IncidentType[] = ["near_miss"];
const MISSING: readonly IncidentType[] = ["missing_person", "absconding"];
const SERVICE_TYPES: readonly IncidentType[] = [
  "environmental",
  "fire_setting",
  "ipc",
  "data_breach",
];
const DANGEROUS_OCCURRENCE_TYPES: readonly IncidentType[] = [
  "near_miss",
  "environmental",
  "injury",
  "fall",
  "staff_injury",
];

type Evaluation =
  | {
      readonly status: "required";
      readonly finding: Finding;
      readonly personRefs: readonly string[];
      readonly start?: Date;
      readonly requiredContent?: readonly string[];
      readonly extraReasons?: readonly string[];
    }
  | { readonly status: "excluded"; readonly reason: string; readonly sources?: readonly Citation[] }
  | { readonly status: "pending"; readonly waitingFor: readonly ClassifierQuestionKey[] };

const excluded = (reason: string, sources?: readonly Citation[]): Evaluation => ({
  status: "excluded",
  reason,
  ...(sources ? { sources } : {}),
});

function fromFinding(
  finding: Finding,
  personRefs: readonly string[],
  noReason: (because: readonly string[]) => string,
  extra: { start?: Date; requiredContent?: readonly string[]; sources?: readonly Citation[] } = {},
): Evaluation {
  if (finding.value === "no") return excluded(noReason(finding.because), extra.sources);
  if (finding.value === "unanswered") return { status: "pending", waitingFor: finding.waitingFor };
  return {
    status: "required",
    finding,
    personRefs,
    ...(extra.start ? { start: extra.start } : {}),
    ...(extra.requiredContent ? { requiredContent: extra.requiredContent } : {}),
  };
}

const refs = (people: readonly IncidentPersonFacts[]) => people.map((p) => p.ref);

interface Context {
  readonly facts: IncidentFacts;
  readonly answers: AnswerBook;
  readonly rates: SafetyRates;
  readonly serviceUsers: readonly IncidentPersonFacts[];
  readonly affectedServiceUsers: readonly IncidentPersonFacts[];
  readonly deadServiceUsers: readonly IncidentPersonFacts[];
  readonly affectedWorkers: readonly IncidentPersonFacts[];
  /** Residents and visitors who were hurt and are alive. */
  readonly affectedNotAtWork: readonly IncidentPersonFacts[];
  readonly anyoneDied: boolean;
  readonly harmApplies: boolean;
}

function context(input: ClassifierInput): Context {
  const people = input.facts.people;
  const serviceUsers = people.filter((p) => p.kind === "service_user");
  const affectedServiceUsers = serviceUsers.filter((p) => p.role === "affected");
  return {
    facts: input.facts,
    answers: new AnswerBook(input.answers),
    rates: input.rates,
    serviceUsers,
    affectedServiceUsers,
    deadServiceUsers: serviceUsers.filter((p) => p.died),
    affectedWorkers: people.filter((p) => p.kind === "worker" && p.role === "affected"),
    affectedNotAtWork: people.filter(
      (p) => p.kind !== "worker" && p.role === "affected" && !p.died,
    ),
    anyoneDied: people.some((p) => p.died),
    harmApplies: affectedServiceUsers.length > 0 && !NEAR_MISS.includes(input.facts.type),
  };
}

/** Reg 18(2)(a) and (b) and reg 20(9)(a)(ii) to (v) and (b): the outcomes of harm. */
function harmFindings(c: Context, days: number, regulation: "reg 18" | "reg 20"): Finding[] {
  const a = c.answers;
  const p = (r18: string, r20: string) =>
    regulation === "reg 18" ? `reg 18${r18}` : `reg 20${r20}`;
  const atLeast = (n: number) => n >= days;
  return [
    a.count(
      "harm.impairment_days",
      atLeast,
      (n) =>
        `An impairment of the sensory, motor or intellectual functions lasting, or likely to last, ${n} days (${days} or more counts) (${p("(2)(a)(i)", "(9)(a)(ii)")})`,
      (n) => `Impairment of ${n} days, under ${days}`,
    ),
    a.yesNo(
      "harm.body_structure_changed",
      `Changes to the structure of the person's body (${p("(2)(a)(ii)", "(9)(a)(iii)")})`,
      "No change to the structure of the body",
    ),
    a.count(
      "harm.pain_days",
      atLeast,
      (n) =>
        `Prolonged pain: ${n} days (${days} or more counts) (${p("(2)(a)(iii)", "(9)(a)(iv)")})`,
      (n) => `Pain of ${n} days, under ${days}`,
    ),
    a.count(
      "harm.psychological_harm_days",
      atLeast,
      (n) =>
        `Prolonged psychological harm: ${n} days (${days} or more counts) (${p("(2)(a)(iii)", "(9)(a)(iv)")})`,
      (n) => `Psychological harm of ${n} days, under ${days}`,
    ),
    a.yesNo(
      "harm.life_expectancy_shortened",
      `The shortening of the life expectancy of the person (${p("(2)(a)(iv)", "(9)(a)(v)")})`,
      "Life expectancy not shortened",
    ),
    a.yesNo(
      "harm.treatment_to_prevent",
      `Requires treatment by a health care professional to prevent death or an injury leading to one of these outcomes (${p("(2)(b)", "(9)(b)")})`,
      "No treatment needed to prevent death or serious harm",
    ),
  ];
}

function reg16Death(c: Context): Evaluation {
  if (c.deadServiceUsers.length === 0) return excluded("No person using the service died.");
  return {
    status: "required",
    finding: found("yes", [
      "A person using the service died. Regulation 16(1) requires notification without delay of a death whilst services were being provided, or which has, or may have, resulted from the carrying on of a regulated activity. Expected and unexpected deaths are both notified",
    ]),
    personRefs: refs(c.deadServiceUsers),
    requiredContent: ["A description of the circumstances of the death (reg 16(3))"],
  };
}

function reg18SeriousInjury(c: Context): Evaluation {
  if (c.affectedServiceUsers.length === 0)
    return excluded("No person using the service was affected.");
  if (!c.harmApplies) return excluded("A near miss: nobody was harmed.");
  return fromFinding(
    anyOf(...harmFindings(c, c.rates.reg18ProlongedHarmDays, "reg 18")),
    refs(c.affectedServiceUsers),
    () =>
      "No injury meeting regulation 18(2)(a) or (b) in the reasonable opinion of a health care professional.",
  );
}

function abuseConcern(c: Context): Finding {
  return c.answers.yesNo(
    "safeguarding.concern",
    "Abuse or neglect, or an allegation or suspicion of it",
    "No abuse or neglect, or allegation or suspicion of it",
  );
}

function reg18Abuse(c: Context): Evaluation {
  if (c.serviceUsers.length === 0) return excluded("No person using the service is involved.");
  const concern = abuseConcern(c);
  const types = c.answers.choices("safeguarding.types");
  if ((concern.value === "yes" || concern.value === "unsure") && Array.isArray(types)) {
    if (types.length > 0 && types.every((t) => t === "self_neglect")) {
      return excluded(
        "Self-neglect alone is a safeguarding concern under the Care Act, but it is not abuse as regulation 18(5)(b) defines it (sexual abuse; physical or psychological ill-treatment; theft, misuse or misappropriation of money or property; neglect and acts of omission which cause harm or place at risk of harm).",
        [REG18("reg 18(5)(b)")],
      );
    }
  }
  return fromFinding(
    concern,
    refs(c.serviceUsers),
    () => "No abuse or allegation of abuse in relation to a person using the service.",
  );
}

function s42Referral(c: Context): Evaluation {
  if (c.serviceUsers.length === 0) return excluded("No person using the service is involved.");
  return fromFinding(
    abuseConcern(c),
    refs(c.serviceUsers),
    () => "No abuse or neglect, or allegation or suspicion of it, is recorded.",
  );
}

function reg18Police(c: Context, specific: readonly StatutoryNotificationKind[]): Evaluation {
  const missingUnderDolsOrMha = c.affectedServiceUsers.filter(
    (p) => MISSING.includes(c.facts.type) && (p.subjectToDols || p.subjectToMentalHealthAct),
  );
  const finding = anyOf(
    c.answers.yesNo(
      "police.involved",
      "The incident has been reported to, or is being investigated by, the police",
      "Not reported to or investigated by the police",
    ),
    fact(
      missingUnderDolsOrMha.length > 0,
      "A missing person subject to DoLS or the Mental Health Act: reported to the police, which makes it a regulation 18(2)(f) incident (master prompt 11.1). Regulation 17 (unauthorised absence) applies only to services with a low, medium or high security designation",
    ),
  );
  if (finding.value === "yes" || finding.value === "unsure") {
    const covered = specific.map((k) => NOTIFICATION_KINDS[k].label.toLowerCase());
    if (covered.length > 0) {
      return excluded(
        `Police involvement goes on the ${covered.join(" and ")} notification. CQC's police involvement form: if a person using the service was affected by a death, serious injury or abuse, use the specific notification form.`,
        [CQC_POLICE_FORM],
      );
    }
  }
  return fromFinding(finding, refs(c.affectedServiceUsers), () => "The police are not involved.");
}

function reg18ServiceDisruption(c: Context): Evaluation {
  const keys = [
    "service.threatens_safe_running",
    "service.insufficient_staff",
    "service.utility_interruption_hours",
    "service.premises_damage",
    "service.safety_device_failure_hours",
  ] as const;
  if (!SERVICE_TYPES.includes(c.facts.type) && !keys.some((k) => c.answers.has(k))) {
    return excluded("Not an event that affects the running of the service.");
  }
  const hours = c.rates.reg18InterruptionHours;
  const over = (n: number) => n > hours;
  const a = c.answers;
  return fromFinding(
    anyOf(
      a.yesNo(
        "service.threatens_safe_running",
        "An event which prevents, or appears likely to threaten to prevent, the service carrying on safely or in accordance with its registration requirements (reg 18(2)(g))",
        "Safe running not threatened",
      ),
      a.yesNo(
        "service.insufficient_staff",
        "An insufficient number of suitably qualified, skilled and experienced persons (reg 18(2)(g)(i))",
        "Enough suitably qualified staff",
      ),
      a.count(
        "service.utility_interruption_hours",
        over,
        (n) =>
          `An interruption in the supply of electricity, gas, water or sewerage for ${n} hours, longer than a continuous period of ${hours} hours (reg 18(2)(g)(ii))`,
        (n) => `Utility interruption of ${n} hours, not longer than ${hours}`,
      ),
      a.yesNo(
        "service.premises_damage",
        "Physical damage to the premises which has, or is likely to have, a detrimental effect on the care provided (reg 18(2)(g)(iii))",
        "No damage affecting care",
      ),
      a.count(
        "service.safety_device_failure_hours",
        over,
        (n) =>
          `The failure or malfunctioning of fire alarms or other safety devices for ${n} hours, longer than a continuous period of ${hours} hours (reg 18(2)(g)(iv))`,
        (n) => `Safety device failure of ${n} hours, not longer than ${hours}`,
      ),
    ),
    [],
    () => "Nothing prevents or threatens to prevent the service running safely (reg 18(2)(g)).",
  );
}

/** RIDDOR's first question: work activity, premises or equipment, rather than the person's own condition. */
function workConnected(c: Context): Finding {
  return c.answers.yesNo(
    "riddor.work_connected",
    "The accident arose out of or in connection with work: how the work was carried out, organised or supervised, the equipment or substances used, or the condition of the premises (RIDDOR reg 2(1) and (2))",
    "It did not arise out of or in connection with work: it arose from the person's own condition, with no failing in the premises, the equipment or the way work was done. Not reportable under RIDDOR (reg 2(1) and (2); HSE HSIS1)",
  );
}

function riddorPossible(c: Context): boolean {
  return (
    c.anyoneDied ||
    c.affectedWorkers.length > 0 ||
    (c.affectedNotAtWork.length > 0 && !NEAR_MISS.includes(c.facts.type)) ||
    DANGEROUS_OCCURRENCE_TYPES.includes(c.facts.type) ||
    c.answers.has("riddor.dangerous_occurrence")
  );
}

const CAUSE_REASONS: Readonly<Record<string, string>> = {
  suicide_or_self_harm:
    "Suicide and deliberate self-harm are not accidents, so they are not reportable under RIDDOR (HSE HSIS1).",
  violence_to_person_not_at_work:
    "Physical violence to a person who is not at work is not an accident under RIDDOR (reg 2(1) covers violence to a person at work only; HSE HSIS1).",
  medical_treatment:
    "An injury arising from an operation, examination or other medical treatment carried out by or under the supervision of a doctor or dentist is not reportable (HSE HSIS1).",
};

/**
 * HSE's exclusions. For people at work only an explicit answer of suicide or self-harm excludes (a
 * worker hurt while helping someone who self-harmed has had an accident at work); for anyone else
 * a self-harm incident counts as that cause unless the answer says otherwise.
 */
function riddorExcludedByCause(c: Context, forWorkers: boolean): string | null {
  const answered = c.answers.choices("riddor.excluded_cause");
  const cause = Array.isArray(answered) ? answered[0] : undefined;
  if (cause === "none") return null;
  if (forWorkers) return cause === "suicide_or_self_harm" ? (CAUSE_REASONS[cause] ?? null) : null;
  const effective = cause ?? (c.facts.type === "self_harm" ? "suicide_or_self_harm" : undefined);
  return effective ? (CAUSE_REASONS[effective] ?? null) : null;
}

function riddor(c: Context, kind: StatutoryNotificationKind): Evaluation {
  const notMet = (because: readonly string[]) => because.join(". ");
  const sources = [RIDDOR_REG2, HSIS1];
  if (!riddorPossible(c)) {
    return excluded("No death, injury or dangerous occurrence that RIDDOR covers.", sources);
  }
  const gate = workConnected(c);
  switch (kind) {
    case "riddor_death": {
      if (!c.anyoneDied) return excluded("Nobody died.", sources);
      const deadWorkers = c.facts.people.some((p) => p.died && p.kind === "worker");
      const byCause = riddorExcludedByCause(c, deadWorkers);
      if (byCause) return excluded(byCause, sources);
      return fromFinding(
        allOf(gate, fact(true, "A person died as a result of the accident (reg 6(1))")),
        refs(c.facts.people.filter((p) => p.died)),
        notMet,
        { sources },
      );
    }
    case "riddor_specified_injury": {
      if (c.affectedWorkers.length === 0) return excluded("No worker was injured.", sources);
      const byCause = riddorExcludedByCause(c, true);
      if (byCause) return excluded(byCause, sources);
      const chosen = c.answers.choices("riddor.worker_specified_injury");
      const injury: Finding =
        chosen === "unsure"
          ? found(
              "unsure",
              ["Not sure yet whether a worker suffered a specified injury"],
              ["riddor.worker_specified_injury"],
            )
          : chosen === undefined
            ? found("unanswered", [], ["riddor.worker_specified_injury"])
            : chosen.some((v) => v !== "none")
              ? found("yes", [
                  `A specified injury to a worker: ${chosen.filter((v) => v !== "none").join(", ")} (reg 4(1))`,
                ])
              : found("no", ["No specified injury to a worker (reg 4(1))"]);
      return fromFinding(allOf(gate, injury), refs(c.affectedWorkers), notMet, { sources });
    }
    case "riddor_over_7_day": {
      if (c.affectedWorkers.length === 0) return excluded("No worker was injured.", sources);
      const byCause = riddorExcludedByCause(c, true);
      if (byCause) return excluded(byCause, sources);
      const threshold = c.rates.riddorOver7DayThresholdDays;
      const days = c.answers.count(
        "riddor.worker_incapacity_days",
        (n) => n > threshold,
        (n) =>
          `The worker has been unable to do their normal work for ${n} consecutive days, more than ${threshold} (reg 4(2))`,
        (n) =>
          `The worker has been unable to work for ${n} consecutive days so far; reportable only if more than ${threshold}. Update the answer if they stay off`,
      );
      return fromFinding(allOf(gate, days), refs(c.affectedWorkers), notMet, { sources });
    }
    case "riddor_non_worker_hospital": {
      if (c.affectedNotAtWork.length === 0)
        return excluded("No person who was not at work was injured.", sources);
      const byCause = riddorExcludedByCause(c, false);
      if (byCause) return excluded(byCause, sources);
      const hospital = c.answers.yesNo(
        "riddor.non_worker_to_hospital",
        "A person not at work was taken from the place of the accident directly to hospital for treatment (reg 5(a))",
        "Nobody who was not at work was taken directly to hospital for treatment (reg 5(a))",
      );
      return fromFinding(allOf(gate, hospital), refs(c.affectedNotAtWork), notMet, { sources });
    }
    default: {
      const occurrence = c.answers.yesNo(
        "riddor.dangerous_occurrence",
        "A dangerous occurrence listed in RIDDOR Schedule 2 (reg 7)",
        "Not a dangerous occurrence listed in RIDDOR Schedule 2",
      );
      if (!DANGEROUS_OCCURRENCE_TYPES.includes(c.facts.type) && occurrence.value === "unanswered") {
        return excluded("Not a dangerous occurrence.", sources);
      }
      return fromFinding(allOf(gate, occurrence), [], notMet, { sources });
    }
  }
}

function candour(c: Context, decision: ClassifierInput["candourDecision"]): Evaluation {
  const sources = [REG20("reg 20(9)")];
  if (c.affectedServiceUsers.length === 0)
    return excluded("No person using the service was affected.", sources);
  if (!c.harmApplies) {
    return excluded(
      "A near miss: for a provider that is not a health service body, reg 20(9) applies only where harm appears to have resulted or treatment is needed.",
      sources,
    );
  }
  const a = c.answers;
  const deadAffected = c.affectedServiceUsers.filter((p) => p.died);
  const outcomes = [
    ...(deadAffected.length > 0
      ? [
          a.yesNo(
            "candour.death_related_to_incident",
            "The death relates directly to the incident rather than to the natural course of the person's illness or underlying condition (reg 20(9)(a)(i))",
            "The death relates to the natural course of the person's illness or underlying condition",
          ),
        ]
      : []),
    ...harmFindings(c, c.rates.candourProlongedHarmDays, "reg 20"),
  ];
  const finding = allOf(
    a.yesNo(
      "candour.unintended_or_unexpected",
      "An unintended or unexpected incident that occurred in respect of the person during the provision of a regulated activity (reg 20(9))",
      "Not an unintended or unexpected incident",
    ),
    anyOf(...outcomes),
  );
  const content = [
    "In person, by one or more representatives of the provider (reg 20(3)(a))",
    "A true account of all the facts known about the incident (reg 20(3)(b))",
    "What further enquiries are appropriate (reg 20(3)(c))",
    "An apology (reg 20(3)(d))",
    "A written record of the notification, kept securely (reg 20(3)(e))",
    "A written notification with the account, the enquiries, their results and an apology (reg 20(4))",
  ];
  if (decision) {
    if (!decision.notifiable) {
      return excluded(
        "The threshold decision recorded on the candour record says this is not a notifiable safety incident.",
        sources,
      );
    }
    return {
      status: "required",
      finding: found("yes", [
        "The threshold decision recorded on the candour record says this is a notifiable safety incident (reg 20(9))",
        ...(finding.value === "yes" ? finding.because : []),
      ]),
      personRefs: refs(c.affectedServiceUsers),
      requiredContent: content,
    };
  }
  return fromFinding(
    finding,
    refs(c.affectedServiceUsers),
    () => "Not a notifiable safety incident under reg 20(9).",
    {
      requiredContent: content,
      sources,
    },
  );
}

function leder(c: Context): Evaluation {
  if (c.deadServiceUsers.length === 0) return excluded("No person using the service died.");
  const inScope = c.deadServiceUsers.filter((p) => p.learningDisability || p.autistic);
  if (inScope.length === 0) {
    return excluded(
      "The person who died did not have a learning disability and was not autistic.",
      [LEDER],
    );
  }
  const adults = inScope.filter((p) => p.aged18OrOver !== false);
  if (adults.length === 0) {
    return excluded("The person was under 18: report the death to Child Death Review instead.", [
      LEDER,
    ]);
  }
  return {
    status: "required",
    finding: found("yes", [
      "The death of someone with a learning disability or an autistic person aged 18 or over: report it to LeDeR (anyone can report)",
    ]),
    personRefs: refs(adults),
  };
}

function medicalExaminer(c: Context): Evaluation {
  if (c.deadServiceUsers.length === 0) return excluded("No person using the service died.");
  return {
    status: "required",
    finding: found("yes", [
      "Every death is scrutinised by a medical examiner or investigated by a coroner (death certification reforms, 9 September 2024): prepare the information pack",
    ]),
    personRefs: refs(c.deadServiceUsers),
  };
}

function missingPerson(c: Context): Evaluation {
  if (!MISSING.includes(c.facts.type)) return excluded("Not a missing person incident.");
  return {
    status: "required",
    finding: found("yes", [
      "A person is missing: give the police the Herbert Protocol profile, keep a search log and check their welfare when they return (master prompt 11.1)",
    ]),
    personRefs: refs(c.affectedServiceUsers),
  };
}

function outbreak(assessment: OutbreakAssessment | null | undefined): Evaluation {
  const signals = assessment?.signals ?? [];
  if (!assessment) {
    return excluded(
      "Outbreak detection was not run with this incident; it runs over the location's cases.",
    );
  }
  if (signals.length === 0)
    return excluded("No outbreak reporting threshold is met at this location.");
  const first = signals[0] as (typeof signals)[number];
  return {
    status: "required",
    finding: found(
      "yes",
      signals.map((s) => s.reason),
    ),
    personRefs: [],
    start: first.thresholdMetAt,
    extraReasons: ["UKHSA: report as soon as possible"],
  };
}

// ---------------------------------------------------------------------------------------------
// Clocks

function deadlines(
  kind: StatutoryNotificationKind,
  start: Date,
  input: ClassifierInput,
): OutputDeadline[] {
  const info = NOTIFICATION_KINDS[kind];
  const occurredAt = input.facts.occurredAt;
  const rates = input.rates;
  switch (info.clock) {
    case "riddor_report":
      return [
        {
          key: "notify_without_delay",
          dueAt: occurredAt,
          wording:
            "Notify the enforcing authority by the quickest practicable means without delay (RIDDOR Schedule 1 para 1(1)(a)). Reporting online does this.",
          statutory: true,
        },
        {
          key: "report_received",
          dueAt: addUkDays(occurredAt, rates.riddorReportDays),
          wording: `The report must be received within ${rates.riddorReportDays} days of the incident (RIDDOR Schedule 1 para 1(1)(b)).`,
          statutory: true,
        },
      ];
    case "riddor_over_7_day":
      return [
        {
          key: "report",
          dueAt: addUkDays(occurredAt, rates.riddorOver7DayReportDays),
          wording: `Report within ${rates.riddorOver7DayReportDays} days of the accident (RIDDOR reg 4(2)).`,
          statutory: true,
        },
      ];
    case "candour": {
      const decidedAt = input.candourDecision?.notifiable ? input.candourDecision.decidedAt : null;
      const clocks = candourClocks(occurredAt, decidedAt, rates, input.holidays);
      return [
        {
          key: "verbal_notification",
          dueAt: clocks.verbalDueAt,
          wording:
            "Notify the person in person, with an apology, as soon as reasonably practicable (reg 20(2) and (3)).",
          statutory: true,
        },
        {
          key: "written_notification_target",
          dueAt: clocks.writtenTargetAt,
          wording: clocks.writtenTargetWording,
          statutory: false,
        },
      ];
    }
    default:
      return [
        {
          key: "without_delay",
          dueAt: start,
          wording: info.statutory
            ? "Due without delay: overdue until submitted or marked not required with a reason."
            : "Due without delay (Harbour sets this; the law sets no time): overdue until done or marked not required with a reason.",
          statutory: info.statutory,
        },
      ];
  }
}

// ---------------------------------------------------------------------------------------------
// Questions that apply

function relevantQuestions(c: Context): ClassifierQuestionKey[] {
  const keys = new Set<ClassifierQuestionKey>();
  const type = c.facts.type;
  if (c.harmApplies) {
    for (const k of CLASSIFIER_QUESTION_KEYS) if (k.startsWith("harm.")) keys.add(k);
    keys.add("candour.unintended_or_unexpected");
    if (c.affectedServiceUsers.some((p) => p.died)) keys.add("candour.death_related_to_incident");
  }
  if (c.serviceUsers.length > 0 || type === "safeguarding_concern" || type === "sexual_safety") {
    keys.add("safeguarding.concern");
    const concern = c.answers.tri("safeguarding.concern");
    if (concern === "yes" || concern === "unsure") keys.add("safeguarding.types");
  }
  const ulcers = c.affectedServiceUsers.flatMap((p) => p.pressureUlcers ?? []);
  if (pressureUlcerGuide(ulcers, c.answers) === "ask") {
    keys.add("pressure_ulcer.neglect_concern");
    keys.add("pressure_ulcer.severe_impact");
  }
  keys.add("police.involved");
  if (SERVICE_TYPES.includes(type)) {
    for (const k of CLASSIFIER_QUESTION_KEYS) if (k.startsWith("service.")) keys.add(k);
  }
  if (riddorPossible(c)) {
    keys.add("riddor.work_connected");
    const gate = c.answers.tri("riddor.work_connected");
    if (gate === "yes" || gate === "unsure") {
      if (c.anyoneDied || c.affectedNotAtWork.length > 0) keys.add("riddor.excluded_cause");
      if (c.affectedWorkers.length > 0) {
        keys.add("riddor.worker_specified_injury");
        keys.add("riddor.worker_incapacity_days");
      }
      if (c.affectedNotAtWork.length > 0) keys.add("riddor.non_worker_to_hospital");
      if (DANGEROUS_OCCURRENCE_TYPES.includes(type)) keys.add("riddor.dangerous_occurrence");
    }
  }
  if (type === "fall") {
    keys.add("falls.head_injury");
    keys.add("falls.anticoagulant");
  }
  return CLASSIFIER_QUESTION_KEYS.filter((k) => keys.has(k) && !c.answers.has(k));
}

const SEVERE_ULCERS = ["category_3", "category_4", "unstageable", "deep_tissue_injury"];

/**
 * DHSC pressure ulcer protocol (2024): complete the adult safeguarding decision guide where severe
 * damage is suspected, which "may be indicated in some cases by multiple category 2 or single
 * category 3 or 4 ulcers, but could also be indicated by the impact the pressure damage has on the
 * person affected (for example, pain)". Unstageable and deep tissue injury are treated as severe
 * (they can hide full-thickness damage): Harbour's reading, for the CSO to confirm (H-66).
 */
function pressureUlcerGuide(
  ulcers: readonly string[],
  answers: AnswerBook,
): "guide" | "ask" | "none" {
  if (ulcers.some((u) => SEVERE_ULCERS.includes(u))) return "guide";
  const category2 = ulcers.filter((u) => u === "category_2").length;
  if (category2 > 1) return "guide";
  if (category2 === 0) return "none";
  const concern = [
    answers.tri("pressure_ulcer.neglect_concern"),
    answers.tri("pressure_ulcer.severe_impact"),
  ];
  return concern.includes("yes") || concern.includes("unsure") ? "guide" : "ask";
}

// ---------------------------------------------------------------------------------------------
// The classifier

function earliest(dates: readonly Date[]): Date {
  return dates.reduce((a, b) => (b.getTime() < a.getTime() ? b : a));
}

/** Classifies one incident. Pure: the API stores the result with `CLASSIFIER_VERSION`. */
export function classifyIncident(input: ClassifierInput): ClassifierResult {
  const { facts } = input;
  if (!(CLASSIFIER_NATIONS as readonly string[]).includes(facts.nation)) {
    return {
      classifierVersion: CLASSIFIER_VERSION,
      nationSupported: false,
      outputs: [],
      exclusions: [],
      pending: [],
      tasks: [],
      openQuestions: [],
      reasoning: [
        "Notifications for locations outside England are not checked yet: the nation pack arrives in Phase 7. Follow your regulator's notification procedure.",
      ],
    };
  }
  const c = context(input);
  const evaluations = new Map<StatutoryNotificationKind, Evaluation>();
  evaluations.set("cqc_reg16_death", reg16Death(c));
  evaluations.set("cqc_reg18_serious_injury", reg18SeriousInjury(c));
  evaluations.set("cqc_reg18_abuse", reg18Abuse(c));
  const specific = (
    ["cqc_reg16_death", "cqc_reg18_serious_injury", "cqc_reg18_abuse"] as const
  ).filter((k) => evaluations.get(k)?.status === "required");
  evaluations.set("cqc_reg18_police", reg18Police(c, specific));
  evaluations.set("cqc_reg18_service_disruption", reg18ServiceDisruption(c));
  evaluations.set(
    "cqc_reg18_dols_outcome",
    excluded(
      "Drafted from the DoLS register when the outcome of an application is known (dolsCqcNotification), not from an incident.",
      [REG18("reg 18(4A) and (4B)")],
    ),
  );
  for (const kind of [
    "riddor_death",
    "riddor_specified_injury",
    "riddor_non_worker_hospital",
    "riddor_over_7_day",
    "riddor_dangerous_occurrence",
  ] as const) {
    evaluations.set(kind, riddor(c, kind));
  }
  evaluations.set("safeguarding_s42", s42Referral(c));
  evaluations.set("candour", candour(c, input.candourDecision));
  evaluations.set("leder", leder(c));
  evaluations.set("ukhsa_outbreak", outbreak(input.outbreak));
  evaluations.set("medical_examiner", medicalExaminer(c));
  evaluations.set("police_missing_person", missingPerson(c));

  const outputs: RequiredOutput[] = [];
  const exclusions: ExcludedOutput[] = [];
  const pending: PendingOutput[] = [];
  const reasoning: string[] = [];
  for (const kind of STATUTORY_NOTIFICATION_KINDS) {
    const evaluation = evaluations.get(kind) as Evaluation;
    const info = NOTIFICATION_KINDS[kind];
    if (evaluation.status === "excluded") {
      const sources = evaluation.sources ?? [info.source];
      exclusions.push({ kind, reason: evaluation.reason, sources });
      reasoning.push(`${kind}: not required. ${evaluation.reason}`);
      continue;
    }
    if (evaluation.status === "pending") {
      pending.push({ kind, waitingFor: [...new Set(evaluation.waitingFor)] });
      reasoning.push(`${kind}: waiting for ${[...new Set(evaluation.waitingFor)].join(", ")}.`);
      continue;
    }
    const start = evaluation.start ?? facts.occurredAt;
    const due = deadlines(kind, start, input);
    const provisional = evaluation.finding.value === "unsure";
    const reasons = [...evaluation.finding.because, ...(evaluation.extraReasons ?? [])];
    outputs.push({
      kind,
      personRefs: evaluation.personRefs,
      dueAt: earliest(due.map((d) => d.dueAt)),
      deadlines: due,
      reasons,
      sources: kind === "medical_examiner" ? MEDICAL_EXAMINER_SOURCES : sourcesFor(kind),
      provisional,
      requiredContent: evaluation.requiredContent ?? [],
    });
    reasoning.push(
      `${kind}: required${provisional ? " (provisional)" : ""}. ${reasons.join("; ")}.`,
    );
  }

  const openQuestions = relevantQuestions(c);
  const tasks = classifierTasks(c, input, outputs, openQuestions);
  return {
    classifierVersion: CLASSIFIER_VERSION,
    nationSupported: true,
    outputs,
    exclusions,
    pending,
    tasks,
    openQuestions,
    reasoning,
  };
}

function sourcesFor(kind: StatutoryNotificationKind): readonly Citation[] {
  switch (kind) {
    case "cqc_reg16_death":
      return [REG16("reg 16(1) and (3)")];
    case "cqc_reg18_serious_injury":
      return [REG18("reg 18(1), (2)(a), (2)(b) and (5)(g)")];
    case "cqc_reg18_abuse":
      return [REG18("reg 18(2)(e) and (5)(b)")];
    case "cqc_reg18_police":
      return [REG18("reg 18(2)(f)"), CQC_POLICE_FORM, CQC_ABSENCE_FORM];
    case "cqc_reg18_service_disruption":
      return [REG18("reg 18(2)(g)")];
    case "safeguarding_s42":
      return [CARE_ACT, CSG];
    case "candour":
      return [REG20("reg 20(2) to (9)")];
    case "leder":
      return [LEDER];
    case "riddor_death":
    case "riddor_specified_injury":
    case "riddor_non_worker_hospital":
    case "riddor_over_7_day":
    case "riddor_dangerous_occurrence":
      return [NOTIFICATION_KINDS[kind].source, RIDDOR_REG2, RIDDOR_SCH1, HSE_WHEN, HSIS1];
    default:
      return [NOTIFICATION_KINDS[kind].source];
  }
}

function classifierTasks(
  c: Context,
  input: ClassifierInput,
  outputs: readonly RequiredOutput[],
  openQuestions: readonly ClassifierQuestionKey[],
): ClassifierTask[] {
  const tasks: ClassifierTask[] = [];
  const occurredAt = input.facts.occurredAt;
  const affected = refs(c.affectedServiceUsers);
  const has = (kind: StatutoryNotificationKind) => outputs.find((o) => o.kind === kind);

  if (openQuestions.length > 0) {
    tasks.push({
      task: "answer_classifier_questions",
      reason: `Answer the notification questions: the clocks started when the incident happened (${openQuestions.length} open)`,
      dueAt: occurredAt,
      personRefs: affected,
      sources: [MASTER("11.1")],
    });
  }
  const candourOutput = has("candour");
  if (candourOutput && !input.candourDecision) {
    tasks.push({
      task: "candour_threshold_decision",
      reason: "Record the duty of candour threshold decision and who made it",
      dueAt: occurredAt,
      personRefs: candourOutput.personRefs,
      sources: [REG20("reg 20(9)")],
    });
  }
  for (const person of c.affectedServiceUsers) {
    if (pressureUlcerGuide(person.pressureUlcers ?? [], c.answers) === "guide") {
      tasks.push({
        task: "safeguarding_decision_guide",
        reason: `Complete the adult safeguarding decision guide immediately or within ${c.rates.pressureUlcerDecisionGuideHours} hours of identifying the pressure ulcer`,
        dueAt: new Date(occurredAt.getTime() + c.rates.pressureUlcerDecisionGuideHours * 3_600_000),
        personRefs: [person.ref],
        sources: [PU_PROTOCOL],
      });
    }
  }
  if (input.facts.type === "fall") {
    const checklist = postFallChecklist(
      {
        occurredAt,
        headInjury: c.answers.yesNoUnsure("falls.head_injury"),
        anticoagulantOrAntiplatelet: c.answers.yesNoUnsure("falls.anticoagulant"),
      },
      input.rates,
    );
    for (const t of checklist.tasks) {
      tasks.push({
        task: t.task,
        reason: t.reason,
        dueAt: t.dueAt,
        ...(t.until ? { until: t.until } : {}),
        personRefs: affected,
        sources: t.sources,
      });
    }
  }
  if (has("police_missing_person")) {
    const sources = [MASTER("11.1 (missing person)")];
    tasks.push(
      {
        task: "herbert_protocol_to_police",
        reason:
          "Give the police the Herbert Protocol profile (photo, description, places, routines) and record the police reference",
        dueAt: occurredAt,
        personRefs: affected,
        sources,
      },
      {
        task: "missing_person_search_log",
        reason: "Keep the search log",
        dueAt: occurredAt,
        personRefs: affected,
        sources,
      },
      {
        task: "return_welfare_check",
        reason: "Check the person's welfare when they return, and debrief",
        dueAt: null,
        personRefs: affected,
        sources,
      },
    );
  }
  const examiner = has("medical_examiner");
  if (examiner) {
    tasks.push({
      task: "medical_examiner_pack",
      reason: "Assemble the medical examiner information pack",
      dueAt: occurredAt,
      personRefs: examiner.personRefs,
      sources: MEDICAL_EXAMINER_SOURCES,
    });
  }
  const over7 = has("riddor_over_7_day");
  if (c.affectedWorkers.length > 0 && !over7 && c.answers.tri("riddor.work_connected") !== "no") {
    const threshold = c.rates.riddorOver7DayThresholdDays;
    tasks.push({
      task: "riddor_absence_check",
      reason: `Check whether the worker has been unable to do their normal work for more than ${threshold} consecutive days, not counting the day of the accident (RIDDOR reg 4(2))`,
      dueAt: addUkDays(occurredAt, threshold + 1),
      personRefs: refs(c.affectedWorkers),
      sources: [cite("RIDDOR 2013", "reg 4(2)", SOURCES.riddorReg4)],
    });
  }
  const toReview = input.outbreak?.casesToReviewForLinks ?? [];
  if (toReview.length > 0) {
    tasks.push({
      task: "outbreak_link_review",
      reason: `Decide whether these ${toReview.length} diarrhoea and vomiting cases are linked`,
      dueAt: occurredAt,
      personRefs: [],
      sources: [MASTER("11.1 (UKHSA outbreak)")],
    });
  }
  return tasks;
}
