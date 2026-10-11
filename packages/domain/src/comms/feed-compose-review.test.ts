import { describe, expect, it } from "vitest";
import type { CandourState } from "../safety/candour";
import {
  type AccompanimentPurpose,
  composeFeedItem,
  FEED_CONFIRMATION_MIN_REASON_LENGTH,
  type FeedComposeContext,
  type FeedIncidentView,
  type FeedPublishConfirmation,
  type FeedSource,
  feedPublishingHolds,
  photoItemsToWithdraw,
  stripStaffSurnames,
} from "./feed-compose";

/**
 * Composition rules added after the clinical and security review (comms.md section 4 rules 7 to
 * 10; hazards HZ-022, HZ-060 and HZ-061). Invented people: Ada Example (the person), residents
 * Robert Sample (known as Bob, preferred name Robbie) and Rose Fixture, staff Samuel Tester (Sam).
 */

const NOW = new Date("2026-10-11T10:00:00Z");
const AT = new Date("2026-10-11T09:00:00Z");
const ADA = "person-ada";

function context(overrides: Partial<FeedComposeContext> = {}): FeedComposeContext {
  return {
    person: { id: ADA, status: "active", name: "Ada", givenName: "Ada", familyName: "Example" },
    otherResidents: [
      { givenName: "Robert", familyName: "Sample", preferredName: "Robbie", knownAs: ["Bob"] },
      { givenName: "Rose", familyName: "Fixture" },
    ],
    staff: [{ givenName: "Samuel", familyName: "Tester", knownAs: ["Sam"] }],
    staffNames: "first_name_only",
    photoBasis: { ok: true, basis: "consent", consentRecordId: "consent-1" },
    openIncidents: [],
    candourStates: [],
    confirmation: null,
    now: NOW,
    ...overrides,
  };
}

const note = (text: string): FeedSource => ({
  kind: "shared_note",
  id: "note-1",
  personId: ADA,
  occurredAt: AT,
  text,
  markedShareableBy: "user-sam",
  markedShareableAt: NOW,
});

const visit = (
  visitKind: "facilitated_visit" | "visit_out" | "accompaniment",
  endedAt: Date | null,
  accompanimentPurpose: AccompanimentPurpose | null,
): FeedSource => ({
  kind: "visit",
  id: "visit-1",
  personId: ADA,
  occurredAt: AT,
  visitKind,
  endedAt,
  accompanimentPurpose,
  restrictionsApplied: false,
});

const problems = (source: FeedSource, ctx = context()) => {
  const result = composeFeedItem(source, ctx);
  return result.ok ? [] : result.problems.map((p) => p.problem);
};

const manager: FeedPublishConfirmation = {
  by: "user-manager",
  permissions: new Set(["comms.feed.publish"]),
  reason: "Ben was told by phone at 10:15 and asked for this update.",
};

describe("hazards HZ-060 and HZ-061 staff words that announce an event or claim wellbeing", () => {
  it.each<[string, string, readonly string[]]>([
    ["hazard HZ-061 a fall", "Ada had a fall this morning.", ["needs_confirmation"]],
    ["hazard HZ-061 an A&E visit", "Ada went to A&E last night.", ["needs_confirmation"]],
    ["hazard HZ-061 a death", "Ada died peacefully this morning.", ["needs_confirmation"]],
    ["hazard HZ-061 a stroke", "Ada had a stroke.", ["needs_confirmation"]],
    ["hazard HZ-061 pressure sores", "Ada has pressure sores.", ["clinical_term"]],
    ["hazard HZ-061 settled and happy", "Ada is settled and happy.", ["needs_confirmation"]],
    ["hazard HZ-061 an ambulance", "We called an ambulance for Ada.", ["needs_confirmation"]],
    ["hazard HZ-061 the police", "The police came to see Ada.", ["needs_confirmation"]],
  ])("refuses %s without a manager's confirmation", (_label, text, expected) => {
    expect(problems(note(text))).toEqual(expected);
  });

  it("hazard HZ-061 publishes flagged words once a manager confirms, and records who and why", () => {
    const result = composeFeedItem(
      note("Ada is settled and happy."),
      context({ confirmation: manager }),
    );
    expect(result).toMatchObject({
      ok: true,
      item: {
        text: "Ada is settled and happy.",
        confirmation: { by: "user-manager", reason: manager.reason },
      },
    });
  });

  it("does not record a confirmation that was not needed", () => {
    const result = composeFeedItem(
      note("Ada sang in the choir."),
      context({ confirmation: manager }),
    );
    expect(result).toMatchObject({ ok: true, item: { confirmation: null } });
  });

  it.each<[string, FeedPublishConfirmation]>([
    ["without the publish permission", { ...manager, permissions: new Set(["care.note.write"]) }],
    [
      "with a reason that is too short",
      { ...manager, reason: "x".repeat(FEED_CONFIRMATION_MIN_REASON_LENGTH - 1) },
    ],
    ["by nobody", { ...manager, by: "  " }],
  ])("hazard HZ-061 refuses a confirmation %s", (_label, confirmation) => {
    expect(problems(note("Ada had a fall this morning."), context({ confirmation }))).toEqual([
      "needs_confirmation",
    ]);
  });

  it("hazard HZ-061 never lets a confirmation publish a clinical term", () => {
    expect(problems(note("Ada has pressure sores."), context({ confirmation: manager }))).toEqual([
      "clinical_term",
    ]);
  });

  it("checks photo captions and activity names the same way", () => {
    expect(
      problems({
        kind: "photo",
        id: "photo-1",
        personId: ADA,
        occurredAt: AT,
        documentId: "doc-photo",
        caption: "Ada back from hospital.",
        otherPeopleIdentifiable: false,
        markedForFeedBy: "user-sam",
      }),
    ).toEqual(["needs_confirmation"]);
  });
});

describe("hazard HZ-061 publishing holds", () => {
  const incident = (overrides: Partial<FeedIncidentView> = {}): FeedIncidentView => ({
    id: "incident-1",
    state: "open",
    nextOfKinContact: "pending",
    ...overrides,
  });

  it.each<[string, Partial<FeedComposeContext>, readonly string[]]>([
    ["in hospital", { person: { ...context().person, status: "in_hospital" } }, ["in_hospital"]],
    [
      "an incident waiting for the next of kin",
      { openIncidents: [incident()] },
      ["incident_awaiting_next_of_kin"],
    ],
    [
      "an incident under review waiting for the next of kin",
      { openIncidents: [incident({ state: "under_review" })] },
      ["incident_awaiting_next_of_kin"],
    ],
    ["a candour step to take", { candourStates: ["verbal_due"] }, ["candour_step_pending"]],
    [
      "a candour threshold still to assess",
      { candourStates: ["threshold_assessment"] },
      ["candour_step_pending"],
    ],
    [
      "all three at once",
      {
        person: { ...context().person, status: "in_hospital" },
        openIncidents: [incident()],
        candourStates: ["written_due"],
      },
      ["in_hospital", "incident_awaiting_next_of_kin", "candour_step_pending"],
    ],
    ["the next of kin told", { openIncidents: [incident({ nextOfKinContact: "done" })] }, []],
    ["no contact needed", { openIncidents: [incident({ nextOfKinContact: "not_required" })] }, []],
    ["a closed incident", { openIncidents: [incident({ state: "closed" })] }, []],
    [
      "finished candour records",
      { candourStates: ["closed", "not_notifiable", "no_contact"] as CandourState[] },
      [],
    ],
  ])("holds for %s", (_label, overrides, holds) => {
    const ctx = context(overrides);
    expect(
      feedPublishingHolds({
        personStatus: ctx.person.status,
        openIncidents: ctx.openIncidents,
        candourStates: ctx.candourStates,
      }),
    ).toEqual(holds);
    const result = composeFeedItem(note("Ada sang in the choir."), ctx);
    if (holds.length === 0) expect(result.ok).toBe(true);
    else {
      expect(result).toMatchObject({
        ok: false,
        problems: [{ problem: "publishing_held", holds }],
      });
    }
  });

  it("holds approved phrases too, and says why in words staff can act on", () => {
    const result = composeFeedItem(
      visit("facilitated_visit", AT, null),
      context({ candourStates: ["enquiries_open"] }),
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.problems[0]?.message).toContain("duty of candour step is open");
  });
});

describe("hazard HZ-061 visits and accompaniments", () => {
  it.each<[string, FeedSource, readonly string[]]>([
    ["a planned appointment", visit("accompaniment", AT, "planned_appointment"), []],
    [
      "an unplanned appointment",
      visit("accompaniment", AT, "unplanned_appointment"),
      ["not_for_the_feed"],
    ],
    ["an emergency", visit("accompaniment", AT, "emergency"), ["not_for_the_feed"]],
    [
      "an accompaniment with no purpose",
      visit("accompaniment", AT, null),
      ["accompaniment_purpose_required"],
    ],
    [
      "an accompaniment still under way",
      visit("accompaniment", null, "planned_appointment"),
      ["visit_in_progress"],
    ],
    ["a visit still under way", visit("facilitated_visit", null, null), ["visit_in_progress"]],
    ["a visit out still under way", visit("visit_out", null, null), ["visit_in_progress"]],
    ["a finished visit out", visit("visit_out", AT, null), []],
  ])("handles %s", (_label, source, expected) => {
    expect(problems(source)).toEqual(expected);
  });
});

describe("hazard HZ-022 other residents however their names are written", () => {
  it.each<[string, string, readonly string[]]>([
    ["lower case", "Ada sat with robert sample.", ["robert sample"]],
    ["capitals", "Ada sat with ROBERT SAMPLE.", ["ROBERT SAMPLE"]],
    ["a known-as name", "Ada sat with Bob at lunch.", ["Bob"]],
    ["a preferred name with the surname", "Ada sat with Robbie Sample.", ["Robbie Sample"]],
    ["a Cyrillic o", "Ada sat with Rоbert.", ["Rоbert"]],
    ["a zero-width space in the surname", "Ada sat with Mr Sam​ple.", ["Sample"]],
    ["a surname in lower case", "Ada sat with mr sample.", ["sample"]],
  ])("refuses %s", (_label, text, found) => {
    const result = composeFeedItem(note(text), context());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const problem = result.problems.find((p) => p.problem === "names_another_resident");
      expect(problem && "found" in problem ? problem.found : []).toEqual(found);
    }
  });

  it("publishes the text without hidden characters", () => {
    const result = composeFeedItem(note("Ada​ sang in the­ choir."), context());
    expect(result).toMatchObject({ ok: true, item: { text: "Ada sang in the choir." } });
  });

  it("strips staff surnames in any case and for names they go by", () => {
    const staff = context().staff;
    expect(stripStaffSurnames("sam tester and SAMUEL TESTER sang.", staff)).toBe(
      "Sam and Samuel sang.",
    );
    expect(problems(note("Mrs tester did Ada's hair."))).toEqual(["names_staff_surname"]);
  });

  it("refuses hyphenated and plural clinical words", () => {
    expect(problems(note("She is on anti-depressants."))).toEqual(["clinical_term"]);
    expect(problems(note("She keeps getting UTIs."))).toEqual(["clinical_term"]);
  });
});

describe("photo updates to take down", () => {
  it("includes another kind of update that carries a photo", () => {
    const items = [
      { id: "a1", kind: "activity" as const, photoDocumentId: "doc-photo", withdrawnAt: null },
      { id: "a2", kind: "activity" as const, photoDocumentId: null, withdrawnAt: null },
    ];
    expect(
      photoItemsToWithdraw(items, { ok: false, problem: "consent_refused", message: "No." }),
    ).toEqual(["a1"]);
  });
});
