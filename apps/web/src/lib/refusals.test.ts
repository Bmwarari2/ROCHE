import {
  BED_RAIL_RATE_KEYS,
  type BedRailLimits,
  type ClassifierQuestionKey,
  candourStepProblems,
  checkActivity,
  checkAdvanceCareRecord,
  checkEntryTime,
  checkIddsiEntry,
  checkRiskAssessment,
  checkSignOff,
  checkVisit,
  checkWithdrawal,
  checkWorkflowTransition,
  classifierAnswerProblem,
  INCIDENT_WORKFLOW,
  incidentCloseProblems,
  STATUTORY_NOTIFICATION_WORKFLOW,
  submissionEvidenceProblems,
  validateMark,
} from "@harbour/domain";
import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import { problemMessage } from "./outcome";
import { knownRefusals, type RefusalKey } from "./refusals";

/**
 * Each rule is run in packages/domain, which the API runs, and its message must be recognised:
 * a reworded rule fails here instead of reaching people untranslated and untied to its field.
 */

const t = createTranslator("en-GB");

/** The message of a failed check, as the API sends it in problem details. */
function messageOf(check: unknown): string {
  const failed = check as {
    ok: boolean;
    message?: string;
    issues?: readonly { message: string }[];
  };
  expect(failed.ok).toBe(false);
  return failed.issues
    ? failed.issues.map((issue) => issue.message).join(" ")
    : (failed.message ?? "");
}

const keysOf = (detail: string): RefusalKey[] => knownRefusals(detail).map((r) => r.key);

const limits = Object.fromEntries(
  Object.values(BED_RAIL_RATE_KEYS).map((key) => [key, 0]),
) as BedRailLimits;

const risk = {
  templateKey: "going_out_alone",
  hazard: "Ada wants to walk to the shop.",
  whoAtRisk: "Ada",
  answers: {},
  likelihood: 3,
  severity: 3,
  residualLikelihood: 2,
  residualSeverity: 3,
  controls: ["Card with the home's phone number"],
  positiveRiskStatement: null,
  assessedOn: "2026-10-11",
  reviewDueOn: null,
} as const;

const visit = {
  kind: "facilitated_visit",
  contactId: null,
  visitorName: "Rhys Example",
  startedAt: new Date("2026-10-11T10:00:00Z"),
  endedAt: null,
  restrictionsApplied: false,
  restrictionReason: null,
} as const;

const advance = {
  kind: "dnacpr",
  cprDecision: null,
  clinicianName: "Dr Ivy Example",
  clinicianRole: "GP",
  completedOn: "2026-10-01",
  reviewDueOn: null,
  today: "2026-10-11",
} as const;

describe("refusals the API makes by rule", () => {
  it.each<[string, () => unknown, RefusalKey]>([
    [
      "a future entry (HZ-010)",
      () =>
        checkEntryTime(new Date("2026-10-11T12:00:00Z"), new Date("2026-10-11T10:00:00Z"), {
          lateEntryHours: 4,
          clockDriftMinutes: 5,
        }),
      "futureEntry",
    ],
    [
      "a side that disagrees with the drawing (HZ-019)",
      () =>
        validateMark({
          view: "front",
          region: "knee",
          drawnSide: "left",
          statedSide: "right",
          markType: "bruise",
          bruiseExplained: true,
        }),
      "sideMismatch",
    ],
    [
      "a paired area on the midline (HZ-019)",
      () =>
        validateMark({
          view: "front",
          region: "knee",
          drawnSide: "midline",
          statedSide: "midline",
          markType: "bruise",
          bruiseExplained: true,
        }),
      "sideNotAllowed",
    ],
    [
      "an area not on the view",
      () =>
        validateMark({
          view: "back",
          region: "chest",
          drawnSide: "midline",
          statedSide: "midline",
          markType: "rash",
        }),
      "regionNotOnView",
    ],
    [
      "a pressure ulcer without its category",
      () =>
        validateMark({
          view: "back",
          region: "sacrum",
          drawnSide: "midline",
          statedSide: "midline",
          markType: "pressure_ulcer",
          deviceRelated: false,
        }),
      "pressureCategory",
    ],
    [
      "an unsafe texture without a reason (HZ-016)",
      () => checkIddsiEntry({ kind: "food", prescribed: "5", recorded: "6" }),
      "iddsiUnsafe",
    ],
    [
      "a safer texture without a reason (HZ-016)",
      () => checkIddsiEntry({ kind: "food", prescribed: "6", recorded: "5" }),
      "iddsiMismatch",
    ],
    [
      "hazard HZ-016 a drink without its level while a drink level is prescribed",
      () => checkIddsiEntry({ kind: "drink", prescribed: "2", recorded: null }),
      "iddsiLevel",
    ],
    [
      "a restriction without its reason (Regulation 9A)",
      () => checkVisit({ ...visit, restrictionsApplied: true }, new Date("2026-10-11T12:00:00Z")),
      "restrictionReason",
    ],
    [
      "a visit that ends before it started",
      () =>
        checkVisit(
          { ...visit, endedAt: new Date("2026-10-11T09:00:00Z") },
          new Date("2026-10-11T12:00:00Z"),
        ),
      "endBeforeStart",
    ],
    [
      "a visitor without a name",
      () => checkVisit({ ...visit, visitorName: " " }, new Date("2026-10-11T12:00:00Z")),
      "visitor",
    ],
    [
      "attendance without engagement",
      () =>
        checkActivity({
          format: "one_to_one",
          groupSessionId: null,
          attendance: "attended",
          engagement: null,
        }),
      "engagement",
    ],
    [
      "a ReSPECT plan without its CPR recommendation (HZ-015)",
      () => checkAdvanceCareRecord({ ...advance, kind: "respect" }),
      "respectCpr",
    ],
    [
      "a DNACPR record without its clinician",
      () => checkAdvanceCareRecord({ ...advance, clinicianName: null }),
      "clinicianName",
    ],
    [
      "a review date before the date completed",
      () => checkAdvanceCareRecord({ ...advance, reviewDueOn: "2026-09-01" }),
      "reviewAfterCompleted",
    ],
    ["a withdrawal without a reason", () => checkWithdrawal(""), "withdrawReason"],
    [
      "a sign-off by a representative without their name (HZ-024)",
      () => checkSignOff({ agreedBy: "representative", authority: "lpa_health_welfare" }),
      "representativeName",
    ],
    [
      "a sign-off by a representative without their authority (HZ-024)",
      () => checkSignOff({ agreedBy: "representative", representativeName: "Rhys Example" }),
      "authority",
    ],
    [
      "a sign-off nobody could give, without the reason (HZ-024)",
      () => checkSignOff({ agreedBy: "unable", reason: "n/a" }),
      "unableReason",
    ],
    [
      "a risk assessment without its hazard",
      () => checkRiskAssessment({ ...risk, hazard: " " }, { limits, reviewIntervalMonths: 6 }),
      "hazard",
    ],
    [
      "a residual risk higher than the risk",
      () =>
        checkRiskAssessment(
          { ...risk, residualLikelihood: 5, residualSeverity: 5 },
          { limits, reviewIntervalMonths: 6 },
        ),
      "residualHigher",
    ],
    [
      "a high risk kept without a positive risk statement",
      () =>
        checkRiskAssessment(
          { ...risk, likelihood: 5, severity: 4, residualLikelihood: 4, residualSeverity: 4 },
          { limits, reviewIntervalMonths: 6 },
        ),
      "positiveRisk",
    ],
    [
      "a review date later than the care plan's",
      () =>
        checkRiskAssessment(
          { ...risk, reviewDueOn: "2028-01-01" },
          { limits, reviewIntervalMonths: 6 },
        ),
      "riskReview",
    ],
  ])("recognises %s", (_name, check, key) => {
    expect(keysOf(messageOf(check()))).toContain(key);
  });

  it("finds every issue when the API joins several into one message", () => {
    const detail = messageOf(
      checkRiskAssessment(
        { ...risk, hazard: "", whoAtRisk: "", controls: [] },
        { limits, reviewIntervalMonths: 6 },
      ),
    );
    expect(keysOf(detail)).toEqual(["hazard", "whoAtRisk", "controls"]);
  });

  it("recognises the API's own chart settings checks", () => {
    expect(
      keysOf("Say who advised the IDDSI level (for example the speech and language therapist)."),
    ).toEqual(["iddsiAdvisedBy"]);
    expect(keysOf("Record the clinician who decided to use SpO2 scale 2.")).toEqual([
      "scale2Clinician",
    ]);
  });

  it("hazard HZ-013 recognises the API's incident checks and the classifier's answer rules", () => {
    expect(keysOf("A closed incident cannot be changed.")).toEqual(["incidentClosed"]);
    expect(keysOf("The location was not found.")).toEqual(["incidentLocation"]);
    const answers: [ClassifierQuestionKey, unknown][] = [
      ["police.involved", "maybe"],
      ["harm.pain_days", -1],
      ["service.utility_interruption_hours", 1.5],
      ["riddor.excluded_cause", "weather"],
      ["safeguarding.types", ["none", "physical"]],
    ];
    for (const [key, value] of answers) {
      const problem = classifierAnswerProblem(key, value as never);
      expect(problem, key).not.toBeNull();
      // The API sends "<key>: <problem>".
      expect(keysOf(`${key}: ${problem}`), key).toEqual(["classifierAnswer"]);
    }
  });

  it("knows nothing in an unknown or empty message", () => {
    expect(knownRefusals("Something new the API says.")).toEqual([]);
    expect(knownRefusals("")).toEqual([]);
  });
});

describe("problemMessage", () => {
  it("hazard HZ-019 says a side mismatch in the catalogue's words, at the side and the area", () => {
    const detail = messageOf(
      validateMark({
        view: "front",
        region: "knee",
        drawnSide: "left",
        statedSide: "right",
        markType: "bruise",
        bruiseExplained: true,
      }),
    );
    const problem = problemMessage({ code: "invalid", detail }, t);
    expect(problem.message).toBe(t("care.refusal.sideMismatch"));
    expect(problem.fields).toEqual({
      side: t("care.refusal.sideMismatch"),
      region: t("care.refusal.sideMismatch"),
    });
  });

  it("hazard HZ-016 puts a texture without its reason at the reason and the level", () => {
    const detail = messageOf(checkIddsiEntry({ kind: "food", prescribed: "5", recorded: "6" }));
    const problem = problemMessage({ code: "invalid", detail }, t);
    expect(Object.keys(problem.fields ?? {})).toEqual(["overrideReason", "iddsiLevel"]);
    expect(problem.message).toMatch(/may not be safe/);
  });

  it("shows an unknown refusal in the API's words, and hides technical paths", () => {
    expect(problemMessage({ code: "invalid", detail: "A new rule says no." }, t)).toEqual({
      code: "invalid",
      message: "A new rule says no.",
    });
    expect(problemMessage({ code: "invalid", detail: "values.ml: Too small" }, t).message).toBe(
      t("care.errors.invalid"),
    );
  });
});

describe("closing an incident and the notifications (HZ-013)", () => {
  const step = (definition: typeof INCIDENT_WORKFLOW, state: "open" | "closed", reason = "") =>
    checkWorkflowTransition(
      definition,
      { state, createdBy: "a" },
      {
        to: "closed",
        actorId: "b",
        permissions: new Set(["safety.incident.manage"]),
        reason,
        stepUpFresh: true,
      },
    );

  it("hazard HZ-013 knows every reason closing is refused, joined as the API joins them", () => {
    const detail = incidentCloseProblems({
      notifications: [{ kind: "cqc_reg16_death", status: "draft" }],
      openQuestions: ["death.expected"],
      candourState: "verbal_due",
      candour: { indicated: true, notifiable: true, personId: "a", people: ["a", "b"] },
    }).join(" ");
    expect(keysOf(detail)).toEqual([
      "closeNotifications",
      "closeQuestions",
      "closeCandour",
      "closeCandourPeople",
    ]);
    const none = incidentCloseProblems({
      notifications: [],
      openQuestions: [],
      candourState: null,
      candour: { indicated: true, notifiable: null, personId: null, people: ["a"] },
    }).join(" ");
    expect(keysOf(none)).toEqual(["closeCandourRecord"]);
  });

  it("knows the workflow's refusals", () => {
    expect(keysOf(messageOf(step(INCIDENT_WORKFLOW, "open")))).toEqual(["stepReason"]);
    expect(keysOf(messageOf(step(INCIDENT_WORKFLOW, "closed", "Done.")))).toEqual(["stepFinished"]);
    const submitDraft = checkWorkflowTransition(
      STATUTORY_NOTIFICATION_WORKFLOW,
      { state: "draft", createdBy: "a" },
      {
        to: "submitted",
        actorId: "b",
        permissions: new Set(["safety.notification.submit"]),
        stepUpFresh: true,
      },
    );
    expect(keysOf(messageOf(submitDraft))).toEqual(["stepNotPossible"]);
  });

  it("knows the submission evidence refusals, at their fields", () => {
    const missing = submissionEvidenceProblems(
      { submittedAt: null, externalReference: null, evidenceDocumentId: null },
      new Date(),
    ).join(" ");
    expect(keysOf(missing)).toEqual(["submittedAtMissing", "submissionReference"]);
    const future = submissionEvidenceProblems(
      {
        submittedAt: new Date(Date.now() + 3_600_000),
        externalReference: "R",
        evidenceDocumentId: null,
      },
      new Date(),
    ).join(" ");
    const problem = problemMessage({ code: "invalid", detail: future }, t);
    expect(problem.fields).toEqual({ submittedAt: t("care.refusal.submittedInFuture") });
  });

  it("knows a finished notification", () => {
    expect(keysOf("A submitted or not-required notification cannot be changed.")).toEqual([
      "notificationFinished",
    ]);
  });

  it("says the separation of duties in words a manager can act on", () => {
    const problem = problemMessage({ code: "separation_of_duties", detail: "x" }, t);
    expect(problem).toEqual({
      code: "separation_of_duties",
      message: t("errors.separationOfDuties"),
    });
  });
});

describe("the duty of candour record and the investigation (HZ-013, HZ-091)", () => {
  const nothing = {
    threshold: null,
    verbal: null,
    contactAttempts: [],
    written: null,
    enquiryResultsSharedAt: null,
    correspondenceDocumentIds: [],
  };

  it("hazard HZ-091 knows every reason a candour step is refused, joined as the API joins them", () => {
    const verbal = candourStepProblems("written_due", {
      ...nothing,
      verbal: {
        at: new Date(),
        byRepresentatives: [],
        inPerson: false,
        accountGiven: false,
        enquiriesAdvised: false,
        apologyGiven: false,
        writtenRecordId: null,
      },
    }).join(" ");
    expect(keysOf(verbal)).toEqual([
      "candourInPerson",
      "candourRepresentatives",
      "candourAccount",
      "candourEnquiriesAdvised",
      "candourApology",
      "candourWrittenRecord",
    ]);
    const written = candourStepProblems("closed", {
      ...nothing,
      written: {
        sentAt: new Date(),
        documentId: null,
        includesAccount: false,
        includesEnquiries: false,
        includesApology: false,
      },
    }).join(" ");
    expect(keysOf(written)).toEqual([
      "candourWrittenCopy",
      "candourWrittenAccount",
      "candourWrittenEnquiries",
      "candourWrittenApology",
      "candourResults",
      "candourCorrespondence",
    ]);
    expect(keysOf(candourStepProblems("verbal_due", nothing).join(" "))).toEqual([
      "candourThreshold",
    ]);
    expect(keysOf(candourStepProblems("no_contact", nothing).join(" "))).toEqual([
      "candourAttempts",
    ]);
    expect(keysOf(candourStepProblems("enquiries_open", nothing).join(" "))).toEqual([
      "candourWritten",
    ]);
    expect(keysOf(candourStepProblems("written_due", nothing).join(" "))).toEqual([
      "candourVerbal",
    ]);
    const mismatch = candourStepProblems("not_notifiable", {
      ...nothing,
      threshold: { notifiable: true, decidedAt: new Date(), decidedBy: "A nurse" },
    }).join(" ");
    expect(keysOf(mismatch)).toEqual(["candourThresholdMismatch"]);
  });

  it("knows the API's own candour and investigation checks, at their fields", () => {
    expect(
      problemMessage({ code: "invalid", detail: "The relevant person must be on the incident." }, t)
        .fields,
    ).toEqual({ personId: t("care.refusal.candourPerson") });
    expect(
      problemMessage({ code: "invalid", detail: "The decision cannot be dated in the future." }, t)
        .fields,
    ).toEqual({ decidedAt: t("care.refusal.candourDecidedInFuture") });
    const complete = problemMessage(
      { code: "invalid", detail: "Record the findings and the lessons before completing it." },
      t,
    );
    expect(complete.fields).toEqual({
      findings: t("care.refusal.investigationComplete"),
      lessons: t("care.refusal.investigationComplete"),
    });
    expect(keysOf("The action owner was not found.")).toEqual(["investigationPerson"]);
    expect(keysOf("The investigation lead was not found.")).toEqual(["investigationPerson"]);
    // apps/api/src/routes/incidents.ts: an owner who could never complete the action's task.
    const owner = problemMessage(
      {
        code: "invalid",
        detail:
          "The action's owner cannot be given its task: they do not manage incidents at this location.",
      },
      t,
    );
    expect(owner.fields).toEqual({ newOwner: t("care.refusal.investigationOwner") });
    // apps/api/src/routes/incidents.ts: the candour record's own checks (review L5).
    const at = (detail: string) => problemMessage({ code: "invalid", detail }, t).fields;
    expect(at("The decision cannot be dated before the incident happened.")).toEqual({
      decidedAt: t("care.refusal.candourDecidedBeforeIncident"),
    });
    expect(at("The time they were told cannot be in the future.")).toEqual({
      at: t("care.refusal.candourToldFuture"),
    });
    expect(at("The time the written notification was sent cannot be in the future.")).toEqual({
      sentAt: t("care.refusal.candourSentFuture"),
    });
    expect(at("The time of an attempt to contact them cannot be in the future.")).toEqual({
      attemptAt: t("care.refusal.candourAttemptFuture"),
    });
    expect(at("The time the results were shared cannot be in the future.")).toEqual({
      resultsSharedAt: t("care.refusal.candourResultsFuture"),
    });
    expect(keysOf("A document cited must be on the relevant person's record.")).toEqual([
      "candourDocument",
    ]);
  });
});
