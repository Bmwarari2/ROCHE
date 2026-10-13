import type { ConsentDecisionStatus, DolsItem } from "@harbour/contracts";
import { BestInterestsItemKey, ConsentDecisionKind, DolsStatus } from "@harbour/contracts";
import { BEST_INTERESTS_CHECKLIST, FUNCTIONAL_ELEMENT_WORDING } from "@harbour/domain";
import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  BEST_INTERESTS_ITEMS,
  CONSENT_PROBLEMS,
  capacityChip,
  checklistAnswered,
  consentCapacity,
  consentGivenBy,
  consentRecordChip,
  consentRecordState,
  datedTitle,
  decisionView,
  dolsChip,
  dolsClock,
  dolsCqcLines,
  dolsHistoryLines,
  dolsReminders,
  dolsTitle,
  FUNCTIONAL_ELEMENTS,
  lastDayInForce,
  legalReviewView,
  renewedIds,
  reviewOverdue,
  staffName,
} from "./mca";

const t = createTranslator("en-GB");
const RECORD = "0194d000-0000-7000-8600-0000000000c1";
const ASSESSMENT = "0194d000-0000-7000-8600-0000000000c2";
const OTHER = "0194d000-0000-7000-8600-0000000000c3";
const NOW = new Date("2026-10-12T09:00:00Z");
const texts = (lines: readonly { text: string }[]) => lines.map((l) => l.text);

describe("consent by decision (care.md rule 9)", () => {
  const decision = (over: Partial<ConsentDecisionStatus>): ConsentDecisionStatus => ({
    decision: "bed_rails",
    label: "Bed rails",
    status: "none",
    recordId: RECORD,
    message: "English from the API",
    problems: ["no_record"],
    capacity: "assumed",
    capacityReviewOverdue: false,
    ...over,
  });
  const view = (over: Partial<ConsentDecisionStatus>, givenBy = "person" as const) =>
    decisionView(decision(over), [{ id: RECORD, givenBy }], [], "Else", t, NOW);

  it("names every decision the API lists, and every reason consentStatus gives", () => {
    for (const kind of ConsentDecisionKind.options) {
      expect(t("care.mca.decision", { decision: kind })).not.toBe(
        "Decision that could not be read",
      );
    }
    const unknown = t("care.mca.consent.problem", { problem: "other" });
    for (const problem of Object.keys(CONSENT_PROBLEMS)) {
      expect(t("care.mca.consent.problem", { problem }), problem).not.toBe(unknown);
    }
  });

  it.each([
    ["valid", [], "done", "Consent in place", null],
    ["refused", [], "due", "Refused", "Else refused consent for this decision."],
    [
      "none",
      ["no_record"],
      "notRecorded",
      "No consent recorded",
      "Record a consent or refusal before acting on this decision.",
    ],
    ["none", ["withdrawn"], "overdue", "No valid consent", "Consent was withdrawn."],
    [
      "none",
      ["expired", "person_has_capacity_now"],
      "overdue",
      "No valid consent",
      "Consent has expired. Ask again. The person now has capacity for this decision, so the representative's consent no longer applies. Ask the person.",
    ],
    [
      "none",
      ["a_new_reason"],
      "overdue",
      "No valid consent",
      "This consent is not valid. Check the record and ask again.",
    ],
  ] as const)(
    "hazard HZ-026 shows %s %j as %s with its reason in the catalogue's words",
    (status, problems, chip, label, reason) => {
      const found = view({ status, problems: [...problems] });
      expect(found.chip).toMatchObject({ status: chip, label });
      expect(found.reason).toBe(reason);
    },
  );

  it("hazard HZ-026 says who refused, and never shows an unknown status as consent in place", () => {
    expect(view({ status: "refused", problems: [] }, "representative" as "person").reason).toBe(
      "Their representative refused consent for this decision.",
    );
    expect(view({ status: "maybe" as "none", problems: [] }).chip.status).toBe("overdue");
  });

  const assessment = {
    id: ASSESSMENT,
    decisionKind: "bed_rails" as const,
    assessedAt: "2026-10-01T10:00:00Z",
    outcome: "lacks_capacity" as const,
    reviewOn: "2026-10-11",
    superseded: false,
  };

  it("hazard HZ-026 shows the date of the capacity finding, its review date and an overdue review", () => {
    const found = decisionView(
      decision({ capacity: "lacks_capacity", capacityReviewOverdue: true }),
      [],
      [assessment],
      "Else",
      t,
      NOW,
    );
    expect(found.capacity).toBe("Assessed on 01/10/2026 as lacking capacity for this decision");
    expect(found.review).toBe("Review by 11/10/2026");
    expect(found.reviewOverdue).toBe(true);
    const noReview = decisionView(
      decision({ capacity: "lacks_capacity" }),
      [],
      [{ ...assessment, reviewOn: null }],
      "Else",
      t,
      NOW,
    );
    expect(noReview.review).toBe("No review date set");
  });

  it("finds the assessment as the domain does: the correction, not the one it replaced", () => {
    const corrected = { ...assessment, superseded: true, outcome: "has_capacity" as const };
    const correction = { ...assessment, id: RECORD, assessedAt: "2026-09-30T10:00:00Z" };
    const found = decisionView(
      decision({ capacity: "lacks_capacity" }),
      [],
      [corrected, correction],
      "Else",
      t,
      NOW,
    );
    expect(found.capacity).toBe("Assessed on 30/09/2026 as lacking capacity for this decision");
  });

  it("shows only the API's finding when the assessments do not agree with it, and warns on an unknown one", () => {
    const found = decisionView(
      decision({ capacity: "has_capacity" }),
      [],
      [assessment],
      "Else",
      t,
      NOW,
    );
    expect(found.capacity).toBe("Assessed as having capacity for this decision");
    expect(found.review).toBeNull();
    expect(view({}).capacity).toBe("Capacity assumed: no assessment of this decision");
    expect(view({ capacity: "unsure" as "assumed" }).capacity).toBe(
      "The capacity finding for this decision could not be read",
    );
  });
});

describe("DoLS register (care.md rule 11)", () => {
  const dols = (over: Partial<DolsItem>): DolsItem => ({
    id: RECORD,
    personId: RECORD,
    locationId: RECORD,
    type: "standard",
    nation: "england",
    requestedAt: "2026-10-01T09:00:00Z",
    outcome: "granted",
    outcomeAt: "2026-10-05T09:00:00Z",
    grantedFrom: "2026-10-05T09:00:00Z",
    grantedTo: "2027-04-05T09:00:00Z",
    extensions: [],
    precededByUrgent: false,
    precededByAuthorisationId: null,
    withdrawalReason: null,
    endedAt: null,
    endedReason: null,
    conditions: null,
    rprName: null,
    rprContactId: null,
    supervisoryBody: null,
    supervisoryBodyReference: null,
    objectionEvidence: null,
    status: "active",
    endsAt: "2027-04-05T09:00:00Z",
    daysLeft: 175,
    reminders: [],
    cqcNotification: {
      required: true,
      reason: "English from the API",
      notificationId: RECORD,
      status: "submitted",
      dueAt: "2026-10-05T09:00:00Z",
    },
    legalChangeReview: null,
    version: 1,
    ...over,
  });

  it("hazard HZ-020 gives every status the API returns an icon and a word, and warns on an unknown one", () => {
    for (const status of DolsStatus.options) {
      const chip = dolsChip(status, false, t);
      expect(chip.label).not.toBe("Status could not be read");
      expect(chip.icon).toBeTruthy();
    }
    expect(dolsChip("expired", false, t)).toMatchObject({ status: "overdue", label: "Expired" });
    expect(dolsChip("expiring", false, t)).toMatchObject({ status: "due", label: "Ending soon" });
    expect(dolsChip("lapsed", false, t)).toMatchObject({
      status: "overdue",
      label: "Status could not be read",
    });
  });

  it("hazard HZ-020 shows an expired authorisation that a later granted one follows as renewed, not lapsed", () => {
    const expired = dols({
      status: "expired",
      grantedFrom: "2026-04-10T09:00:00Z",
      grantedTo: "2026-10-10T09:00:00Z",
      endsAt: "2026-10-10T09:00:00Z",
    });
    // Granted before the first ended and starting when it ends: no gap.
    const follower = dols({
      id: ASSESSMENT,
      precededByAuthorisationId: RECORD,
      grantedFrom: "2026-10-10T09:00:00Z",
    });
    expect(renewedIds([expired, follower]).has(RECORD)).toBe(true);
    expect(renewedIds([expired, { ...follower, outcome: "pending" }]).has(RECORD)).toBe(false);
    expect(renewedIds([expired, { ...follower, outcome: "not_granted" }]).has(RECORD)).toBe(false);
    // The follower starts after the first ended: a gap with nothing in force stays "Expired".
    const late = {
      ...follower,
      grantedFrom: "2026-10-15T00:00:00Z",
      status: "not_started" as const,
    };
    expect(renewedIds([expired, late]).has(RECORD)).toBe(false);
    // An unknown start or end, or a follower naming one not on the register, is not a renewal.
    expect(renewedIds([expired, { ...follower, grantedFrom: null }]).has(RECORD)).toBe(false);
    expect(renewedIds([{ ...expired, endsAt: null }, follower]).has(RECORD)).toBe(false);
    expect(renewedIds([follower]).has(RECORD)).toBe(false);
    expect(dolsChip("expired", true, t)).toMatchObject({
      status: "neutral",
      icon: "refresh-cw",
      label: "Renewed",
    });
    expect(dolsChip("active", true, t).label).toBe("In force");
  });

  it("names each authorisation and its history link with its date, so several can be told apart", () => {
    const item = dols({ type: "urgent", requestedAt: "2026-10-11T23:30:00Z" });
    expect(dolsTitle(item, t)).toBe("Urgent authorisation of 12/10/2026");
    expect(dolsTitle(item, t, true)).toBe(
      "View the changes to the urgent authorisation of 12/10/2026",
    );
    expect(dolsTitle({ ...item, type: "other" as "urgent" }, t)).toBe(
      "Authorisation of a type that could not be read of 12/10/2026",
    );
  });

  it.each([
    [
      "a midnight end, on the day before its last day",
      "2026-10-20T23:00:00Z",
      "2026-10-19T10:00:00Z",
      "20/10/2026",
      ["In force until the end of 20/10/2026", "The last day in force is tomorrow"],
    ],
    [
      "a midnight end, on its last day",
      "2026-10-20T23:00:00Z",
      "2026-10-20T22:30:00Z",
      "20/10/2026",
      ["In force until the end of 20/10/2026", "Today is the last day in force"],
    ],
    [
      "a 10:00 end, less than a day before it",
      "2026-10-21T09:00:00Z",
      "2026-10-20T12:00:00Z",
      "21/10/2026",
      ["Ends 21/10/2026 10:00", "The last day in force is tomorrow"],
    ],
    [
      "a midnight end after the clocks go back on 25/10/2026",
      "2026-10-26T00:00:00Z",
      "2026-10-23T12:00:00Z",
      "25/10/2026",
      ["In force until the end of 25/10/2026", "2 days until the last day in force"],
    ],
    [
      "a 09:30 end on the day the clocks go back",
      "2026-10-25T09:30:00Z",
      "2026-10-25T01:30:00Z",
      "25/10/2026",
      ["Ends 25/10/2026 09:30 GMT", "Today is the last day in force"],
    ],
  ])("hazard HZ-020 shows %s as its last day in force", (_name, endsAt, now, lastDay, lines) => {
    expect(lastDayInForce(endsAt)).toBe(lastDay.split("/").reverse().join("-"));
    const clock = dolsClock(
      dols({ status: "expiring", grantedFrom: null, endsAt }),
      t,
      new Date(now),
    );
    expect(texts(clock)).toEqual(lines);
    expect(clock[0]?.dateTime).toBe(endsAt);
  });

  it.each([
    [
      "one that has expired at midnight",
      { status: "expired" as const, endsAt: "2026-10-11T23:00:00Z" },
      ["Started 05/10/2026 10:00", "Was in force until the end of 11/10/2026"],
    ],
    [
      "one that ended early",
      { status: "ended" as const, endsAt: "2026-10-11T09:00:00Z" },
      ["Started 05/10/2026 10:00", "Ended 11/10/2026 10:00"],
    ],
    [
      "one that starts later",
      { status: "not_started" as const, grantedFrom: "2026-10-20T09:00:00Z" },
      ["Starts 20/10/2026 10:00", "Ends 05/04/2027 10:00"],
    ],
    [
      "a court order with no end date",
      { status: "active" as const, endsAt: null },
      ["Started 05/10/2026 10:00", "No end date"],
    ],
    [
      "a request awaiting its outcome",
      { status: "requested" as const, grantedFrom: null, endsAt: null },
      [],
    ],
  ])("hazard HZ-020 shows the clock of %s in words and UK dates", (_name, over, lines) => {
    expect(texts(dolsClock(dols(over), t, NOW))).toEqual(lines);
  });

  it("hazard HZ-020 never writes an outcome beside a missing date, and words an unknown outcome as unknown", () => {
    expect(texts(dolsHistoryLines(dols({}), t))).toEqual([
      "Requested from the supervisory body 01/10/2026 10:00",
      "Granted 05/10/2026 10:00",
    ]);
    expect(texts(dolsHistoryLines(dols({ outcomeAt: null }), t))[1]).toBe(
      "Granted, date not recorded",
    );
    expect(texts(dolsHistoryLines(dols({ outcome: "lapsed" as "granted" }), t))[1]).toBe(
      "Outcome could not be read",
    );
    const extended = dols({
      type: "urgent",
      extensions: [
        { requestedAt: "2026-10-08T09:00:00Z", outcome: "granted", extendedTo: null },
        { requestedAt: "2026-10-09T09:00:00Z", outcome: "pending", extendedTo: null },
      ],
    });
    expect(texts(dolsHistoryLines(extended, t)).slice(2)).toEqual([
      "Extension requested 08/10/2026 10:00: granted, new end not recorded",
      "Extension requested 09/10/2026 10:00: awaiting the outcome",
    ]);
  });

  it("hazard HZ-020 lists the expiry reminders while the authorisation is still to end", () => {
    const reminders = [
      { key: "first" as const, daysBefore: 28, dueAt: "2026-10-05T09:00:00Z" },
      { key: "second" as const, daysBefore: 7, dueAt: "2026-11-01T10:00:00Z" },
    ];
    expect(texts(dolsReminders({ status: "active", reminders }, t))).toEqual([
      "Expiry reminder to the Registered Manager: 05/10/2026 10:00",
      "Expiry reminder to the Registered Manager: 01/11/2026 10:00",
    ]);
    expect(dolsReminders({ status: "expired", reminders }, t)).toEqual([]);
    expect(dolsReminders({ status: "ended", reminders }, t)).toEqual([]);
  });

  it("hazard HZ-020 says where the CQC notification stands, or why there is none, in the catalogue's words", () => {
    const cqc = (over: Partial<DolsItem["cqcNotification"]>, item: Partial<DolsItem> = {}) =>
      texts(
        dolsCqcLines(
          dols({ ...item, cqcNotification: { ...dols({}).cqcNotification, ...over } }),
          t,
        ),
      );
    expect(cqc({ status: "draft" })).toEqual([
      "CQC notification drafted, not yet submitted.",
      "Due 05/10/2026 10:00",
    ]);
    expect(cqc({ status: "ready", dueAt: null })).toEqual([
      "CQC notification ready to submit.",
      "No due date recorded",
    ]);
    expect(cqc({ status: "submitted" })).toEqual(["CQC notification submitted."]);
    expect(cqc({ status: null })).toEqual([
      "CQC notification needed but not drafted. Tell the Registered Manager.",
    ]);
    const none = { status: null, required: false };
    expect(cqc(none, { nation: "wales" })[0]).toBe(
      "CQC notifications are for services in England. Follow the notification rules of this home's own regulator.",
    );
    expect(cqc(none, { type: "urgent" })[0]).toMatch(/^An urgent authorisation is not notified/);
    expect(cqc(none, { outcome: "pending" })[0]).toBe(
      "CQC is told once the outcome is known or the request is withdrawn.",
    );
    expect(cqc(none)[0]).toBe("Check with the Registered Manager whether CQC needs to be told.");
    for (const line of [...cqc(none, { nation: "wales" }), ...cqc(none, { type: "urgent" })]) {
      expect(line).not.toMatch(/Phase|reg 18/);
    }
  });

  it("hazard HZ-020 warns, with the next step, when an authorisation from before the June 2026 judgment has no review", () => {
    const before = { grantedFrom: "2026-05-01T09:00:00Z", status: "active" as const };
    const found = legalReviewView(dols(before), t);
    expect(found?.chip).toMatchObject({
      status: "due",
      label: "Review after the legal change: not started",
    });
    expect(found?.text).toMatch(/^The Supreme Court's June 2026 judgment/);
    expect(
      legalReviewView(dols({ ...before, legalChangeReview: "awaiting_review" }), t)?.chip,
    ).not.toBeNull();
    // Granted after the judgment, or no longer in force: no review is called for.
    expect(legalReviewView(dols({ grantedFrom: "2026-06-02T09:00:00Z" }), t)).toBeNull();
    expect(legalReviewView(dols({ ...before, status: "expired" }), t)).toBeNull();
    // A review under way says where it stands; a state the web does not know warns.
    expect(legalReviewView(dols({ ...before, legalChangeReview: "referred" }), t)).toEqual({
      chip: null,
      text: "Review after the legal change: referred to the local authority",
    });
    expect(
      legalReviewView(dols({ ...before, legalChangeReview: "paused" as "closed" }), t)?.chip,
    ).toMatchObject({
      status: "overdue",
      label: "Review after the legal change: could not be read",
    });
  });
});

describe("consent records (care.md rule 9)", () => {
  const decisions = [
    { decision: "bed_rails" as const, status: "valid" as const, recordId: RECORD },
    { decision: "photos" as const, status: "none" as const, recordId: RECORD },
  ];
  const record = (over: Partial<Parameters<typeof consentRecordState>[0]>) => ({
    id: RECORD,
    decision: "bed_rails" as const,
    withdrawnAt: null,
    expiresAt: null,
    ...over,
  });
  const now = new Date("2026-10-12T09:00:00Z");

  it.each([
    ["the record deciding a valid consent", record({}), "in_force", "In force"],
    [
      "a record a later one replaced",
      record({ id: OTHER }),
      "replaced",
      "Replaced by a later record",
    ],
    [
      "a withdrawn record",
      record({ withdrawnAt: "2026-10-01T09:00:00Z" }),
      "withdrawn",
      "Withdrawn",
    ],
    [
      "an expired deciding record",
      record({ decision: "photos", expiresAt: "2026-10-01T09:00:00Z" }),
      "expired",
      "Expired",
    ],
    [
      "a deciding record that is not valid",
      record({ decision: "photos" }),
      "not_valid",
      "Not valid",
    ],
  ] as const)("hazard HZ-026 says where %s stands", (_name, item, state, label) => {
    const found = consentRecordState(item, decisions, now);
    expect(found).toBe(state);
    expect(consentRecordChip(found, t).label).toBe(label);
  });

  it("names the representative with their authority, or the person", () => {
    const representative = {
      kind: "lpa_health_welfare" as const,
      name: "Sam Example",
      excludedDecisions: [],
      deputyDecisions: [],
    };
    expect(consentGivenBy({ givenBy: "representative", representative }, "Else", t)).toBe(
      "Sam Example (health and welfare attorney)",
    );
    expect(consentGivenBy({ givenBy: "person", representative: null }, "Else", t)).toBe("Else");
  });

  it("names staff with their job title when there is one", () => {
    const staff = { id: RECORD, displayName: "Nell Nurse", jobTitle: "Clinical lead" };
    expect(staffName(staff, t)).toBe("Nell Nurse, Clinical lead");
    expect(staffName({ ...staff, jobTitle: null }, t)).toBe("Nell Nurse");
  });
});

describe("capacity and best interests (care.md rules 9 and 10)", () => {
  it("keeps the functional test and the section 4 checklist in the domain's order", () => {
    expect([...FUNCTIONAL_ELEMENTS]).toEqual(Object.keys(FUNCTIONAL_ELEMENT_WORDING));
    expect([...BEST_INTERESTS_ITEMS]).toEqual(BEST_INTERESTS_CHECKLIST.map((item) => item.key));
    expect([...BEST_INTERESTS_ITEMS].sort()).toEqual([...BestInterestsItemKey.options].sort());
    const items = BEST_INTERESTS_ITEMS.map((item) => t("care.mca.bi.item", { item }));
    expect(new Set(items).size).toBe(BEST_INTERESTS_ITEMS.length);
  });

  it("hazard HZ-026 shows the outcome in words, as a finding rather than an alarm", () => {
    expect(capacityChip("lacks_capacity", t)).toMatchObject({
      status: "info",
      label: "Lacks capacity for this decision",
    });
    expect(capacityChip("has_capacity", t)).toMatchObject({
      status: "neutral",
      label: "Has capacity for this decision",
    });
    expect(capacityChip("unsure", t)).toMatchObject({
      status: "overdue",
      label: "Outcome could not be read",
    });
  });

  it("hazard HZ-026 shows a refused consent record as a warning, and its capacity with the assessment's date", () => {
    expect(consentRecordChip("refused", t)).toMatchObject({ status: "due", label: "Refused" });
    const assessments = [{ id: ASSESSMENT, assessedAt: "2026-10-01T10:00:00Z" }];
    const lacking = { capacityStatus: "lacks_capacity" as const, capacityAssessmentId: ASSESSMENT };
    expect(consentCapacity(lacking, assessments, t)).toEqual({
      text: "Assessed on 01/10/2026 as lacking capacity for this decision",
      dateTime: "2026-10-01T10:00:00Z",
    });
    expect(consentCapacity({ ...lacking, capacityAssessmentId: OTHER }, assessments, t).text).toBe(
      "Assessed as lacking capacity for this decision",
    );
    expect(
      consentCapacity({ capacityStatus: "assumed", capacityAssessmentId: null }, assessments, t)
        .text,
    ).toBe("Capacity was assumed");
    expect(
      consentCapacity(
        { capacityStatus: "unsure" as "assumed", capacityAssessmentId: null },
        assessments,
        t,
      ).text,
    ).toBe("The capacity finding could not be read");
  });

  it("names each record with its UK date, and warns on checklist values it does not know", () => {
    expect(datedTitle("Bed rails", "2026-10-11T23:30:00Z", t)).toBe("Bed rails (12/10/2026)");
    expect(t("care.mca.bi.answer", { answer: "maybe", text: "" })).toBe(
      "The answer could not be read",
    );
    expect(t("care.mca.bi.consultee", { kind: "neighbour" })).toBe(
      "Someone whose role could not be read",
    );
  });

  it("compares review dates as UK dates", () => {
    expect(reviewOverdue("2026-10-11", "2026-10-12")).toBe(true);
    expect(reviewOverdue("2026-10-12", "2026-10-12")).toBe(false);
    expect(reviewOverdue(null, "2026-10-12")).toBe(false);
  });

  it("counts the checklist items answered", () => {
    expect(
      checklistAnswered({
        checklist: {
          relevant_circumstances: { answer: "considered", note: "Asked about home." },
          life_sustaining_treatment: { answer: "not_applicable", reason: "Not treatment." },
        },
      }),
    ).toBe(2);
  });
});
