import { describe, expect, it } from "vitest";
import { PCSP_DOMAIN_LABELS, PCSP_DOMAINS } from "../care/care-plan";
import type { PersonStatus } from "../people/lifecycle";
import {
  checkFeedText,
  checkFeedWithdrawal,
  composeFeedItem,
  FEED_PHRASE_PLACEHOLDERS,
  FEED_PHRASES,
  FEED_SOURCE_KINDS,
  FEED_TEXT_MAX_LENGTH,
  type FeedComposeContext,
  type FeedSource,
  photoItemsToWithdraw,
  stripStaffSurnames,
} from "./feed-compose";
import { feedReadabilityLint, findClinicalTerms, findConfirmationTerms } from "./feed-text";
import { FEED_CARE_PLAN_DOMAINS, type FeedPhotoBasis } from "./feed-visibility";

/**
 * Family feed composition (comms.md section 4 rules 4 and 6 to 12). Invented people: Ada Example
 * (the person), residents Dev Sample and Rose Fixture, staff Sam Tester and Jo Bloggs.
 */

const NOW = new Date("2026-10-11T10:00:00Z");
const AT = new Date("2026-10-11T09:00:00Z");
const ADA = "person-ada";

function context(overrides: Partial<FeedComposeContext> = {}): FeedComposeContext {
  return {
    person: { id: ADA, status: "active", name: "Ada", givenName: "Ada", familyName: "Example" },
    otherResidents: [
      { givenName: "Dev", familyName: "Sample" },
      { givenName: "Rose", familyName: "Fixture" },
    ],
    staff: [
      { givenName: "Sam", familyName: "Tester" },
      { givenName: "Jo", familyName: "Bloggs" },
    ],
    staffNames: "first_name_only",
    photoBasis: { ok: true, basis: "consent", consentRecordId: "consent-1" },
    openIncidents: [],
    candourStates: [],
    confirmation: null,
    now: NOW,
    ...overrides,
  };
}

const activity = (
  overrides: Partial<Extract<FeedSource, { kind: "activity" }>> = {},
): FeedSource => ({
  kind: "activity",
  id: "activity-1",
  personId: ADA,
  occurredAt: AT,
  activityName: "the garden club",
  attendance: "attended",
  engagement: "engaged_throughout",
  ...overrides,
});

const note = (
  text: string,
  overrides: Partial<Extract<FeedSource, { kind: "shared_note" }>> = {},
): FeedSource => ({
  kind: "shared_note",
  id: "note-1",
  personId: ADA,
  occurredAt: AT,
  text,
  markedShareableBy: "user-sam",
  markedShareableAt: NOW,
  ...overrides,
});

const photo = (overrides: Partial<Extract<FeedSource, { kind: "photo" }>> = {}): FeedSource => ({
  kind: "photo",
  id: "photo-1",
  personId: ADA,
  occurredAt: AT,
  documentId: "doc-photo",
  caption: null,
  otherPeopleIdentifiable: false,
  markedForFeedBy: "user-sam",
  ...overrides,
});

function composed(source: FeedSource, ctx = context()) {
  const result = composeFeedItem(source, ctx);
  if (!result.ok) throw new Error(`Expected an update, got ${JSON.stringify(result.problems)}`);
  return result;
}

function problems(source: FeedSource, ctx = context()): string[] {
  const result = composeFeedItem(source, ctx);
  return result.ok ? [] : result.problems.map((p) => p.problem);
}

describe("approved phrasing turns records into updates", () => {
  it.each<[string, Partial<Extract<FeedSource, { kind: "activity" }>>, string]>([
    [
      "took part all the way through",
      {},
      "Ada joined the garden club and took part all the way through.",
    ],
    [
      "took part some of the time",
      { engagement: "engaged_some_of_the_time" },
      "Ada joined the garden club and took part some of the time.",
    ],
    [
      "joined briefly",
      { engagement: "engaged_briefly" },
      "Ada joined the garden club for a short while.",
    ],
    [
      "came but did not engage",
      { engagement: "did_not_engage" },
      "Ada came along to the garden club.",
    ],
    [
      "attended with no engagement recorded",
      { engagement: null },
      "Ada came along to the garden club.",
    ],
    [
      "joined part of it",
      { attendance: "partly_attended", engagement: "engaged_briefly" },
      "Ada joined part of the garden club.",
    ],
    [
      "chose not to join",
      { attendance: "declined", engagement: null },
      "Ada chose not to join the garden club this time.",
    ],
  ])("writes an activity the person %s", (_label, overrides, text) => {
    const { item, lint } = composed(activity(overrides));
    expect(item).toMatchObject({
      kind: "activity",
      section: "activities_and_visits",
      text,
      sourceKind: "activity",
      sourceId: "activity-1",
      occurredAt: AT,
      composedAt: NOW,
    });
    expect(lint).toEqual([]);
  });

  it("never shares that a person was not able to join, because the reason may be about health", () => {
    expect(problems(activity({ attendance: "not_able", engagement: null }))).toEqual([
      "not_for_the_feed",
    ]);
  });

  it.each<["facilitated_visit" | "visit_out" | "accompaniment", string, string, string]>([
    ["facilitated_visit", "visit", "activities_and_visits", "Ada had a visitor."],
    ["visit_out", "visit", "activities_and_visits", "Ada went out on a visit."],
    [
      "accompaniment",
      "appointment",
      "appointments",
      "Ada went to an appointment with a member of staff.",
    ],
  ])(
    "writes a %s without the visitor's name or any restriction",
    (visitKind, kind, section, text) => {
      const { item } = composed({
        kind: "visit",
        id: "visit-1",
        personId: ADA,
        occurredAt: AT,
        visitKind,
        endedAt: AT,
        accompanimentPurpose: visitKind === "accompaniment" ? "planned_appointment" : null,
        restrictionsApplied: true,
      });
      expect(item).toMatchObject({ kind, section, text, phraseKey: expect.any(String) });
    },
  );

  it("writes a care plan update with the section's name (an announced section)", () => {
    const { item } = composed({
      kind: "care_plan_update",
      id: "section-1",
      personId: ADA,
      occurredAt: AT,
      domain: "nutrition_and_hydration",
    });
    expect(item).toMatchObject({
      kind: "care_plan_update",
      section: "care_plan",
      carePlanDomain: "nutrition_and_hydration",
      text: "Ada's care plan was updated: nutrition and hydration.",
    });
  });

  it("refuses a care plan section it does not know", () => {
    expect(
      problems({
        kind: "care_plan_update",
        id: "s",
        personId: ADA,
        occurredAt: AT,
        domain: "hobbies",
      }),
    ).toEqual(["unknown_care_plan_domain"]);
  });

  it("writes the finance placeholder with no money figures", () => {
    const { item } = composed({
      kind: "finance_statement",
      id: "statement-1",
      personId: ADA,
      occurredAt: AT,
    });
    expect(item).toMatchObject({
      kind: "finance_statement",
      section: "finance",
      text: "A new statement is ready to view.",
    });
  });

  it("composes nothing clinical: there is no feed kind for observations, charts, assessments, body maps, medicines or incidents", () => {
    expect([...FEED_SOURCE_KINDS]).toEqual([
      "activity",
      "visit",
      "shared_note",
      "photo",
      "care_plan_update",
      "finance_statement",
    ]);
  });
});

describe("hazard HZ-061 approved phrases say what happened, never how the person is", () => {
  const announced = PCSP_DOMAINS.filter((d) => FEED_CARE_PLAN_DOMAINS[d] === "may_appear");
  const filled = Object.entries(FEED_PHRASES).flatMap(([key, phrase]) =>
    (phrase.includes("{domain}") ? announced : ["nutrition_and_hydration" as const]).map((d) => {
      const sample = {
        name: "Ada",
        activity: "the quiz",
        domain: PCSP_DOMAIN_LABELS[d].toLowerCase(),
      };
      let text: string = phrase;
      for (const [placeholder, value] of Object.entries(sample))
        text = text.split(`{${placeholder}}`).join(value);
      // Section names are fixed labels: the reading-age lint runs on one sample section only.
      return [`${key} (${d})`, phrase, text, d === "nutrition_and_hydration"] as const;
    }),
  );

  it.each(filled)("%s is plain, short and free of clinical words", (_key, phrase, text, lint) => {
    if (lint) expect(feedReadabilityLint(text)).toEqual([]);
    expect(findClinicalTerms(text)).toEqual([]);
    expect(findConfirmationTerms(text)).toEqual([]);
    expect(text).not.toMatch(/[{}]/);
    expect(phrase.charAt(0)).toMatch(/[A-Z{]/);
    expect(phrase.endsWith(".")).toBe(true);
    expect(phrase).not.toContain("!");
    for (const placeholder of phrase.match(/\{[a-z]{1,20}\}/g) ?? []) {
      expect(FEED_PHRASE_PLACEHOLDERS).toContain(placeholder.slice(1, -1));
    }
    for (const word of [
      "well",
      "happy",
      "settled",
      "fine",
      "good",
      "lovely",
      "great",
      "comfortable",
    ]) {
      expect(text.toLowerCase().split(/[^a-z]/)).not.toContain(word);
    }
  });
});

describe("shared notes go to the family only when staff marked them shareable", () => {
  it("refuses a note nobody marked as shareable", () => {
    expect(problems(note("Ada sang in the choir.", { markedShareableBy: null }))).toEqual([
      "note_not_marked_shareable",
    ]);
    expect(problems(note("Ada sang in the choir.", { markedShareableAt: null }))).toEqual([
      "note_not_marked_shareable",
    ]);
  });

  it("passes a plain shareable note through with no phrase key", () => {
    const { item } = composed(note("  Ada sang in the choir.  "));
    expect(item).toMatchObject({
      kind: "shared_note",
      section: "daily_updates",
      text: "Ada sang in the choir.",
      phraseKey: null,
    });
  });

  it("attaches the reading-age lint as advice, and still composes", () => {
    const long =
      "Ada spent the whole afternoon in the garden with her friends and the activities team planting spring bulbs.";
    const result = composed(note(long));
    expect(result.lint.map((f) => f.kind)).toEqual(["long_sentence"]);
  });

  it.each<[string, string, readonly string[]]>([
    ["a NEWS2 score", "Her NEWS2 score was 3 today.", ["NEWS2", "score"]],
    ["a MUST result", "Her MUST is now high.", ["MUST"]],
    ["a Waterlow score", "Waterlow 15 this week.", ["Waterlow"]],
    ["a diagnosis", "The GP diagnosed a chest infection.", ["diagnosed", "infection"]],
    ["a prognosis", "Ada is nearing the end of life.", ["end of life"]],
    ["a measurement", "Her blood pressure was normal.", ["blood pressure"]],
    ["medicines", "She took her antibiotics well.", ["antibiotics"]],
  ])("hazard HZ-022 refuses %s (medical-device boundary)", (_label, text, found) => {
    const result = composeFeedItem(note(text), context());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const problem = result.problems.find((p) => p.problem === "clinical_term");
      expect(problem && "terms" in problem ? problem.terms.map((t) => t.found) : []).toEqual(found);
    }
  });

  it.each<[string, string, string]>([
    ["first name only", "Sam Tester sang with Ada.", "Sam sang with Ada."],
    ["a possessive", "Ada played Jo Bloggs's guitar.", "Ada played Jo's guitar."],
    ["two staff", "Sam Tester and Jo Bloggs took Ada out.", "Sam and Jo took Ada out."],
    ["no staff named", "Ada sang.", "Ada sang."],
  ])(
    "hazard HZ-022 keeps staff surnames out when the tenant asks: %s",
    (_label, text, expected) => {
      expect(composed(note(text)).item.text).toBe(expected);
    },
  );

  it("keeps staff full names when the tenant uses them", () => {
    expect(
      composed(note("Sam Tester sang with Ada."), context({ staffNames: "full_name" })).item.text,
    ).toBe("Sam Tester sang with Ada.");
  });

  it("hazard HZ-022 refuses a staff surname used on its own", () => {
    expect(problems(note("Mrs Bloggs did Ada's hair."))).toEqual(["names_staff_surname"]);
  });

  it.each<[string, string, readonly string[]]>([
    ["a full name", "Ada sat with Dev Sample at lunch.", ["Dev Sample"]],
    ["a first name", "Ada sat with Dev at lunch.", ["Dev"]],
    ["a surname", "Ada sat with Mr Sample at lunch.", ["Sample"]],
    ["a possessive", "Ada admired Rose's painting.", ["Rose's"]],
  ])("hazard HZ-022 refuses another resident's name: %s", (_label, text, found) => {
    const result = composeFeedItem(note(text), context());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const problem = result.problems.find((p) => p.problem === "names_another_resident");
      expect(problem && "found" in problem ? problem.found : []).toEqual(found);
    }
  });

  it("hazard HZ-022 lists every resident named, in the order they appear", () => {
    const result = composeFeedItem(note("Ada sat with Rose Fixture and Dev Sample."), context());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const problem = result.problems.find((p) => p.problem === "names_another_resident");
      expect(problem && "found" in problem ? problem.found : []).toEqual([
        "Rose Fixture",
        "Dev Sample",
      ]);
    }
  });

  it("does not mistake a flower for a resident, or the person's own first name for another's", () => {
    const shared = context({
      otherResidents: [
        { givenName: "Ada", familyName: "Other" },
        { givenName: "Rose", familyName: "Fixture" },
      ],
    });
    expect(composeFeedItem(note("Ada picked a rose."), shared).ok).toBe(true);
    expect(problems(note("Ada sat with Ada Other."), shared)).toEqual(["names_another_resident"]);
  });

  it.each<[string, string, string]>([
    ["an email address", "Email ben@example.invalid about the trip.", "contact_details"],
    ["an NHS number", "Her number is 999 123 4567.", "long_number"],
    ["a phone number", "Ring 07700 900123 for the hairdresser.", "long_number"],
  ])("hazard HZ-022 refuses %s", (_label, text, problem) => {
    expect(problems(note(text))).toEqual([problem]);
  });

  it("refuses an empty or very long note", () => {
    expect(problems(note("   "))).toEqual(["text_required"]);
    expect(problems(note("a ".repeat(FEED_TEXT_MAX_LENGTH)))).toEqual(["text_too_long"]);
  });

  it("checks activity names the same way", () => {
    expect(problems(activity({ activityName: "physio for her fracture" }))).toEqual([
      "clinical_term",
    ]);
    expect(problems(activity({ activityName: "tea with Dev Sample" }))).toEqual([
      "names_another_resident",
    ]);
  });
});

describe("photos in the feed", () => {
  it("uses the default phrase when there is no caption", () => {
    const { item } = composed(photo());
    expect(item).toMatchObject({
      kind: "photo",
      section: "photos",
      text: "A new photo of Ada.",
      photoDocumentId: "doc-photo",
    });
  });

  it("uses a caption once it passes the checks", () => {
    const { item } = composed(photo({ caption: "Ada with her sunflowers." }));
    expect(item).toMatchObject({ text: "Ada with her sunflowers.", phraseKey: null });
  });

  it.each<
    [
      string,
      Partial<Extract<FeedSource, { kind: "photo" }>>,
      Partial<FeedComposeContext>,
      readonly string[],
    ]
  >([
    [
      "with no lawful basis",
      {},
      {
        photoBasis: {
          ok: false,
          problem: "consent_needed",
          message: "Ask the person.",
        } satisfies FeedPhotoBasis,
      },
      ["photo_basis_missing"],
    ],
    ["with no basis checked", {}, { photoBasis: null }, ["photo_basis_missing"]],
    ["showing other people", { otherPeopleIdentifiable: true }, {}, ["photo_shows_other_people"]],
    ["nobody chose for the feed", { markedForFeedBy: null }, {}, ["photo_not_marked_for_feed"]],
    [
      "with a clinical caption",
      { caption: "Ada's pressure sore is healing." },
      {},
      ["clinical_term"],
    ],
    [
      "with every problem at once",
      { otherPeopleIdentifiable: true, markedForFeedBy: null, caption: "Ada and Dev Sample." },
      { photoBasis: null },
      [
        "photo_not_marked_for_feed",
        "photo_basis_missing",
        "photo_shows_other_people",
        "names_another_resident",
      ],
    ],
  ])("hazard HZ-022 refuses a photo %s", (_label, overrides, ctx, expected) => {
    expect(problems(photo(overrides), context(ctx))).toEqual(expected);
  });

  it("passes the basis's own message to staff", () => {
    const result = composeFeedItem(
      photo(),
      context({
        photoBasis: {
          ok: false,
          problem: "best_interests_needed",
          message: "Record a best-interests decision.",
        },
      }),
    );
    expect(result).toEqual({
      ok: false,
      problems: [{ problem: "photo_basis_missing", message: "Record a best-interests decision." }],
    });
  });
});

describe("hazard HZ-022 nothing is composed for the wrong person or a closed record", () => {
  it("refuses a record about someone else", () => {
    expect(problems(activity({ personId: "person-dev" }))).toEqual(["wrong_person"]);
  });

  it.each<PersonStatus>([
    "discharged",
    "deceased",
    "archived",
    "not_admitted",
    "enquiry",
    "pre_admission",
  ])("refuses new updates for a person who is %s", (status) => {
    const ctx = context({ person: { ...context().person, status } });
    expect(problems(activity(), ctx)).toEqual(["person_record_closed"]);
  });

  it("hazard HZ-061 holds every update while the person is in hospital", () => {
    const ctx = context({ person: { ...context().person, status: "in_hospital" } });
    expect(problems(activity(), ctx)).toEqual(["publishing_held"]);
  });

  it.each<PersonStatus>(["active", "on_leave"])("composes for a person who is %s", (status) => {
    const ctx = context({ person: { ...context().person, status } });
    expect(composeFeedItem(activity(), ctx).ok).toBe(true);
  });

  it("refuses a record dated in the future", () => {
    expect(problems(activity({ occurredAt: new Date("2026-10-11T11:00:00Z") }))).toEqual([
      "in_future",
    ]);
  });
});

describe("staff surnames and text checks on their own", () => {
  it("strips every staff full name and leaves other words alone", () => {
    expect(
      stripStaffSurnames("Sam Tester, Jo Bloggs and Sam Testerson", [
        { givenName: "Sam", familyName: "Tester" },
        { givenName: "Jo", familyName: "Bloggs" },
      ]),
    ).toBe("Sam, Jo and Sam Testerson");
  });

  it("returns the checked text with problems and lint together", () => {
    const check = checkFeedText("Sam Tester read the paper with Ada.", context());
    expect(check).toEqual({
      text: "Sam read the paper with Ada.",
      problems: [],
      lint: [],
      confirmed: false,
    });
  });
});

describe("taking an update down", () => {
  const published = { composedAt: new Date("2026-10-10T10:00:00Z"), withdrawnAt: null };

  it("accepts a reasoned withdrawal by a member of staff", () => {
    expect(
      checkFeedWithdrawal(published, { reason: "source_corrected", by: "user-sam", at: NOW }, NOW),
    ).toEqual([]);
  });

  it.each<
    [
      string,
      Parameters<typeof checkFeedWithdrawal>[0],
      Parameters<typeof checkFeedWithdrawal>[1],
      readonly string[],
    ]
  >([
    [
      "twice",
      { ...published, withdrawnAt: AT },
      { reason: "published_in_error", by: "user-sam", at: NOW },
      ["already_withdrawn"],
    ],
    [
      "for an unknown reason",
      published,
      { reason: "tidying", by: "user-sam", at: NOW },
      ["unknown_reason"],
    ],
    ["by nobody", published, { reason: "person_asked", by: null, at: NOW }, ["who_required"]],
    [
      "before it was written",
      published,
      { reason: "person_asked", by: "user-sam", at: new Date("2026-10-09T10:00:00Z") },
      ["before_composed"],
    ],
    [
      "in the future",
      published,
      { reason: "person_asked", by: "user-sam", at: new Date("2026-10-12T10:00:00Z") },
      ["in_future"],
    ],
  ])("refuses a withdrawal %s", (_label, item, withdrawal, expected) => {
    expect(checkFeedWithdrawal(item, withdrawal, NOW)).toEqual(expected);
  });

  it("takes down photo updates still showing when the photo basis ends", () => {
    const items = [
      { id: "p1", kind: "photo" as const, withdrawnAt: null },
      { id: "p2", kind: "photo" as const, withdrawnAt: AT },
      { id: "a1", kind: "activity" as const, withdrawnAt: null },
    ];
    expect(
      photoItemsToWithdraw(items, { ok: false, problem: "consent_refused", message: "Refused." }),
    ).toEqual(["p1"]);
    expect(
      photoItemsToWithdraw(items, { ok: true, basis: "consent", consentRecordId: "c" }),
    ).toEqual([]);
  });
});

describe("hazard HZ-061 care plan sections announced in the feed", () => {
  it.each(PCSP_DOMAINS)("announces the %s section only if the allow-list says so", (domain) => {
    const result = composeFeedItem(
      { kind: "care_plan_update", id: "s", personId: ADA, occurredAt: AT, domain },
      context(),
    );
    if (FEED_CARE_PLAN_DOMAINS[domain] === "may_appear") expect(result.ok).toBe(true);
    else
      expect(result).toMatchObject({
        ok: false,
        problems: [{ problem: "care_plan_domain_not_for_feed" }],
      });
  });

  it("never announces end of life or medicines", () => {
    for (const domain of ["end_of_life", "medicines"]) {
      expect(
        problems({ kind: "care_plan_update", id: "s", personId: ADA, occurredAt: AT, domain }),
      ).toEqual(["care_plan_domain_not_for_feed"]);
    }
  });
});
