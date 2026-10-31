/**
 * Refusals the API makes by rule, recognised so the form can say them in the catalogue's words
 * (CONTENT.md: one voice, translatable) and put the error at the fields it is about.
 *
 * The API's problem details carry the code "invalid" and its rule's message, but no rule code or
 * field yet (an API gap in docs/specs/care.md section 10), so a refusal is recognised by the words
 * of the rule in packages/domain. refusals.test.ts runs each rule in the domain package and checks
 * it is recognised here, so a changed message fails the test rather than going unnoticed. A
 * refusal not listed here still reaches the person, in the API's words. Several issues can come
 * joined in one message, so each is looked for anywhere in it. No regular expressions: plain
 * substring checks only.
 */

export type RefusalKey =
  | "futureEntry"
  | "correctionReason"
  | "recordClosed"
  | "sideMismatch"
  | "sideNotAllowed"
  | "regionNotOnView"
  | "pressureCategory"
  | "deviceRelated"
  | "bruiseExplained"
  | "iddsiUnsafe"
  | "iddsiMismatch"
  | "iddsiLevel"
  | "prescribedInvalid"
  | "restrictionReason"
  | "visitor"
  | "endBeforeStart"
  | "endInFuture"
  | "engagement"
  | "respectCpr"
  | "dnacprAttempt"
  | "cprOnOtherRecord"
  | "clinicianName"
  | "clinicianRole"
  | "completedOn"
  | "reviewAfterCompleted"
  | "withdrawReason"
  | "representativeName"
  | "authority"
  | "unableReason"
  | "hazard"
  | "whoAtRisk"
  | "controls"
  | "scale"
  | "residualHigher"
  | "positiveRisk"
  | "assessedOn"
  | "riskReview"
  | "iddsiAdvisedBy"
  | "scale2Clinician"
  | "incidentClosed"
  | "incidentLocation"
  | "classifierAnswer"
  | "closeNotifications"
  | "closeQuestions"
  | "closeCandour"
  | "stepReason"
  | "stepNotPossible"
  | "stepFinished"
  | "notificationFinished"
  | "submittedAtMissing"
  | "submittedInFuture"
  | "submissionReference"
  | "candourPerson"
  | "candourDecidedInFuture"
  | "candourThreshold"
  | "candourThresholdMismatch"
  | "candourVerbal"
  | "candourInPerson"
  | "candourRepresentatives"
  | "candourAccount"
  | "candourEnquiriesAdvised"
  | "candourApology"
  | "candourWrittenRecord"
  | "candourAttempts"
  | "candourWritten"
  | "candourWrittenCopy"
  | "candourWrittenAccount"
  | "candourWrittenEnquiries"
  | "candourWrittenApology"
  | "candourResults"
  | "candourCorrespondence"
  | "investigationComplete"
  | "investigationPerson"
  | "investigationOwner"
  | "closeCandourRecord"
  | "closeCandourPeople"
  | "candourDecidedBeforeIncident"
  | "candourToldFuture"
  | "candourSentFuture"
  | "candourAttemptFuture"
  | "candourResultsFuture"
  | "candourDocument"
  | "candourStepPerson"
  | "candourPersonFinished"
  | "candourReason"
  | "candourConfirm"
  | "candourToldEarly"
  | "candourSentEarly"
  | "candourAttemptEarly"
  | "candourPersonDropped";

export interface KnownRefusal {
  readonly key: RefusalKey;
  /** The form fields the refusal is about, by their names. */
  readonly fields: readonly string[];
}

interface Rule extends KnownRefusal {
  readonly found: (detail: string) => boolean;
}

const has = (text: string) => (detail: string) => detail.includes(text);
const hasBoth = (a: string, b: string) => (detail: string) =>
  detail.includes(a) && detail.includes(b);

const RULES: readonly Rule[] = [
  // Entry times (care.md rule 3) and corrections (rule 4).
  {
    key: "futureEntry",
    fields: ["occurredAt"],
    found: has("The time of the event is in the future."),
  },
  {
    key: "correctionReason",
    fields: ["reason"],
    found: has("Say why the entry is being corrected."),
  },
  {
    key: "recordClosed",
    fields: [],
    found: has("record is closed; only post-event notes can be added."),
  },
  // Body map (HZ-019).
  {
    key: "sideMismatch",
    fields: ["side", "region"],
    found: hasBoth("The mark is drawn on ", "Check the side and try again."),
  },
  {
    key: "sideNotAllowed",
    fields: ["side"],
    found: has(" must be on the person's left or right."),
  },
  { key: "regionNotOnView", fields: ["region"], found: has("Choose a body area shown on the ") },
  {
    key: "pressureCategory",
    fields: ["pressureCategory"],
    found: has("Pressure ulcer category is missing."),
  },
  {
    key: "deviceRelated",
    fields: ["deviceRelated"],
    found: has("Say whether the pressure ulcer is related to a medical device."),
  },
  {
    key: "bruiseExplained",
    fields: ["bruiseExplained"],
    found: has("Say whether the cause of the bruise is known."),
  },
  // IDDSI (HZ-016): the unsafe wording is checked before the plain one.
  {
    key: "iddsiUnsafe",
    fields: ["overrideReason", "iddsiLevel"],
    found: hasBoth("This is not the prescribed ", "may not be safe."),
  },
  {
    key: "iddsiMismatch",
    fields: ["overrideReason", "iddsiLevel"],
    found: (detail) =>
      detail.includes("This is not the prescribed ") && !detail.includes("may not be safe."),
  },
  // An unknown level, or none when one is needed (a drink with a drink level prescribed).
  {
    key: "iddsiLevel",
    fields: ["iddsiLevel"],
    found: (detail) => detail.includes("Choose an IDDSI ") || detail.includes("Choose the IDDSI "),
  },
  { key: "prescribedInvalid", fields: [], found: has(" level is not an IDDSI level.") },
  // Visits and activities (Regulation 9A).
  {
    key: "restrictionReason",
    fields: ["restrictionReason"],
    found: has("say why a restriction was needed for this visit."),
  },
  {
    key: "visitor",
    fields: ["visitorName"],
    found: has("Choose the visitor from the person's contacts or write their name."),
  },
  {
    key: "endBeforeStart",
    fields: ["endedAt"],
    found: has("The visit cannot end before it started."),
  },
  { key: "endInFuture", fields: ["endedAt"], found: has("The end of the visit is in the future.") },
  { key: "engagement", fields: ["engagement"], found: has("Record how the person engaged.") },
  // Advance care records (HZ-015).
  {
    key: "respectCpr",
    fields: ["cprDecision"],
    found: has("Record the CPR recommendation from section 4 of the ReSPECT form."),
  },
  {
    key: "dnacprAttempt",
    fields: ["kind"],
    found: has("A DNACPR decision means do not attempt CPR."),
  },
  {
    key: "cprOnOtherRecord",
    fields: ["kind"],
    found: has("Record a CPR decision on a ReSPECT or DNACPR record"),
  },
  {
    key: "clinicianName",
    fields: ["clinicianName"],
    found: has("Record the clinician who made the decision."),
  },
  { key: "clinicianRole", fields: ["clinicianRole"], found: has("Record the clinician's role.") },
  {
    key: "completedOn",
    fields: ["completedOn"],
    found: has("The date completed must be a real date, today or earlier."),
  },
  {
    key: "reviewAfterCompleted",
    fields: ["reviewDueOn"],
    found: has("The review date must be on or after the date completed."),
  },
  {
    key: "withdrawReason",
    fields: ["reason"],
    found: has("Say why the record is withdrawn, and by whom."),
  },
  // Care plan sign-off (HZ-024).
  {
    key: "representativeName",
    fields: ["representativeName"],
    found: has("Record who agreed the plan for the person."),
  },
  {
    key: "authority",
    fields: ["authority"],
    found: has("Record the representative's authority"),
  },
  {
    key: "unableReason",
    fields: ["unableReason"],
    found: has("Say why the person or a representative could not agree the plan."),
  },
  // Risk assessments.
  { key: "hazard", fields: ["hazard"], found: has("Describe the hazard.") },
  { key: "whoAtRisk", fields: ["whoAtRisk"], found: has("Say who is at risk.") },
  {
    key: "controls",
    fields: ["otherControls"],
    found: has("Record the controls in place, one per line."),
  },
  { key: "scale", fields: ["likelihood"], found: has("Choose a value from 1 to 5.") },
  {
    key: "residualHigher",
    fields: ["residualLikelihood"],
    found: has("The risk with controls in place cannot be higher than the risk without them."),
  },
  {
    key: "positiveRisk",
    fields: ["positiveRiskStatement"],
    found: has("Explain why the person's choice is supported while a high risk remains."),
  },
  {
    key: "assessedOn",
    fields: ["assessedOn"],
    found: has("The assessment date must be a real date."),
  },
  {
    key: "riskReview",
    fields: ["reviewDueOn"],
    found: has("Review the assessment at least as often as the care plan"),
  },
  // Chart settings (the API's own checks in apps/api/src/routes/care.ts, not domain rules).
  {
    key: "iddsiAdvisedBy",
    fields: ["iddsiAdvisedBy"],
    found: has("Say who advised the IDDSI level"),
  },
  {
    key: "scale2Clinician",
    fields: ["spo2Scale2Clinician"],
    found: has("Record the clinician who decided to use SpO2 scale 2."),
  },
  // Incidents (the API's own checks in apps/api/src/routes/incidents.ts) and the classifier's
  // answers (`classifierAnswerProblem` in packages/domain, prefixed by the question's key).
  {
    key: "incidentClosed",
    fields: [],
    found: has("A closed incident cannot be changed."),
  },
  { key: "incidentLocation", fields: ["location"], found: has("The location was not found.") },
  {
    key: "classifierAnswer",
    fields: [],
    found: (detail) =>
      detail.includes("Answer yes, no or not sure yet.") ||
      detail.includes(", or not sure yet.") ||
      detail.includes("Choose one of the options.") ||
      detail.includes("Choose one or more of the options"),
  },
  // Closing an incident (`incidentCloseProblems`, HZ-013) and the workflow's steps
  // (`checkWorkflowTransition`), for an incident or a statutory notification.
  {
    key: "closeNotifications",
    fields: [],
    found: has("Submit or mark not required with a reason: "),
  },
  {
    key: "closeQuestions",
    fields: [],
    found: has("Answer the notification questions before closing."),
  },
  {
    key: "closeCandour",
    fields: [],
    found: has("Complete the duty of candour record before closing."),
  },
  {
    key: "closeCandourRecord",
    fields: [],
    found: has("Record the duty of candour threshold decision before closing."),
  },
  {
    key: "closeCandourPeople",
    fields: [],
    found: has("Someone affected has no finished duty of candour record of their own"),
  },
  { key: "stepReason", fields: ["reason"], found: has("Give a reason for this step.") },
  {
    key: "stepNotPossible",
    fields: [],
    found: has("That step is not possible from the record's current state."),
  },
  { key: "stepFinished", fields: [], found: has("This record is closed and cannot move on.") },
  // Statutory notifications (the API's own check, and `submissionEvidenceProblems`).
  {
    key: "notificationFinished",
    fields: [],
    found: has("A submitted or not-required notification cannot be changed."),
  },
  {
    key: "submittedAtMissing",
    fields: ["submittedAt"],
    found: has("Record when the notification was submitted."),
  },
  {
    key: "submittedInFuture",
    fields: ["submittedAt"],
    found: has("The submission time cannot be in the future."),
  },
  {
    key: "submissionReference",
    fields: ["externalReference"],
    found: has("Record the regulator's reference or attach the submitted form."),
  },
  // The duty of candour record (the API's own checks, and `candourStepProblems`, which a step
  // runs first; regulation 20). A step's needs are said beside the step, never at a field.
  {
    key: "candourPerson",
    fields: ["personId"],
    found: has("The relevant person must be one of the people affected."),
  },
  {
    key: "candourDecidedInFuture",
    fields: ["decidedAt"],
    found: has("The decision cannot be dated in the future."),
  },
  {
    key: "candourDecidedBeforeIncident",
    fields: ["decidedAt"],
    found: has("The decision cannot be dated before the incident happened."),
  },
  {
    key: "candourToldFuture",
    fields: ["at"],
    found: has("The time they were told cannot be in the future."),
  },
  {
    key: "candourSentFuture",
    fields: ["sentAt"],
    found: has("The time the written notification was sent cannot be in the future."),
  },
  {
    key: "candourAttemptFuture",
    fields: ["attemptAt"],
    found: has("The time of an attempt to contact them cannot be in the future."),
  },
  {
    key: "candourResultsFuture",
    fields: ["resultsSharedAt"],
    found: has("The time the results were shared cannot be in the future."),
  },
  {
    key: "candourDocument",
    fields: [],
    found: has("A document cited must be on the relevant person's record."),
  },
  {
    key: "candourStepPerson",
    fields: [],
    found: has("Choose who it happened to, from the people affected, before moving the record on."),
  },
  {
    key: "candourPersonFinished",
    fields: ["personId"],
    found: has("The relevant person cannot change once the record is finished."),
  },
  {
    key: "candourReason",
    fields: ["reason"],
    found: has("the decision differs from Harbour's finding or changes the one recorded."),
  },
  { key: "candourConfirm", fields: ["confirm"], found: has("Confirm the decision.") },
  {
    key: "candourToldEarly",
    fields: ["at"],
    found: has("The time they were told cannot be before the incident happened."),
  },
  {
    key: "candourSentEarly",
    fields: ["sentAt"],
    found: has("The time the written notification was sent cannot be before the incident"),
  },
  {
    key: "candourAttemptEarly",
    fields: ["attemptAt"],
    found: has("The time of an attempt to contact them cannot be before the incident"),
  },
  {
    key: "candourPersonDropped",
    fields: [],
    found: has("Someone affected would leave the duty of candour check"),
  },
  {
    key: "candourThreshold",
    fields: [],
    found: has("Record the threshold decision and who made it."),
  },
  {
    key: "candourThresholdMismatch",
    fields: [],
    found: has("The threshold decision does not match this step."),
  },
  { key: "candourVerbal", fields: [], found: has("Record the notification given in person.") },
  {
    key: "candourInPerson",
    fields: [],
    found: has("The notification must be given in person (reg 20(3)(a))."),
  },
  {
    key: "candourRepresentatives",
    fields: [],
    found: has("Record who gave the notification (reg 20(3)(a))."),
  },
  {
    key: "candourAccount",
    fields: [],
    found: has("Give an account of all the facts known (reg 20(3)(b))."),
  },
  {
    key: "candourEnquiriesAdvised",
    fields: [],
    found: has("Advise what further enquiries are appropriate (reg 20(3)(c))."),
  },
  { key: "candourApology", fields: [], found: has("Include an apology (reg 20(3)(d)).") },
  {
    key: "candourWrittenRecord",
    fields: [],
    found: has("Keep a written record of the notification (reg 20(3)(e))."),
  },
  {
    key: "candourAttempts",
    fields: [],
    found: has("Keep a written record of the attempts to contact or speak to the person"),
  },
  {
    key: "candourWritten",
    fields: [],
    found: has("Record the written notification (reg 20(4))."),
  },
  {
    key: "candourWrittenCopy",
    fields: [],
    found: has("Keep a copy of the written notification (reg 20(6))."),
  },
  {
    key: "candourWrittenAccount",
    fields: [],
    found: has("The written notification must include the account of the facts (reg 20(4)(a))."),
  },
  {
    key: "candourWrittenEnquiries",
    fields: [],
    found: has("The written notification must give details of the enquiries (reg 20(4)(b))."),
  },
  {
    key: "candourWrittenApology",
    fields: [],
    found: has("The written notification must include an apology (reg 20(4)(d))."),
  },
  {
    key: "candourResults",
    fields: [],
    found: has("Share the results of any further enquiries (reg 20(4)(c))."),
  },
  {
    key: "candourCorrespondence",
    fields: [],
    found: has("Keep a copy of all correspondence (reg 20(6))."),
  },
  // The investigation (the API's own checks in apps/api/src/routes/incidents.ts).
  {
    key: "investigationComplete",
    fields: ["findings", "lessons"],
    found: has("Record the findings and the lessons before completing it."),
  },
  {
    key: "investigationPerson",
    fields: [],
    found: (detail) =>
      detail.includes("The action owner was not found.") ||
      detail.includes("The investigation lead was not found."),
  },
  {
    key: "investigationOwner",
    fields: ["newOwner"],
    found: has("The action's owner cannot be given its task"),
  },
];

/** The refusals the API's message contains, in the order the rules are listed. */
export function knownRefusals(detail: string): KnownRefusal[] {
  if (!detail) return [];
  return RULES.filter((rule) => rule.found(detail)).map(({ key, fields }) => ({ key, fields }));
}
