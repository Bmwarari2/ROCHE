/**
 * Positive risk assessments (master prompt 10.1, Reg 12; care.md section 2 `risk_assessment`;
 * register row CARE-002). The format: the hazard, who is at risk, the assessor's likelihood and
 * severity, the controls, the residual risk, a positive-risk statement where a significant risk is
 * accepted for the person's benefit, and a review date.
 *
 * These are not validated tools. The rating is arithmetic on the assessor's own judgements, banded
 * with the published National Patient Safety Agency matrix (A risk matrix for risk managers, NPSA,
 * January 2008): likelihood 1 rare to 5 almost certain, consequence 1 negligible to 5
 * catastrophic, rating = likelihood x consequence, banded 1 to 3 low, 4 to 6 moderate, 8 to 12 high
 * and 15 to 25 extreme. The bands are the published matrix, not rate-table figures. Harbour never
 * rates falls: NICE NG249 1.1.1 says not to use falls risk prediction tools, so the falls template
 * records answers and controls only (medical-device boundary, section 4).
 *
 * Templates are code constants with a version; tenants may add their own templates in a later
 * phase. Statutory figures (the MHRA bed rail gaps) stay in the rate table: a measurement question
 * names its rate key and is checked against the value passed in.
 */

import { type RateNation, type RateRow, resolveRate } from "../platform/rates";
import { addMonthsToDate, isIsoDate } from "./assessment";

export const RISK_TEMPLATE_VERSION = "harbour-2026-10";

export const RISK_MATRIX_SOURCE =
  "National Patient Safety Agency, A risk matrix for risk managers (January 2008)";

export const LIKELIHOOD_LABELS = [
  "Rare",
  "Unlikely",
  "Possible",
  "Likely",
  "Almost certain",
] as const;
export const SEVERITY_LABELS = [
  "Negligible",
  "Minor",
  "Moderate",
  "Major",
  "Catastrophic",
] as const;

export type RiskBand = "low" | "moderate" | "high" | "extreme";

const BANDS: readonly { readonly upTo: number; readonly band: RiskBand }[] = [
  { upTo: 3, band: "low" },
  { upTo: 6, band: "moderate" },
  { upTo: 12, band: "high" },
  { upTo: 25, band: "extreme" },
];

const SCALE_MIN = 1;
const SCALE_MAX = LIKELIHOOD_LABELS.length;

function onScale(value: number | null | undefined): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= SCALE_MIN && value <= SCALE_MAX
  );
}

export function riskRating(likelihood: number, severity: number): number {
  if (!onScale(likelihood) || !onScale(severity)) {
    throw new RangeError("Likelihood and severity are whole numbers from 1 to 5.");
  }
  return likelihood * severity;
}

export function riskBand(rating: number): RiskBand {
  const found = BANDS.find((b) => rating <= b.upTo);
  if (!found || rating < SCALE_MIN) throw new RangeError(`Not a rating: ${rating}`);
  return found.band;
}

// ------------------------------------------------------------------------------------------------
// MHRA bed rail figures (rate table)
// ------------------------------------------------------------------------------------------------

export const BED_RAIL_RATE_KEYS = {
  betweenBars: "bed_rail.gap_max_mm.between_bars",
  betweenBarsSmallOrAtypical: "bed_rail.gap_max_mm.between_bars_small_or_atypical",
  railToMattress: "bed_rail.gap_max_mm.rail_to_mattress",
  railEndToHeadboard: "bed_rail.gap_max_mm.rail_end_to_headboard",
  heightMin: "bed_rail.height_min_mm",
} as const;

export type BedRailRateKey = (typeof BED_RAIL_RATE_KEYS)[keyof typeof BED_RAIL_RATE_KEYS];
export type BedRailLimits = Readonly<Record<BedRailRateKey, number>>;

export function resolveBedRailLimits(
  rows: readonly RateRow[],
  nation: Exclude<RateNation, "uk" | "all">,
  on: string,
  tenantId: string | null,
): BedRailLimits {
  return Object.fromEntries(
    Object.values(BED_RAIL_RATE_KEYS).map((key) => [
      key,
      resolveRate(rows, key, nation, on, tenantId).value,
    ]),
  ) as BedRailLimits;
}

// ------------------------------------------------------------------------------------------------
// Templates
// ------------------------------------------------------------------------------------------------

export type RiskQuestion =
  | { readonly key: string; readonly text: string; readonly kind: "yes_no" }
  | { readonly key: string; readonly text: string; readonly kind: "text" }
  | {
      readonly key: string;
      readonly text: string;
      readonly kind: "measurement_mm";
      readonly limit: {
        readonly rateKey: BedRailRateKey;
        /** MHRA gaps are "under" the figure; the rail height is "at least" the figure. */
        readonly rule: "under" | "at_least";
        /** A stricter figure applies when the named yes or no question is answered yes. */
        readonly whenYes?: { readonly questionKey: string; readonly rateKey: BedRailRateKey };
      };
    };

export interface RiskTemplate {
  readonly key: RiskTemplateKey;
  readonly title: string;
  readonly version: string;
  /** Where the questions and controls come from. */
  readonly source: string;
  /** `none` for falls: answers and controls only, never a rating. */
  readonly rating: "matrix" | "none";
  readonly questions: readonly RiskQuestion[];
  readonly suggestedControls: readonly string[];
}

export const RISK_TEMPLATE_KEYS = [
  "moving_and_handling",
  "falls",
  "choking",
  "skin",
  "bed_rails",
  "smoking",
  "going_out_alone",
  "financial",
  "environmental",
  "self_harm_and_suicide",
  "sexual_safety",
  "fire_setting",
  "absconding",
  "substance_and_alcohol_use",
  "general",
] as const;

export type RiskTemplateKey = (typeof RISK_TEMPLATE_KEYS)[number];

const yesNo = (key: string, value: string): RiskQuestion => ({
  key,
  text: value,
  kind: "yes_no",
});
const text = (key: string, value: string): RiskQuestion => ({ key, text: value, kind: "text" });

const template = (
  key: RiskTemplateKey,
  title: string,
  source: string,
  questions: readonly RiskQuestion[],
  suggestedControls: readonly string[],
  rating: "matrix" | "none" = "matrix",
): RiskTemplate => ({
  key,
  title,
  version: RISK_TEMPLATE_VERSION,
  source,
  rating,
  questions,
  suggestedControls,
});

const REG_12 =
  "Health and Social Care Act 2008 (Regulated Activities) Regulations 2014, regulation 12";

export const RISK_TEMPLATES: Readonly<Record<RiskTemplateKey, RiskTemplate>> = {
  moving_and_handling: template(
    "moving_and_handling",
    "Moving and handling",
    `${REG_12}; Manual Handling Operations Regulations 1992; Lifting Operations and Lifting Equipment Regulations 1998 (HSE)`,
    [
      yesNo("bears_weight", "Can the person bear their own weight?"),
      yesNo("cooperates", "Can the person understand and help with moves?"),
      yesNo("equipment_needed", "Is equipment needed, such as a hoist, stand aid or slide sheet?"),
      yesNo(
        "equipment_examined",
        "Does the lifting equipment have an in-date thorough examination?",
      ),
      text("equipment_details", "Equipment and sling type and size"),
      text("staff_needed", "How many staff each move needs"),
    ],
    [
      "Use only the equipment and sling named in the plan, checked before each use",
      "The number of staff the plan names for each move",
      "Staff trained in the equipment",
      "Encourage the person to do what they can for themselves",
    ],
  ),
  falls: template(
    "falls",
    "Falls",
    `${REG_12}; NICE NG249 Falls: assessment and prevention (2025), recommendations 1.1.1 to 1.1.7`,
    [
      yesNo("fallen_last_year", "Has the person fallen in the last year?"),
      yesNo("walking_aid", "Does the person use a walking aid?"),
      yesNo("environment_hazards", "Are there hazards around them, such as clutter or poor light?"),
      yesNo("footwear_safe", "Are their footwear and clothing safe for walking?"),
      yesNo(
        "falls_assessment_offered",
        "Has the comprehensive falls assessment from the NICE falls guideline been offered?",
      ),
      text("what_the_person_wants", "What the person wants to keep doing"),
    ],
    [
      "Walking aid within reach",
      "Call bell within reach",
      "Well-fitting footwear",
      "Night light and clear walkways",
      "Ask the GP or pharmacist for a medicines review",
    ],
    "none",
  ),
  choking: template(
    "choking",
    "Choking and swallowing",
    `${REG_12}; IDDSI framework (https://www.iddsi.org/framework); speech and language therapy advice`,
    [
      yesNo("salt_assessed", "Has a speech and language therapist assessed their swallowing?"),
      yesNo("iddsi_food_recorded", "Is the prescribed IDDSI food level on the care profile?"),
      yesNo("iddsi_drink_recorded", "Is the prescribed IDDSI drink level on the care profile?"),
      yesNo(
        "signs_of_difficulty",
        "Are there signs of difficulty, such as coughing, a wet voice or chest infections?",
      ),
      yesNo("needs_supervision", "Does the person need someone with them when eating?"),
    ],
    [
      "Food and drink only at the prescribed IDDSI levels",
      "Sit upright to eat and drink, and afterwards as the therapist advises",
      "Staff with them at meals and snacks",
      "Staff trained in choking first aid",
    ],
  ),
  skin: template(
    "skin",
    "Skin and pressure areas",
    `${REG_12}; NICE CG179 Pressure ulcers: prevention and management (2014)`,
    [
      yesNo("risk_tool_completed", "Has a pressure ulcer risk tool been completed?"),
      yesNo("existing_damage", "Is there existing skin damage on the body map?"),
      yesNo("equipment_in_place", "Is pressure-relieving equipment in place?"),
      yesNo("repositioning_needed", "Does the person need help to change position?"),
      yesNo("moisture", "Is the skin exposed to moisture, such as from incontinence?"),
    ],
    [
      "Repositioning at the interval in the care plan",
      "Pressure-relieving mattress and cushion",
      "Skin check at each personal care visit",
      "Barrier cream and prompt continence care",
    ],
  ),
  bed_rails: template(
    "bed_rails",
    "Bed rails",
    `${REG_12}; MHRA Bed rails: management and safe use (https://www.gov.uk/guidance/bed-rails-management-and-safe-use)`,
    [
      yesNo("risk_of_falling_from_bed", "Is the person at risk of falling out of bed?"),
      yesNo("could_climb_over", "Could the person climb over the rails?"),
      yesNo(
        "entrapment_risk",
        "Is the person at risk of entrapment, for example through confusion or restlessness?",
      ),
      yesNo("small_or_atypical_body", "Does the person have a small or atypical body size?"),
      yesNo(
        "consent_or_best_interests",
        "Is consent or a best-interests decision for the rails recorded?",
      ),
      {
        key: "gap_between_bars_mm",
        text: "Gap between the bars of the rail (mm)",
        kind: "measurement_mm",
        limit: {
          rateKey: BED_RAIL_RATE_KEYS.betweenBars,
          rule: "under",
          whenYes: {
            questionKey: "small_or_atypical_body",
            rateKey: BED_RAIL_RATE_KEYS.betweenBarsSmallOrAtypical,
          },
        },
      },
      {
        key: "gap_rail_to_mattress_mm",
        text: "Gap between the rail and the side of the mattress (mm)",
        kind: "measurement_mm",
        limit: { rateKey: BED_RAIL_RATE_KEYS.railToMattress, rule: "under" },
      },
      {
        key: "gap_rail_end_to_headboard_mm",
        text: "Gap between the end of the rail and the headboard (mm)",
        kind: "measurement_mm",
        limit: { rateKey: BED_RAIL_RATE_KEYS.railEndToHeadboard, rule: "under" },
      },
      {
        key: "rail_height_mm",
        text: "Height of the rail above the uncompressed mattress (mm)",
        kind: "measurement_mm",
        limit: { rateKey: BED_RAIL_RATE_KEYS.heightMin, rule: "at_least" },
      },
    ],
    [
      "Rails, bed and mattress used as one compatible system",
      "Gaps measured at fitting and at each review",
      "Rail bumpers where the plan names them",
      "Consider a low bed and crash mat instead of rails",
    ],
  ),
  smoking: template(
    "smoking",
    "Smoking",
    `${REG_12}; Regulatory Reform (Fire Safety) Order 2005; MHRA advice on emollients and fire`,
    [
      yesNo("smokes", "Does the person smoke or vape?"),
      yesNo("uses_emollients_or_oxygen", "Do they use emollient creams or oxygen?"),
      yesNo("smokes_safely_alone", "Can they smoke safely without someone with them?"),
      yesNo("stores_materials_safely", "Do they keep lighters and cigarettes safely?"),
      text("where_they_smoke", "Where they smoke"),
    ],
    [
      "Agreed smoking place outside the building",
      "Fire-retardant apron or blanket",
      "Lighters kept by staff where agreed with the person",
      "Clothing and bedding changed often when emollients are used",
    ],
  ),
  going_out_alone: template(
    "going_out_alone",
    "Going out alone",
    `${REG_12}; Mental Capacity Act 2005`,
    [
      yesNo("wants_to_go_out", "Does the person want to go out on their own?"),
      yesNo("knows_area", "Do they know their way around the area?"),
      yesNo("road_safety", "Can they cross roads safely?"),
      yesNo("carries_contact", "Do they carry a phone or a card with the home's number?"),
      yesNo("restrictions_apply", "Do DoLS conditions or a court order affect going out?"),
    ],
    [
      "Agreed times to go out and come back",
      "Card with the home's phone number",
      "Up-to-date photograph and description for the missing-person procedure",
    ],
  ),
  financial: template(
    "financial",
    "Money and finances",
    `${REG_12}; Care Act 2014 section 42 (financial abuse)`,
    [
      yesNo("manages_own_money", "Does the person manage their own money?"),
      yesNo("has_authority", "Is there an appointee, attorney or deputy for money?"),
      yesNo("abuse_concerns", "Are there concerns about financial abuse?"),
      yesNo("keeps_cash", "Does the person keep cash in their room?"),
    ],
    [
      "Money held under the home's residents' money procedure with receipts",
      "Lockable storage in the person's room",
      "Safeguarding referral when abuse is suspected",
    ],
  ),
  environmental: template(
    "environmental",
    "Home environment (home care)",
    `${REG_12}; Health and Safety at Work etc. Act 1974 (lone working)`,
    [
      yesNo("safe_access", "Is access to the home safe, including lighting, steps and pets?"),
      yesNo("alarms_working", "Are smoke and carbon monoxide alarms working?"),
      yesNo("trip_hazards", "Are there trip hazards inside the home?"),
      yesNo("lone_working_risk", "Are there risks to staff working alone?"),
      yesNo("entry_arranged", "Are key safe or entry arrangements in place?"),
    ],
    [
      "Agreed entry arrangements recorded in the key safe vault",
      "Staff check in and out of each visit",
      "Report unsafe equipment or alarms to the family or landlord",
    ],
  ),
  self_harm_and_suicide: template(
    "self_harm_and_suicide",
    "Self-harm and suicide",
    `${REG_12}; NICE NG225 Self-harm: assessment, management and preventing recurrence (2022)`,
    [
      yesNo("history", "Has the person harmed themselves or attempted suicide before?"),
      yesNo("current_thoughts", "Have they talked about harming themselves or ending their life?"),
      yesNo("access_to_means", "Do they have access to means, such as stored medicines?"),
      yesNo("mental_health_team", "Is a mental health team involved?"),
      yesNo("crisis_contacts", "Are crisis contacts recorded?"),
    ],
    [
      "Crisis plan with named contacts",
      "Medicines stored and given by staff",
      "Referral to the mental health team",
      "Agreed level of staff support",
    ],
  ),
  sexual_safety: template(
    "sexual_safety",
    "Sexual safety",
    `${REG_12}; CQC Promoting sexual safety through empowerment (2019); Mental Capacity Act 2005`,
    [
      yesNo("vulnerable", "Are there concerns about the person's own sexual safety?"),
      yesNo("behaviour_towards_others", "Are there concerns about their behaviour towards others?"),
      yesNo("capacity_assessed", "Has capacity to consent to sexual relations been assessed?"),
      yesNo("safeguarding_involved", "Is safeguarding involved?"),
    ],
    [
      "Respect the person's privacy and relationships",
      "Safeguarding referral when abuse is suspected",
      "Staff aware of the relationship plan",
    ],
  ),
  fire_setting: template(
    "fire_setting",
    "Fire-setting",
    `${REG_12}; Regulatory Reform (Fire Safety) Order 2005`,
    [
      yesNo("history", "Has the person set fires before?"),
      yesNo("access_to_ignition", "Do they have access to lighters or matches?"),
      yesNo("detection_in_room", "Is there fire detection in their room?"),
      yesNo("peep_in_place", "Is a personal emergency evacuation plan in place?"),
    ],
    [
      "Lighters and matches kept by staff where agreed",
      "Fire detection checked in the person's room",
      "Personal emergency evacuation plan up to date",
    ],
  ),
  absconding: template(
    "absconding",
    "Leaving without staff knowing",
    `${REG_12}; Mental Capacity Act 2005 (DoLS); the Herbert Protocol missing-person scheme`,
    [
      yesNo("left_before", "Has the person left without staff knowing before?"),
      yesNo("dols_in_place", "Is the person subject to a DoLS authorisation?"),
      yesNo("exit_seeking", "Do they show signs of wanting to leave?"),
      yesNo("profile_current", "Is the missing-person profile up to date?"),
    ],
    [
      "Missing-person procedure and profile (Herbert Protocol)",
      "Meaningful activity at the times they try to leave",
      "Door alerts used only as the person's plan allows",
    ],
  ),
  substance_and_alcohol_use: template(
    "substance_and_alcohol_use",
    "Alcohol and substance use",
    `${REG_12}; Mental Capacity Act 2005`,
    [
      yesNo("uses_alcohol_or_substances", "Does the person drink alcohol or use other substances?"),
      yesNo("medicine_interactions", "Could it interact with their prescribed medicines?"),
      yesNo("affects_safety", "Does it affect their falls, behaviour or health?"),
      yesNo("arrangements_agreed", "Are arrangements agreed, such as where alcohol is kept?"),
    ],
    [
      "Agreed arrangements written in the plan",
      "Ask the GP or pharmacist about interactions",
      "Referral to specialist support when the person wants it",
    ],
  ),
  general: template(
    "general",
    "Other risk",
    `${REG_12}`,
    [text("what_the_person_wants", "What the person wants to do")],
    [],
  ),
};

// ------------------------------------------------------------------------------------------------
// Checking an assessment
// ------------------------------------------------------------------------------------------------

export interface RiskAssessmentInput {
  readonly templateKey: RiskTemplateKey;
  readonly hazard: string;
  readonly whoAtRisk: string;
  readonly answers: Readonly<Record<string, unknown>>;
  readonly likelihood: number | null;
  readonly severity: number | null;
  readonly residualLikelihood: number | null;
  readonly residualSeverity: number | null;
  readonly controls: readonly string[];
  readonly positiveRiskStatement: string | null;
  readonly assessedOn: string;
  /** Defaults to the care plan review interval; never later than it. */
  readonly reviewDueOn: string | null;
}

export interface MeasurementFinding {
  readonly questionKey: string;
  readonly valueMm: number;
  readonly rateKey: BedRailRateKey;
  readonly limitMm: number;
  readonly rule: "under" | "at_least";
  readonly withinLimit: boolean;
}

export interface CheckedRiskAssessment {
  readonly rating: number | null;
  readonly band: RiskBand | null;
  readonly residualRating: number | null;
  readonly residualBand: RiskBand | null;
  readonly findings: readonly MeasurementFinding[];
  /** True when any measurement is outside the MHRA figure: shown to the assessor and reviewer. */
  readonly outsideLimits: boolean;
  readonly reviewDueOn: string;
}

export type RiskField =
  | "templateKey"
  | "hazard"
  | "whoAtRisk"
  | "answers"
  | "likelihood"
  | "severity"
  | "residualLikelihood"
  | "residualSeverity"
  | "controls"
  | "positiveRiskStatement"
  | "assessedOn"
  | "reviewDueOn";

export interface RiskIssue {
  readonly field: RiskField;
  readonly message: string;
}

export type RiskCheck =
  | { readonly ok: true; readonly value: CheckedRiskAssessment }
  | { readonly ok: false; readonly issues: readonly RiskIssue[] };

const filled = (value: string | null | undefined) => (value?.trim().length ?? 0) > 0;
const ACCEPTANCE_NEEDS_STATEMENT: readonly RiskBand[] = ["high", "extreme"];

function checkAnswers(
  template: RiskTemplate,
  answers: Readonly<Record<string, unknown>>,
  limits: BedRailLimits,
  issues: RiskIssue[],
): MeasurementFinding[] {
  const known = new Set(template.questions.map((q) => q.key));
  for (const key of Object.keys(answers)) {
    if (!known.has(key)) {
      issues.push({ field: "answers", message: `"${key}" is not a question on this template.` });
    }
  }
  const findings: MeasurementFinding[] = [];
  for (const question of template.questions) {
    const answer = answers[question.key];
    if (question.kind === "text") {
      if (answer !== undefined && answer !== null && typeof answer !== "string") {
        issues.push({ field: "answers", message: `Answer "${question.text}" in words.` });
      }
      continue;
    }
    if (question.kind === "yes_no") {
      if (typeof answer !== "boolean") {
        issues.push({ field: "answers", message: `Answer yes or no: ${question.text}` });
      }
      continue;
    }
    if (typeof answer !== "number" || !Number.isFinite(answer) || answer < 0) {
      issues.push({ field: "answers", message: `Measure in millimetres: ${question.text}` });
      continue;
    }
    const stricter = question.limit.whenYes;
    const rateKey =
      stricter && answers[stricter.questionKey] === true
        ? stricter.rateKey
        : question.limit.rateKey;
    const limitMm = limits[rateKey];
    findings.push({
      questionKey: question.key,
      valueMm: answer,
      rateKey,
      limitMm,
      rule: question.limit.rule,
      withinLimit: question.limit.rule === "under" ? answer < limitMm : answer >= limitMm,
    });
  }
  return findings;
}

export function checkRiskAssessment(
  input: RiskAssessmentInput,
  context: { readonly limits: BedRailLimits; readonly reviewIntervalMonths: number },
): RiskCheck {
  const template = RISK_TEMPLATES[input.templateKey];
  if (!template) {
    return {
      ok: false,
      issues: [{ field: "templateKey", message: "Choose one of the risk assessment templates." }],
    };
  }
  const issues: RiskIssue[] = [];
  if (!filled(input.hazard)) issues.push({ field: "hazard", message: "Describe the hazard." });
  if (!filled(input.whoAtRisk)) {
    issues.push({ field: "whoAtRisk", message: "Say who is at risk." });
  }
  if (input.controls.length === 0 || input.controls.some((c) => !filled(c))) {
    issues.push({ field: "controls", message: "Record the controls in place, one per line." });
  }
  const findings = checkAnswers(template, input.answers, context.limits, issues);

  let rating: number | null = null;
  let residualRating: number | null = null;
  const scales = [
    ["likelihood", input.likelihood],
    ["severity", input.severity],
    ["residualLikelihood", input.residualLikelihood],
    ["residualSeverity", input.residualSeverity],
  ] as const;
  if (template.rating === "none") {
    for (const [field, value] of scales) {
      if (value !== null) {
        issues.push({
          field,
          message:
            "Falls are not rated: NICE NG249 advises against falls risk prediction. Record the answers and controls.",
        });
      }
    }
  } else {
    for (const [field, value] of scales) {
      if (!onScale(value)) {
        issues.push({ field, message: "Choose a value from 1 to 5." });
      }
    }
    if (onScale(input.likelihood) && onScale(input.severity)) {
      rating = riskRating(input.likelihood, input.severity);
    }
    if (onScale(input.residualLikelihood) && onScale(input.residualSeverity)) {
      residualRating = riskRating(input.residualLikelihood, input.residualSeverity);
    }
    if (rating !== null && residualRating !== null && residualRating > rating) {
      issues.push({
        field: "residualLikelihood",
        message: "The risk with controls in place cannot be higher than the risk without them.",
      });
    }
    if (
      residualRating !== null &&
      ACCEPTANCE_NEEDS_STATEMENT.includes(riskBand(residualRating)) &&
      !filled(input.positiveRiskStatement)
    ) {
      issues.push({
        field: "positiveRiskStatement",
        message: "Explain why the person's choice is supported while a high risk remains.",
      });
    }
  }

  let reviewDueOn = input.reviewDueOn;
  if (!isIsoDate(input.assessedOn)) {
    issues.push({ field: "assessedOn", message: "The assessment date must be a real date." });
  } else {
    const latest = addMonthsToDate(input.assessedOn, context.reviewIntervalMonths);
    if (reviewDueOn === null) reviewDueOn = latest;
    else if (!isIsoDate(reviewDueOn) || reviewDueOn < input.assessedOn || reviewDueOn > latest) {
      issues.push({
        field: "reviewDueOn",
        message:
          "Review the assessment at least as often as the care plan, after the assessment date.",
      });
    }
  }

  if (issues.length > 0 || reviewDueOn === null) return { ok: false, issues };
  return {
    ok: true,
    value: {
      rating,
      band: rating === null ? null : riskBand(rating),
      residualRating,
      residualBand: residualRating === null ? null : riskBand(residualRating),
      findings,
      outsideLimits: findings.some((f) => !f.withinLimit),
      reviewDueOn,
    },
  };
}
