import { describe, expect, it } from "vitest";
import { readRateTable, tableBankHolidays, tableSafetyRates } from "../../test/rate-table";
import { RateNotFoundError } from "../platform/rates";
import { builtinRole } from "../platform/roles";
import { checkWorkflowTransition, type WorkflowTransitionRequest } from "../platform/workflow";
import { citationText } from "../shared/citation";
import { workingDaysDeadline } from "../shared/working-days";
import {
  CANDOUR_WORKFLOW,
  type CandourRecordView,
  type CandourState,
  candourClocks,
  candourStepProblems,
} from "./candour";
import { candourCloseBlock, INCIDENT_WORKFLOW, incidentCloseProblems } from "./incident";
import { MEDICAL_EXAMINER_PACK_SECTIONS, missingPackSections } from "./medical-examiner";
import {
  NOTIFICATION_KINDS,
  notificationClockState,
  STATUTORY_NOTIFICATION_KINDS,
  STATUTORY_NOTIFICATION_WORKFLOW,
  submissionEvidenceProblems,
} from "./notifications";
import { resolveSafetyRates, SAFETY_RATE_KEYS, type SafetyRateName } from "./rates";

/** Safety workflows (safety.md sections 3 and 4 rules 5, 10 and 11). Hazard HZ-013. */

const rates = tableSafetyRates();
const AT = new Date("2026-10-14T13:30:00Z");

const permissionsOf = (role: string) => new Set(builtinRole(role)?.permissions ?? []);

function request<S extends string>(
  to: S,
  o: Partial<WorkflowTransitionRequest<S>> = {},
): WorkflowTransitionRequest<S> {
  return {
    to,
    actorId: "staff-manager",
    permissions: permissionsOf("registered_manager"),
    stepUpFresh: false,
    ...o,
  };
}

describe("hazard HZ-013 safety figures come from the rate table", () => {
  it("resolves every safety key for England", () => {
    for (const name of Object.keys(SAFETY_RATE_KEYS) as SafetyRateName[]) {
      expect(rates[name]).toBeGreaterThan(0);
    }
  });

  it("fails loudly when a figure is missing rather than guessing", () => {
    const rows = readRateTable().filter((r) => r.key !== SAFETY_RATE_KEYS.riddorReportDays);
    expect(() => resolveSafetyRates(rows, "england", "2026-10-11", null)).toThrow(
      RateNotFoundError,
    );
  });
});

describe("hazard HZ-013 incident workflow: the person who raised it cannot close it", () => {
  const raised = { state: "under_review" as const, createdBy: "staff-carer" };
  it.each<[string, Partial<WorkflowTransitionRequest<"closed">>, string | null]>([
    [
      "the person who raised it, even as a manager",
      { actorId: "staff-carer", reason: "Learning shared" },
      "separation_of_duties",
    ],
    ["another manager with a reason", { reason: "Investigation complete, learning shared" }, null],
    ["another manager without a reason", {}, "reason_required"],
    [
      "a care worker",
      { permissions: permissionsOf("care_worker"), reason: "Done" },
      "missing_permission",
    ],
  ])("close by %s", (_name, o, problem) => {
    const check = checkWorkflowTransition(INCIDENT_WORKFLOW, raised, request("closed", o));
    expect(check.ok ? null : check.problem).toBe(problem);
  });

  it("lets anyone working with people report, and a manager reopen a review with a reason", () => {
    expect(permissionsOf("agency_worker").has("safety.incident.report")).toBe(true);
    expect(checkWorkflowTransition(INCIDENT_WORKFLOW, raised, request("open")).ok).toBe(false);
    expect(
      checkWorkflowTransition(
        INCIDENT_WORKFLOW,
        raised,
        request("open", { reason: "More information needed" }),
      ).ok,
    ).toBe(true);
  });

  const NONE = { indicated: false, notifiable: null, personId: null, people: [] };
  const ADA = "person-ada";
  const BEN = "person-ben";

  it.each<[string, Parameters<typeof incidentCloseProblems>[0], number]>([
    [
      "everything done",
      {
        notifications: [
          { kind: "cqc_reg18_abuse", status: "submitted" },
          { kind: "riddor_death", status: "not_required" },
        ],
        openQuestions: [],
        candourState: "closed",
        candour: { indicated: true, notifiable: true, personId: ADA, people: [ADA] },
      },
      0,
    ],
    [
      "a draft notification",
      {
        notifications: [{ kind: "cqc_reg18_abuse", status: "draft" }],
        openQuestions: [],
        candourState: null,
        candour: NONE,
      },
      1,
    ],
    [
      "a candour notification ready but no candour record",
      {
        notifications: [{ kind: "candour", status: "ready" }],
        openQuestions: [],
        candourState: null,
        candour: { ...NONE, indicated: true, people: [ADA] },
      },
      2,
    ],
    [
      "questions still open",
      {
        notifications: [],
        openQuestions: ["police.involved"],
        candourState: null,
        candour: NONE,
      },
      1,
    ],
    [
      "the candour record still open",
      { notifications: [], openQuestions: [], candourState: "written_due", candour: NONE },
      1,
    ],
    [
      "candour not notifiable",
      {
        notifications: [],
        openQuestions: [],
        candourState: "not_notifiable",
        candour: { indicated: true, notifiable: false, personId: ADA, people: [ADA, BEN] },
      },
      0,
    ],
    [
      "candour indicated with no record, the candour notification submitted",
      {
        notifications: [{ kind: "candour", status: "submitted" }],
        openQuestions: [],
        candourState: null,
        candour: { ...NONE, indicated: true, people: [ADA] },
      },
      1,
    ],
    [
      "candour decided notifiable and finished for the only person affected",
      {
        notifications: [],
        openQuestions: [],
        candourState: "no_contact",
        candour: { indicated: false, notifiable: true, personId: ADA, people: [ADA] },
      },
      0,
    ],
    [
      "candour finished for one of two people affected",
      {
        notifications: [],
        openQuestions: [],
        candourState: "closed",
        candour: { indicated: true, notifiable: true, personId: ADA, people: [ADA, BEN] },
      },
      1,
    ],
  ])(
    "hazard HZ-013 a decision cannot close without evidence or a not-notifiable reason: %s",
    (_name, view, count) => {
      expect(incidentCloseProblems(view)).toHaveLength(count);
    },
  );

  it.each<[string, string | null, Parameters<typeof candourCloseBlock>[1], object]>([
    ["nothing indicated, no record", null, NONE, { noRecord: false, open: false, stillToTell: [] }],
    [
      "indicated, no record",
      null,
      { ...NONE, indicated: true, people: [ADA] },
      { noRecord: true, open: false, stillToTell: [] },
    ],
    [
      "indicated for two, no record",
      null,
      { ...NONE, indicated: true, people: [ADA, BEN] },
      { noRecord: true, open: false, stillToTell: [ADA, BEN] },
    ],
    [
      "decided notifiable for two, still open",
      "verbal_due",
      { indicated: false, notifiable: true, personId: ADA, people: [ADA, BEN] },
      { noRecord: false, open: true, stillToTell: [ADA, BEN] },
    ],
    [
      "finished for one of two",
      "closed",
      { indicated: true, notifiable: true, personId: ADA, people: [ADA, BEN] },
      { noRecord: false, open: false, stillToTell: [BEN] },
    ],
    [
      "finished with no relevant person named, for two",
      "closed",
      { indicated: true, notifiable: true, personId: null, people: [ADA, BEN] },
      { noRecord: false, open: false, stillToTell: [ADA, BEN] },
    ],
    [
      "decided not notifiable but not yet finished",
      "threshold_assessment",
      { indicated: false, notifiable: false, personId: ADA, people: [ADA, BEN] },
      { noRecord: false, open: true, stillToTell: [] },
    ],
    [
      "finished as not notifiable",
      "not_notifiable",
      { indicated: true, notifiable: false, personId: ADA, people: [ADA, BEN] },
      { noRecord: false, open: false, stillToTell: [] },
    ],
  ])(
    "hazard HZ-013 the duty of candour lets an incident close only when it is done: %s",
    (_n, state, facts, block) => {
      expect(candourCloseBlock(state, facts)).toEqual(block);
    },
  );
});

describe("hazard HZ-013 only a holder of safety.notification.submit with step-up can submit", () => {
  const ready = { state: "ready" as const, createdBy: "staff-senior" };
  const draft = { state: "draft" as const, createdBy: "staff-senior" };
  it.each<
    [
      string,
      typeof ready | typeof draft,
      "submitted" | "not_required" | "ready",
      Partial<WorkflowTransitionRequest<"submitted" | "not_required" | "ready">>,
      string | null,
    ]
  >([
    ["the Registered Manager after step-up", ready, "submitted", { stepUpFresh: true }, null],
    ["the Registered Manager without step-up", ready, "submitted", {}, "step_up_required"],
    [
      "a deputy manager without an acting-up grant",
      ready,
      "submitted",
      { permissions: permissionsOf("deputy_manager"), stepUpFresh: true },
      "missing_permission",
    ],
    ["straight from a draft", draft, "submitted", { stepUpFresh: true }, "no_such_transition"],
    [
      "not required with a reason and step-up",
      draft,
      "not_required",
      { stepUpFresh: true, reason: "Health care professional confirmed no lasting harm" },
      null,
    ],
    [
      "not required without a reason",
      ready,
      "not_required",
      { stepUpFresh: true },
      "reason_required",
    ],
    [
      "not required without step-up",
      ready,
      "not_required",
      { reason: "Not notifiable" },
      "step_up_required",
    ],
    [
      "marked ready by a nurse",
      draft,
      "ready",
      { permissions: permissionsOf("clinical_lead") },
      null,
    ],
  ])("%s", (_name, instance, to, o, problem) => {
    const check = checkWorkflowTransition(
      STATUTORY_NOTIFICATION_WORKFLOW,
      instance,
      request(to, o),
    );
    expect(check.ok ? null : check.problem).toBe(problem);
  });

  it.each<[string, Parameters<typeof submissionEvidenceProblems>[0], number]>([
    [
      "time and reference",
      { submittedAt: AT, externalReference: "CQC-EXAMPLE-1", evidenceDocumentId: null },
      0,
    ],
    [
      "time and the submitted form",
      { submittedAt: AT, externalReference: null, evidenceDocumentId: "doc-1" },
      0,
    ],
    [
      "no time",
      { submittedAt: null, externalReference: "CQC-EXAMPLE-1", evidenceDocumentId: null },
      1,
    ],
    [
      "a time in the future",
      {
        submittedAt: new Date(AT.getTime() + 60_000),
        externalReference: "CQC-EXAMPLE-1",
        evidenceDocumentId: null,
      },
      1,
    ],
    [
      "no reference or form",
      { submittedAt: AT, externalReference: " ", evidenceDocumentId: null },
      1,
    ],
  ])("submission evidence: %s", (_name, evidence, count) => {
    expect(submissionEvidenceProblems(evidence, AT)).toHaveLength(count);
  });

  it.each([
    ["draft", "due", AT.getTime() + 1],
    ["ready", "overdue", AT.getTime()],
    ["submitted", "done", AT.getTime() + 999_999],
    ["not_required", "done", 0],
  ] as const)("a %s notification is %s", (status, state, at) => {
    expect(
      notificationClockState(
        new Date(AT.getTime() + (state === "due" ? 60_000 : 0)),
        status,
        new Date(at),
      ),
    ).toBe(state);
  });
});

const VERBAL = {
  at: AT,
  byRepresentatives: ["staff-manager"],
  inPerson: true,
  accountGiven: true,
  enquiriesAdvised: true,
  apologyGiven: true,
  writtenRecordId: "doc-verbal",
} as const;
const WRITTEN = {
  sentAt: AT,
  documentId: "doc-letter",
  includesAccount: true,
  includesEnquiries: true,
  includesApology: true,
} as const;

function candourRecord(o: Partial<CandourRecordView> = {}): CandourRecordView {
  return {
    threshold: { notifiable: true, decidedAt: AT, decidedBy: "nurse-dee" },
    verbal: VERBAL,
    contactAttempts: [],
    written: WRITTEN,
    enquiryResultsSharedAt: AT,
    correspondenceDocumentIds: ["doc-letter"],
    ...o,
  };
}

describe("hazard HZ-013 duty of candour steps follow regulation 20", () => {
  it.each<[string, CandourState, Partial<CandourRecordView>, RegExp | null]>([
    ["threshold decided notifiable", "verbal_due", {}, null],
    ["no threshold decision", "verbal_due", { threshold: null }, /threshold decision/],
    ["a not-notifiable step with a notifiable decision", "not_notifiable", {}, /does not match/],
    ["verbal notification complete", "written_due", {}, null],
    ["no verbal notification", "written_due", { verbal: null }, /in person/],
    [
      "no apology",
      "written_due",
      { verbal: { ...VERBAL, apologyGiven: false } },
      /reg 20\(3\)\(d\)/,
    ],
    ["by telephone", "written_due", { verbal: { ...VERBAL, inPerson: false } }, /reg 20\(3\)\(a\)/],
    [
      "nobody named as giving it",
      "written_due",
      { verbal: { ...VERBAL, byRepresentatives: [] } },
      /Record who gave the notification/,
    ],
    [
      "no account of the facts",
      "written_due",
      { verbal: { ...VERBAL, accountGiven: false } },
      /reg 20\(3\)\(b\)/,
    ],
    [
      "no further enquiries advised",
      "written_due",
      { verbal: { ...VERBAL, enquiriesAdvised: false } },
      /reg 20\(3\)\(c\)/,
    ],
    [
      "a written notification with no copy kept",
      "enquiries_open",
      { written: { ...WRITTEN, documentId: null } },
      /reg 20\(6\)/,
    ],
    [
      "a written notification without the account",
      "enquiries_open",
      { written: { ...WRITTEN, includesAccount: false } },
      /reg 20\(4\)\(a\)/,
    ],
    [
      "a written notification without an apology",
      "enquiries_open",
      { written: { ...WRITTEN, includesApology: false } },
      /reg 20\(4\)\(d\)/,
    ],
    ["a step with no data of its own", "threshold_assessment", {}, null],
    [
      "no written record of it",
      "written_due",
      { verbal: { ...VERBAL, writtenRecordId: null } },
      /reg 20\(3\)\(e\)/,
    ],
    [
      "no contact, attempts recorded",
      "no_contact",
      { contactAttempts: [{ at: AT, note: "Phoned twice, no answer" }] },
      null,
    ],
    ["no contact, no attempts recorded", "no_contact", {}, /reg 20\(5\)\(b\)/],
    ["written notification sent", "enquiries_open", {}, null],
    [
      "written notification without enquiries",
      "enquiries_open",
      { written: { ...WRITTEN, includesEnquiries: false } },
      /reg 20\(4\)\(b\)/,
    ],
    ["no written notification", "closed", { written: null }, /reg 20\(4\)/],
    ["results not shared", "closed", { enquiryResultsSharedAt: null }, /reg 20\(4\)\(c\)/],
    ["no correspondence kept", "closed", { correspondenceDocumentIds: [] }, /reg 20\(6\)/],
    ["complete", "closed", {}, null],
  ])("%s", (_name, to, o, problem) => {
    const problems = candourStepProblems(to, candourRecord(o));
    if (problem === null) expect(problems).toEqual([]);
    else expect(problems.join(" ")).toMatch(problem);
  });

  it("needs a reason to record not notifiable or no contact", () => {
    const assessing = { state: "threshold_assessment" as const, createdBy: "staff-senior" };
    expect(
      checkWorkflowTransition(CANDOUR_WORKFLOW, assessing, request("not_notifiable")),
    ).toMatchObject({ ok: false, problem: "reason_required" });
    expect(
      checkWorkflowTransition(
        CANDOUR_WORKFLOW,
        { ...assessing, state: "verbal_due" },
        request("no_contact", { reason: "Family declined to speak to us" }),
      ).ok,
    ).toBe(true);
  });

  it("shows the written target from the threshold decision, never as a statutory deadline (ADR-0021)", () => {
    const england = tableBankHolidays("england");
    const decided = new Date("2027-03-24T10:00:00Z");
    const clocks = candourClocks(AT, decided, rates, england);
    expect(clocks.verbalDueAt).toEqual(decided);
    expect(clocks.writtenTargetAt).toEqual(
      workingDaysDeadline(decided, rates.candourWrittenWorkingDays, england),
    );
    expect(clocks.writtenTargetWording).not.toMatch(/statutory/i);
    expect(clocks.provisional).toBe(false);
    expect(candourClocks(AT, null, rates, england)).toMatchObject({
      verbalDueAt: AT,
      provisional: true,
    });
  });
});

describe("notification kinds and the medical examiner pack", () => {
  it("writes a citation as source and provision for the audit trail", () => {
    expect(citationText(NOTIFICATION_KINDS.cqc_reg18_abuse.source)).toBe(
      "CQC (Registration) Regulations 2009 reg 18(2)(e)",
    );
  });

  it("gives every kind a label, recipient, clock and retention class", () => {
    for (const kind of STATUTORY_NOTIFICATION_KINDS) {
      const info = NOTIFICATION_KINDS[kind];
      expect(info.label).not.toBe("");
      expect(info.recipient).not.toBe("");
      expect(info.retentionClass).toBe(
        kind.startsWith("riddor_") ? "riddor_report" : "serious_incident",
      );
    }
  });

  it("lists the pack sections from safety.md rule 8 and what is still missing", () => {
    expect(MEDICAL_EXAMINER_PACK_SECTIONS.map((s) => s.key)).toEqual([
      "demographics",
      "diagnoses",
      "recent_notes",
      "recent_observations",
      "medicines",
      "advance_care_records",
      "death_circumstances",
    ]);
    expect(missingPackSections(["demographics", "medicines"])).toEqual([
      "diagnoses",
      "recent_notes",
      "recent_observations",
      "advance_care_records",
      "death_circumstances",
    ]);
  });
});
