import { describe, expect, it } from "vitest";
import { readRateTable, tableDolsRates } from "../../../test/rate-table";
import { RateNotFoundError } from "../../platform/rates";
import { checkWorkflowTransition } from "../../platform/workflow";
import { addUkDays, addUkMonths, ukEndOfDay, ukStartOfDay } from "../../shared/time";
import {
  authorisationsAwaitingLegalChangeReview,
  checkDolsAuthorisation,
  checkLegalChangeReview,
  DOLS_LEGAL_CHANGE,
  DOLS_LEGAL_CHANGE_REVIEW_WORKFLOW,
  DOLS_RATE_KEYS,
  type DolsAuthorisationView,
  type DolsRateName,
  dolsCqcNotification,
  dolsEndsAt,
  dolsReminders,
  dolsStatus,
  type LegalChangeReviewInput,
  legalChangeReviewEnabled,
  legalChangeStepProblems,
  MULTIFACTORIAL_FACTORS,
  resolveDolsRates,
} from "./dols";

/**
 * DoLS register clocks and the legal-change review (care.md rule 11; CARE-022). Hazard HZ-020:
 * deprivation-of-liberty authorisation lapses unnoticed. Figures come from docs/specs/rates.md.
 */

const rates = tableDolsRates();

function auth(overrides: Partial<DolsAuthorisationView> = {}): DolsAuthorisationView {
  return {
    id: "dols-1",
    type: "standard",
    nation: "england",
    requestedAt: new Date("2026-09-01T10:00:00Z"),
    outcome: "granted",
    outcomeAt: new Date("2026-10-01T09:00:00Z"),
    grantedFrom: ukStartOfDay("2026-10-01"),
    grantedTo: ukEndOfDay("2027-09-30"),
    extensions: [],
    precededByUrgent: false,
    withdrawalReason: null,
    endedAt: null,
    ...overrides,
  };
}

function urgent(overrides: Partial<DolsAuthorisationView> = {}): DolsAuthorisationView {
  const from = new Date("2026-10-20T14:00:00Z");
  return auth({
    type: "urgent",
    requestedAt: from,
    outcomeAt: from,
    grantedFrom: from,
    grantedTo: addUkDays(from, rates.urgentDays),
    ...overrides,
  });
}

describe("DoLS figures come from the rate table", () => {
  it.each(["england", "wales"] as const)("resolves every DoLS key for %s", (nation) => {
    const resolved = resolveDolsRates(readRateTable(), nation, "2026-10-11", null);
    for (const name of Object.keys(DOLS_RATE_KEYS) as DolsRateName[]) {
      expect(resolved[name]).toBeGreaterThan(0);
    }
  });

  it("has no DoLS figures for Scotland, which has its own law", () => {
    expect(() =>
      resolveDolsRates(readRateTable(), "scotland" as never, "2026-10-11", null),
    ).toThrow(RateNotFoundError);
  });
});

describe("hazard HZ-020 DoLS periods stay within Schedule A1", () => {
  const issues = (a: DolsAuthorisationView) =>
    checkDolsAuthorisation(a, rates).map((i) => `${i.item}:${i.problem}`);
  const standardFrom = ukStartOfDay("2026-10-01");

  it.each<[string, DolsAuthorisationView, string[]]>([
    [
      "a standard authorisation of the maximum period",
      auth({ grantedTo: addUkMonths(standardFrom, rates.standardMaxMonths) }),
      [],
    ],
    [
      "a standard authorisation a day longer than the maximum (para 42(2)(b))",
      auth({ grantedTo: addUkDays(addUkMonths(standardFrom, rates.standardMaxMonths), 1) }),
      ["grantedTo:out_of_range"],
    ],
    ["an urgent authorisation of the maximum period", urgent(), []],
    [
      "an urgent authorisation longer than the maximum (para 78(2))",
      urgent({ grantedTo: addUkDays(new Date("2026-10-20T14:00:00Z"), rates.urgentDays + 1) }),
      ["grantedTo:out_of_range"],
    ],
    [
      "one extension within the limit",
      urgent({
        extensions: [
          {
            requestedAt: new Date("2026-10-25T09:00:00Z"),
            outcome: "granted",
            extendedTo: addUkDays(new Date("2026-10-27T14:00:00Z"), rates.urgentExtensionDays),
          },
        ],
      }),
      [],
    ],
    [
      "an extension longer than the limit (para 85(3))",
      urgent({
        extensions: [
          {
            requestedAt: new Date("2026-10-25T09:00:00Z"),
            outcome: "granted",
            extendedTo: addUkDays(new Date("2026-10-27T14:00:00Z"), rates.urgentExtensionDays + 1),
          },
        ],
      }),
      ["extensions.0:out_of_range"],
    ],
    [
      "an extension that ends before the original end",
      urgent({
        extensions: [
          {
            requestedAt: new Date("2026-10-25T09:00:00Z"),
            outcome: "granted",
            extendedTo: new Date("2026-10-26T09:00:00Z"),
          },
        ],
      }),
      ["extensions.0:out_of_range"],
    ],
    [
      "a second request to extend (para 77(4))",
      urgent({
        extensions: [
          { requestedAt: new Date("2026-10-25T09:00:00Z"), outcome: "refused", extendedTo: null },
          { requestedAt: new Date("2026-10-26T09:00:00Z"), outcome: "pending", extendedTo: null },
        ],
      }),
      ["extensions:not_allowed"],
    ],
    [
      "an extension of a standard authorisation",
      auth({
        extensions: [
          { requestedAt: new Date("2026-10-25T09:00:00Z"), outcome: "pending", extendedTo: null },
        ],
      }),
      ["extensions:not_allowed"],
    ],
    ["a court order with no end date", auth({ type: "court_order", grantedTo: null }), []],
    ["a standard authorisation with no end date", auth({ grantedTo: null }), ["grantedTo:missing"]],
    ["granted with no start", auth({ grantedFrom: null }), ["grantedFrom:missing"]],
    [
      "an end before the start",
      auth({ grantedTo: ukStartOfDay("2026-09-01") }),
      ["grantedTo:out_of_range"],
    ],
    ["an outcome with no date", auth({ outcomeAt: null }), ["outcomeAt:missing"]],
    [
      "withdrawn with no reason",
      auth({ outcome: "withdrawn", withdrawalReason: null }),
      ["withdrawalReason:missing"],
    ],
    [
      "still pending",
      auth({ outcome: "pending", outcomeAt: null, grantedFrom: null, grantedTo: null }),
      [],
    ],
  ])("%s", (_name, authorisation, expected) => {
    expect(issues(authorisation)).toEqual(expected);
  });
});

describe("hazard HZ-020 DoLS status and clocks", () => {
  const end = ukEndOfDay("2027-09-30");
  it.each<[string, DolsAuthorisationView, Date, string, number | null]>([
    [
      "a request awaiting the outcome",
      auth({ outcome: "pending", outcomeAt: null }),
      new Date("2026-10-11T09:00:00Z"),
      "requested",
      null,
    ],
    [
      "not granted",
      auth({ outcome: "not_granted" }),
      new Date("2026-10-11T09:00:00Z"),
      "not_granted",
      null,
    ],
    [
      "withdrawn",
      auth({ outcome: "withdrawn", withdrawalReason: "Moved to hospital" }),
      new Date("2026-10-11T09:00:00Z"),
      "withdrawn",
      null,
    ],
    ["granted to start later", auth(), new Date("2026-09-30T09:00:00Z"), "not_started", null],
    ["in force", auth(), new Date("2027-01-15T09:00:00Z"), "active", null],
    [
      "inside the first reminder window",
      auth(),
      addUkDays(end, -rates.firstReminderDays),
      "expiring",
      rates.firstReminderDays,
    ],
    [
      "the moment before the first reminder window",
      auth(),
      new Date(addUkDays(end, -rates.firstReminderDays).getTime() - 60_000),
      "active",
      null,
    ],
    ["at the end", auth(), end, "expired", null],
    [
      "ended early after a review (para 117)",
      auth({ endedAt: new Date("2027-03-01T12:00:00Z") }),
      new Date("2027-03-02T09:00:00Z"),
      "ended",
      null,
    ],
    [
      "a court order with no end date",
      auth({ type: "court_order", grantedTo: null }),
      new Date("2028-01-01T09:00:00Z"),
      "active",
      null,
    ],
  ])("%s", (_name, a, at, status, daysLeft) => {
    const view = dolsStatus(a, rates, at);
    expect(view.status).toBe(status);
    if (daysLeft !== null) expect(view.daysLeft).toBe(daysLeft);
  });

  it("counts the days left in UK days across the October clock change", () => {
    const a = auth({ grantedTo: ukEndOfDay("2026-10-30") });
    expect(dolsStatus(a, rates, ukStartOfDay("2026-10-20")).daysLeft).toBe(11);
  });

  it("ends at the granted extension, or earlier when ended early", () => {
    const extended = addUkDays(new Date("2026-10-27T14:00:00Z"), rates.urgentExtensionDays);
    const withExtension = urgent({
      extensions: [
        { requestedAt: new Date("2026-10-25T09:00:00Z"), outcome: "granted", extendedTo: extended },
      ],
    });
    expect(dolsEndsAt(withExtension)).toEqual(extended);
    expect(dolsEndsAt({ ...withExtension, endedAt: new Date("2026-10-22T10:00:00Z") })).toEqual(
      new Date("2026-10-22T10:00:00Z"),
    );
    expect(dolsEndsAt(auth({ outcome: "pending" }))).toBeNull();
  });
});

describe("hazard HZ-020 DoLS expiry tasks fire before the end of each authorisation type", () => {
  it("reminds the first and second reminder days before a standard authorisation ends", () => {
    const a = auth({
      grantedFrom: ukStartOfDay("2026-11-15"),
      grantedTo: ukEndOfDay("2027-11-14"),
    });
    const reminders = dolsReminders(a, rates);
    expect(reminders.map((r) => [r.key, r.daysBefore])).toEqual([
      ["first", rates.firstReminderDays],
      ["second", rates.secondReminderDays],
    ]);
    // 28 days before 15 November 2027 00:00 GMT crosses the October clock change: still midnight UK time.
    expect(reminders[0]?.dueAt.toISOString()).toBe(
      addUkDays(ukEndOfDay("2027-11-14"), -rates.firstReminderDays).toISOString(),
    );
    expect(reminders[0]?.dueAt.toISOString()).toBe("2027-10-17T23:00:00.000Z");
  });

  it("reminds at the start of an urgent authorisation shorter than the first reminder", () => {
    const reminders = dolsReminders(urgent(), rates);
    expect(reminders).toHaveLength(1);
    expect(reminders[0]?.dueAt).toEqual(new Date("2026-10-20T14:00:00Z"));
  });

  it("moves the reminders to the end of a granted extension", () => {
    const extended = addUkDays(new Date("2026-10-27T14:00:00Z"), rates.urgentExtensionDays);
    const reminders = dolsReminders(
      urgent({
        extensions: [
          {
            requestedAt: new Date("2026-10-25T09:00:00Z"),
            outcome: "granted",
            extendedTo: extended,
          },
        ],
      }),
      rates,
    );
    expect(reminders.every((r) => r.endsAt.getTime() === extended.getTime())).toBe(true);
  });

  it.each<[string, DolsAuthorisationView]>([
    ["a request not yet decided", auth({ outcome: "pending", outcomeAt: null })],
    ["an authorisation ended early", auth({ endedAt: new Date("2027-03-01T12:00:00Z") })],
    ["a court order with no end date", auth({ type: "court_order", grantedTo: null })],
  ])("sends no reminder for %s", (_name, a) => {
    expect(dolsReminders(a, rates)).toEqual([]);
  });
});

describe("hazard HZ-020 a DoLS outcome drafts the CQC notification", () => {
  it.each<[string, DolsAuthorisationView, string]>([
    ["a standard authorisation granted", auth({ precededByUrgent: true }), "Granted"],
    ["a standard authorisation not granted", auth({ outcome: "not_granted" }), "Not granted"],
    [
      "a request withdrawn",
      auth({ outcome: "withdrawn", withdrawalReason: "Person moved home" }),
      "Withdrawn: Person moved home",
    ],
    ["a court application decided", auth({ type: "court_order", grantedTo: null }), "Granted"],
  ])("%s", (_name, a, outcome) => {
    const decision = dolsCqcNotification(a);
    expect(decision.required).toBe(true);
    if (!decision.required) return;
    expect(decision.kind).toBe("cqc_reg18_dols_outcome");
    expect(decision.dueAt).toEqual(a.outcomeAt);
    expect(decision.statement).toMatchObject({
      requestDate: a.requestedAt,
      precededByUrgent: a.precededByUrgent === true,
      outcome,
      outcomeDate: a.outcomeAt,
    });
    expect(decision.sources[0]?.url).toBe(
      "https://www.legislation.gov.uk/uksi/2009/3112/regulation/18",
    );
  });

  it.each<[string, DolsAuthorisationView, RegExp]>([
    [
      "an urgent authorisation on its own",
      urgent(),
      /urgent authorisation is not notified on its own/,
    ],
    [
      "a request still awaiting the outcome",
      auth({ outcome: "pending", outcomeAt: null }),
      /once the outcome is known/,
    ],
    ["a location in Wales", auth({ nation: "wales" }), /Care Inspectorate Wales/],
  ])("is not required for %s", (_name, a, reason) => {
    const decision = dolsCqcNotification(a);
    expect(decision.required).toBe(false);
    expect(decision.reason).toMatch(reason);
  });
});

function review(overrides: Partial<LegalChangeReviewInput> = {}): LegalChangeReviewInput {
  return {
    factors: Object.fromEntries(
      MULTIFACTORIAL_FACTORS.map((f) => [f.key, "Recorded after a visit and the care notes"]),
    ),
    objection: "does_not_object",
    objectionForms: [],
    consent: {
      consciousOfEnvironment: true,
      basicUnderstanding: true,
      expressesAcceptance: true,
      seriousDoubt: false,
    },
    decision: "no_longer_deprived",
    decidedAt: new Date("2026-10-05T10:00:00Z"),
    decidedBy: "staff-3",
    referral: null,
    ...overrides,
  };
}

describe("hazard HZ-020 review of existing authorisations after the June 2026 judgment", () => {
  it("records the judgment, the DHSC guidance and the tenant switch", () => {
    expect(DOLS_LEGAL_CHANGE.judgment).toMatchObject({
      citation: "[2026] UKSC 16",
      decidedOn: "2026-06-02",
    });
    expect(DOLS_LEGAL_CHANGE.guidance).toMatchObject({
      publishedOn: "2026-06-15",
      lastUpdatedOn: "2026-09-22",
    });
    expect(DOLS_LEGAL_CHANGE.guidance.url).toMatch(
      /^https:\/\/www\.gov\.uk\/government\/publications\/changes-to-the-definition-of-deprivation-of-liberty\//,
    );
  });

  it.each<
    [string, string, { flagKey: string; locationId: string | null; enabled: boolean }[], boolean]
  >([
    ["on by default in England", "england", [], true],
    ["on by default in Wales", "wales", [], true],
    [
      "off when the tenant switches it off",
      "england",
      [{ flagKey: DOLS_LEGAL_CHANGE.flag, locationId: null, enabled: false }],
      false,
    ],
    ["never in Scotland, which does not use DoLS", "scotland", [], false],
  ])("is %s", (_name, nation, flags, expected) => {
    expect(legalChangeReviewEnabled(flags, "loc-1", nation)).toBe(expected);
  });

  it.each<[string, Partial<LegalChangeReviewInput>, boolean, RegExp | null]>([
    [
      "no longer deprived: ask the local authority to review",
      {},
      true,
      /only it can end the authorisation/,
    ],
    ["still deprived: the authorisation continues", { decision: "still_deprived" }, false, null],
    ["in doubt: refer", { decision: "in_doubt" }, true, null],
    [
      "objection fluctuates: refer",
      { decision: "still_deprived", objection: "fluctuates" },
      true,
      /fluctuates between appearing content/,
    ],
    [
      "objection unclear: refer",
      { decision: "still_deprived", objection: "unclear" },
      true,
      /in doubt about whether someone is objecting/,
    ],
    [
      "objects",
      { decision: "still_deprived", objection: "objects", objectionForms: ["attempts_to_leave"] },
      false,
      /Any objection would point towards/,
    ],
    [
      "serious doubt about consent",
      {
        decision: "in_doubt",
        consent: {
          consciousOfEnvironment: true,
          basicUnderstanding: true,
          expressesAcceptance: true,
          seriousDoubt: true,
        },
      },
      true,
      /no conclusion of valid consent/,
    ],
  ])("%s", (_name, overrides, referral, prompt) => {
    const check = checkLegalChangeReview(review(overrides));
    expect(check.ok).toBe(true);
    expect(check.referralRequired).toBe(referral);
    if (prompt) expect(check.prompts.join(" ")).toMatch(prompt);
  });

  it("records whether the guidance's signs of valid consent are all present", () => {
    expect(checkLegalChangeReview(review()).consentSignsRecorded).toBe(true);
    expect(checkLegalChangeReview(review({ objection: "objects" })).consentSignsRecorded).toBe(
      false,
    );
  });

  it("needs every factor of the multifactorial test, the objection, consent signs and the decision", () => {
    const check = checkLegalChangeReview(
      review({
        factors: { type: "Locked front door" },
        objection: null,
        consent: {
          consciousOfEnvironment: null,
          basicUnderstanding: true,
          expressesAcceptance: true,
          seriousDoubt: false,
        },
        decision: null,
        decidedAt: null,
        decidedBy: " ",
      }),
    );
    expect(check.ok).toBe(false);
    expect(check.issues.map((i) => i.item)).toEqual([
      "factors.duration",
      "factors.effects",
      "factors.manner",
      "factors.prison_cell_comparison",
      "factors.normality",
      "factors.purpose",
      "objection",
      "consent.consciousOfEnvironment",
      "decision",
      "decidedAt",
      "decidedBy",
    ]);
  });

  const at = new Date("2026-10-11T10:00:00Z");
  it.each<
    [
      string,
      "awaiting_review" | "reviewed" | "referred",
      "reviewed" | "referred" | "closed",
      Partial<LegalChangeReviewInput>,
      Date | null,
      string[],
    ]
  >([
    ["record a complete review", "awaiting_review", "reviewed", {}, null, []],
    [
      "record an incomplete review",
      "awaiting_review",
      "reviewed",
      { decision: null },
      null,
      ["review_incomplete"],
    ],
    ["refer without the referral details", "reviewed", "referred", {}, null, ["referral_missing"]],
    [
      "refer with the referral details",
      "reviewed",
      "referred",
      { referral: { sentAt: at, reference: "LA-EXAMPLE-1" } },
      null,
      [],
    ],
    [
      "close without the referral a 'no longer deprived' decision needs",
      "reviewed",
      "closed",
      {},
      null,
      ["referral_required"],
    ],
    [
      "close when the authorisation continues",
      "reviewed",
      "closed",
      { decision: "still_deprived" },
      null,
      [],
    ],
    ["close after the local authority responds", "referred", "closed", {}, null, []],
    [
      "close without review while still in force",
      "awaiting_review",
      "closed",
      {},
      new Date("2027-01-01T00:00:00Z"),
      ["authorisation_still_in_force"],
    ],
    [
      "close without review once it has ended",
      "awaiting_review",
      "closed",
      {},
      new Date("2026-10-01T00:00:00Z"),
      [],
    ],
  ])("%s", (_name, from, to, overrides, endedAt, expected) => {
    expect(legalChangeStepProblems(from, to, review(overrides), endedAt, at)).toEqual(expected);
  });

  it("needs care.dols.manage and a reason to close", () => {
    const instance = { state: "reviewed" as const, createdBy: "staff-1" };
    const base = {
      actorId: "staff-2",
      stepUpFresh: false,
      permissions: new Set(["care.dols.manage"]),
    };
    expect(
      checkWorkflowTransition(DOLS_LEGAL_CHANGE_REVIEW_WORKFLOW, instance, {
        ...base,
        to: "closed",
      }),
    ).toMatchObject({ ok: false, problem: "reason_required" });
    expect(
      checkWorkflowTransition(DOLS_LEGAL_CHANGE_REVIEW_WORKFLOW, instance, {
        ...base,
        to: "closed",
        reason: "Authorisation continues to its end date",
      }).ok,
    ).toBe(true);
    expect(
      checkWorkflowTransition(DOLS_LEGAL_CHANGE_REVIEW_WORKFLOW, instance, {
        ...base,
        permissions: new Set(),
        to: "referred",
      }),
    ).toMatchObject({ ok: false, problem: "missing_permission" });
  });

  it("lists authorisations granted before the judgment and still in force, soonest ending first", () => {
    const now = new Date("2026-10-11T10:00:00Z");
    const grantedEarlier = (
      id: string,
      endIso: string,
      legalChangeReview: "awaiting_review" | "reviewed" | null = null,
    ) => ({
      ...auth({ id, grantedFrom: ukStartOfDay("2026-03-01"), grantedTo: ukEndOfDay(endIso) }),
      legalChangeReview,
    });
    const list = authorisationsAwaitingLegalChangeReview(
      [
        grantedEarlier("later", "2027-02-27"),
        grantedEarlier("sooner", "2026-11-30", "awaiting_review"),
        grantedEarlier("reviewed", "2026-12-31", "reviewed"),
        grantedEarlier("expired", "2026-09-30"),
        {
          ...auth({
            id: "after",
            grantedFrom: ukStartOfDay("2026-06-02"),
            grantedTo: ukEndOfDay("2027-06-01"),
          }),
          legalChangeReview: null,
        },
        {
          ...auth({ id: "pending", outcome: "pending", grantedFrom: null, grantedTo: null }),
          legalChangeReview: null,
        },
      ],
      rates,
      now,
    );
    expect(list.map((l) => l.authorisation.id)).toEqual(["sooner", "later"]);
  });
});
