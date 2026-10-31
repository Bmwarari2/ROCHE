import type { ResuscitationStatus } from "@harbour/contracts";
import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  can,
  chartsNotice,
  entryAuthor,
  entryChains,
  iddsiLabel,
  longerWindow,
  mayEditCarePlan,
  RECORD_TABS,
  readingWindow,
  recordCareAccess,
  resuscitationSummary,
  tabHref,
  visibleTabs,
  windowStart,
  writeAccess,
} from "./care-record";
import { profileOf, readCareProfile, readPersonSummary, readResuscitation } from "./record-data";

describe("reading windows", () => {
  it("reads 3, 7, 14 or 30 days from the address and nothing else", () => {
    expect(readingWindow(undefined)).toBe(3);
    expect(readingWindow("14")).toBe(14);
    expect(readingWindow(["30", "7"])).toBe(30);
    expect(readingWindow("92")).toBe(3);
    expect(readingWindow("abc")).toBe(3);
    expect(longerWindow(3)).toBe(7);
    expect(longerWindow(30)).toBeNull();
    expect(windowStart(7, new Date("2026-10-11T12:00:00Z"))).toBe("2026-10-04T12:00:00.000Z");
  });
});

const t = createTranslator("en-GB");
const PERSON = "0194d000-0000-7000-8600-000000000001";

describe("record tabs", () => {
  it("lists the eighteen sections in order, the overview first and history last", () => {
    expect(RECORD_TABS.map((d) => d.tab)).toEqual([
      "overview",
      "care-plan",
      "assessments",
      "risk-assessments",
      "notes",
      "charts",
      "body-map",
      "advance-care",
      "capacity",
      "activities",
      "reviews",
      "hospital",
      "pre-admission",
      "admission",
      "property",
      "letters",
      "family-updates",
      "history",
    ]);
  });

  it("gives each tab its own address and names it from the catalogue", () => {
    expect(tabHref(PERSON, "overview")).toBe(`/people/${PERSON}`);
    expect(tabHref(PERSON, "body-map")).toBe(`/people/${PERSON}/body-map`);
    for (const { tab } of RECORD_TABS) expect(t(`care.tabs.${tab}`)).not.toBe("");
  });

  it("shows only the tabs a person may read", () => {
    const notesOnly = visibleTabs(PERSON, ["people.person.read", "care.note.read"]).map(
      (v) => v.tab,
    );
    expect(notesOnly).toEqual([
      "overview",
      "notes",
      "charts",
      "body-map",
      "activities",
      "pre-admission",
      "admission",
      "property",
      "history",
    ]);
    expect(visibleTabs(PERSON, []).length).toBe(0);
    // Letters only for those who make them (comms.letter.manage), never from reading the record.
    expect(
      visibleTabs(PERSON, ["people.person.read", "comms.letter.manage"]).map((v) => v.tab),
    ).toEqual(["overview", "pre-admission", "admission", "property", "letters", "history"]);
    // Family updates only for those who publish them (comms.feed.publish).
    expect(
      visibleTabs(PERSON, ["people.person.read", "comms.feed.publish"]).map((v) => v.tab),
    ).toEqual(["overview", "pre-admission", "admission", "property", "family-updates", "history"]);
    // The hospital tab only for those who send people to hospital (people.movement.record).
    expect(
      visibleTabs(PERSON, ["people.person.read", "people.movement.record"]).map((v) => v.tab),
    ).toEqual(["overview", "hospital", "pre-admission", "admission", "property", "history"]);
  });

  it("checks permissions by name", () => {
    expect(can(["care.note.write"], "care.note.write")).toBe(true);
    expect(can(["care.note.read"], "care.note.write")).toBe(false);
  });
});

describe("entryChains (care.md rule 4: corrections supersede, both stay readable)", () => {
  const entry = (id: string, supersedesId: string | null = null, superseded = false) => ({
    id,
    occurredAt: "2026-10-11T09:00:00Z",
    supersedesId,
    superseded,
  });

  it("keeps a lone entry as its own chain", () => {
    const chains = entryChains([entry("a")]);
    expect(chains).toHaveLength(1);
    expect(chains[0]?.current.id).toBe("a");
    expect(chains[0]?.earlier).toEqual([]);
  });

  it("puts the latest correction in force with every earlier version, oldest first", () => {
    // Newest first, as the API returns them.
    const chains = entryChains([
      entry("c", "b"),
      entry("x"),
      entry("b", "a", true),
      entry("a", null, true),
    ]);
    expect(chains.map((c) => c.current.id)).toEqual(["c", "x"]);
    expect(chains[0]?.earlier.map((e) => e.id)).toEqual(["a", "b"]);
    expect(chains[0]?.correctsHidden).toBe(false);
  });

  it("says when a correction replaces an entry from before the dates shown", () => {
    const [chain] = entryChains([entry("b", "outside-window")]);
    expect(chain?.earlier).toEqual([]);
    expect(chain?.correctsHidden).toBe(true);
  });

  it("places every entry exactly once, even with a loop in the data", () => {
    const items = [entry("a", "b", true), entry("b", "a", true), entry("c")];
    const chains = entryChains(items);
    const placed = chains.flatMap((c) => [c.current.id, ...c.earlier.map((e) => e.id)]);
    expect(placed.sort()).toEqual(["a", "b", "c"]);
  });

  it("says who wrote an entry without a staff name (API gap)", () => {
    expect(entryAuthor("u1", "u1")).toBe("you");
    expect(entryAuthor("u2", "u1")).toBe("colleague");
    expect(entryAuthor(null, "u1")).toBe("unknown");
    expect(t("care.entry.recordedBy", { who: "colleague" })).toBe("Recorded by a colleague");
  });
});

describe("resuscitationSummary (hazard HZ-015)", () => {
  const base: ResuscitationStatus = {
    status: "not_recorded",
    conflicting: false,
    recordId: null,
    kind: null,
    completedOn: null,
    clinicianName: null,
    clinicianRole: null,
    reviewDueOn: null,
    reviewOverdue: false,
  };

  it("hazard HZ-015 a missing decision reads as a warning, never blank or calm", () => {
    const summary = resuscitationSummary(base, t);
    expect(summary.label).toBe("CPR decision not recorded");
    expect(summary.tone).toBe("warning");
    expect(summary.icon).toBe("circle-help");
    expect(summary.detail).toMatch(/Check the paper record/);
  });

  it("hazard HZ-015 a DNACPR decision shows the word, icon, source and clinician", () => {
    const summary = resuscitationSummary(
      {
        ...base,
        status: "do_not_attempt_cpr",
        recordId: "r1",
        kind: "dnacpr",
        completedOn: "2026-09-30",
        clinicianName: "Dr Ivy Example",
        clinicianRole: "GP",
        reviewDueOn: "2027-03-30",
      },
      t,
    );
    expect(summary.label).toBe("Do not attempt CPR");
    expect(summary.icon).toBe("heart-off");
    expect(summary.detail).toBe("DNACPR decision completed 30/09/2026 by Dr Ivy Example (GP)");
    expect(summary.reviewText).toBe("Review due 30/03/2027");
  });

  it("hazard HZ-015 an overdue review keeps the decision and says it still stands", () => {
    const summary = resuscitationSummary(
      {
        ...base,
        status: "attempt_cpr",
        kind: "respect",
        completedOn: "2025-01-10",
        reviewDueOn: "2026-01-10",
        reviewOverdue: true,
      },
      t,
    );
    expect(summary.label).toBe("Attempt CPR");
    expect(summary.detail).toBe("ReSPECT plan completed 10/01/2025");
    expect(summary.reviewOverdue).toBe(true);
    expect(summary.reviewText).toMatch(
      /^Review overdue since 10\/01\/2026\. The decision still stands/,
    );
  });

  it("hazard HZ-015 records that disagree are the strongest warning", () => {
    const summary = resuscitationSummary(
      { ...base, status: "do_not_attempt_cpr", conflicting: true, kind: "respect" },
      t,
    );
    expect(summary.tone).toBe("danger");
    expect(summary.label).toBe("CPR records disagree");
    expect(summary.detail).toMatch(/Check the signed documents/);
  });

  it("hazard HZ-015 a status that could not be read, or is unknown, is a warning, never 'Attempt CPR'", () => {
    for (const summary of [
      resuscitationSummary(null, t),
      resuscitationSummary(
        { ...base, status: "full_escalation" as ResuscitationStatus["status"], kind: "respect" },
        t,
      ),
    ]) {
      expect(summary.tone).toBe("danger");
      expect(summary.icon).toBe("triangle-alert");
      expect(summary.label).toBe("CPR decision could not be read");
      expect(summary.detail).toMatch(/Check the paper record/);
    }
  });
});

describe("reading the header data with the API's schemas (hazards HZ-001 and HZ-015)", () => {
  const person = {
    id: "0194d000-0000-7000-8600-000000000001",
    locationId: "0194d000-0000-7000-8000-000000000101",
    status: "active",
    givenName: "Ada",
    familyName: "Example",
    preferredName: "Addie",
    dateOfBirth: "1938-04-02",
    nhsNumber: "9990000018",
    roomLabel: "12",
    photoUrl: null,
    allergyStatus: "has_allergies",
    allergies: [{ substance: "Penicillin", severity: "severe", reaction: null }],
    communicationNeeds: [],
    communicationNeedsStatus: "not_recorded",
    communicationNeedsConfirmedBy: null,
    communicationNeedsConfirmedAt: null,
    iddsiFoodLevel: "not_recorded",
    iddsiDrinkLevel: "not_recorded",
    statusChangedAt: "2026-09-01T10:00:00.000Z",
    sample: false,
    resuscitation: {
      status: "do_not_attempt_cpr",
      conflicting: false,
      recordId: "0194d000-0000-7000-8000-000000000999",
      kind: "dnacpr",
      completedOn: "2026-09-30",
      clinicianName: "Dr Ivy Example",
      clinicianRole: "GP",
      reviewDueOn: null,
      reviewOverdue: false,
    },
    version: 3,
  };

  it("reads a person the API returned", () => {
    const read = readPersonSummary(person);
    expect(read?.givenName).toBe("Ada");
    expect(read?.resuscitation?.status).toBe("do_not_attempt_cpr");
  });

  it("hazard HZ-015 keeps the person but marks a resuscitation status it cannot read", () => {
    const read = readPersonSummary({
      ...person,
      resuscitation: { ...person.resuscitation, status: "full_escalation" },
    });
    expect(read?.givenName).toBe("Ada");
    expect(read?.resuscitation).toBeNull();
    expect(readResuscitation(undefined)).toBeNull();
  });

  it("hazard HZ-001 refuses a person whose identity or allergies cannot be read", () => {
    expect(readPersonSummary({ ...person, allergies: "none" })).toBeNull();
    expect(readPersonSummary({ ...person, givenName: undefined })).toBeNull();
    expect(readPersonSummary(null)).toBeNull();
  });

  it("hazard HZ-016 marks a care profile it cannot read", () => {
    expect(readCareProfile({ iddsiFoodLevel: "11" }).kind).toBe("unreadable");
    expect(profileOf({ kind: "no_access" })).toBeNull();
  });
});

describe("iddsiLabel (hazard HZ-016)", () => {
  it.each([
    ["food", "5", "Level 5 Minced and moist (orange)"],
    ["food", "7EC", "Level 7EC Easy to chew (black)"],
    ["drink", "0", "Level 0 Thin (white)"],
    ["drink", "2", "Level 2 Mildly thick (pink)"],
    ["food", null, "No level prescribed"],
  ] as const)("hazard HZ-016 %s level %s shows number, name and colour", (kind, level, label) => {
    expect(iddsiLabel(kind, level, t)).toBe(label);
  });
});

describe("hazard HZ-011 hazard HZ-073 every write form is offered only where the API says it reaches (ADR-0071 review rounds 2 and 3, C2-M2 and C3-M1)", () => {
  const t = createTranslator("en-GB");
  const reachingAll = [
    "care.assessment.write",
    "care.note.write",
    "care.plan.write",
    "care.respect.record",
    "people.person.read",
  ];
  const own = {
    reaching: reachingAll,
    recordCare: true,
    editCarePlan: true,
    readOnlyReason: null,
  } as const;
  const breakGlass = {
    reaching: [],
    recordCare: false,
    editCarePlan: false,
    readOnlyReason: "break_glass",
  } as const;
  const readingOnly = {
    reaching: ["people.person.read"],
    recordCare: false,
    editCarePlan: false,
    readOnlyReason: "scope",
  } as const;
  // One write permission per tab of the record: notes, charts, body map, activities and visits;
  // assessments (NEWS2 is a chart, MUST and the others are run here); the care plan, risks and
  // chart settings; ReSPECT and advance care records.
  const writes = [
    "care.note.write",
    "care.assessment.write",
    "care.plan.write",
    "care.respect.record",
  ] as const;

  it.each(writes)("offers %s where it reaches the person", (permission) => {
    expect(writeAccess({ access: own }, [permission], permission)).toEqual({
      canWrite: true,
      readOnlyNotice: null,
    });
  });

  it.each(writes)("offers no %s on a record opened by break-glass, and says why", (permission) => {
    expect(writeAccess({ access: breakGlass }, [permission], permission)).toEqual({
      canWrite: false,
      readOnlyNotice: "care.readOnly.breakGlass",
    });
  });

  it.each(writes)("offers no %s where the roles reach for reading only", (permission) => {
    expect(writeAccess({ access: readingOnly }, [permission], permission)).toEqual({
      canWrite: false,
      readOnlyNotice: "care.readOnly.scope",
    });
  });

  it.each(writes)("shows neither form nor line to someone who never holds %s", (permission) => {
    expect(writeAccess({ access: own }, ["care.plan.read"], permission)).toEqual({
      canWrite: false,
      readOnlyNotice: null,
    });
  });

  it("offers one write and not another where only one reaches", () => {
    const notesOnly = {
      reaching: ["care.note.write", "people.person.read"],
      recordCare: true,
      editCarePlan: false,
      readOnlyReason: null,
    } as const;
    const held = ["care.note.write", "care.plan.write"];
    expect(writeAccess({ access: notesOnly }, held, "care.note.write").canWrite).toBe(true);
    expect(writeAccess({ access: notesOnly }, held, "care.plan.write")).toEqual({
      canWrite: false,
      readOnlyNotice: "care.readOnly.scope",
    });
  });

  it("leaves the form when the API does not say (the API still refuses what it would not take)", () => {
    expect(writeAccess({ access: undefined }, ["care.plan.write"], "care.plan.write")).toEqual({
      canWrite: true,
      readOnlyNotice: null,
    });
  });

  it("answers recording and chart settings from the same rule", () => {
    expect(recordCareAccess({ access: breakGlass }, ["care.note.write"])).toEqual({
      canRecord: false,
      readOnlyNotice: "care.readOnly.breakGlass",
    });
    expect(recordCareAccess({ access: own }, ["care.note.write"])).toEqual({
      canRecord: true,
      readOnlyNotice: null,
    });
    expect(mayEditCarePlan({ access: own }, ["care.plan.write"])).toBe(true);
    expect(mayEditCarePlan({ access: breakGlass }, ["care.plan.write"])).toBe(false);
    expect(mayEditCarePlan({ access: own }, ["care.plan.read"])).toBe(false);
  });

  it("never says the record cannot be recorded in above chart settings the viewer can change (review round 5)", () => {
    const planOnly = {
      reaching: ["care.plan.write", "people.person.read"],
      recordCare: false,
      editCarePlan: true,
      readOnlyReason: "scope",
    } as const;
    const held = ["care.note.write", "care.plan.write"];
    // The settings form stays: the line is about entries only.
    expect(mayEditCarePlan({ access: planOnly }, held)).toBe(true);
    expect(chartsNotice({ access: planOnly }, held)).toBe("care.readOnly.chartEntries");
    expect(t("care.readOnly.chartEntries")).toContain("cannot record entries");
    expect(t("care.readOnly.chartEntries")).not.toContain("cannot record in it");
    // Neither reaches: the line says the record is for reading (the settings are hidden too).
    expect(chartsNotice({ access: readingOnly }, held)).toBe("care.readOnly.scope");
    // Settings only held, and not reaching: why they are hidden (review round 4).
    expect(chartsNotice({ access: readingOnly }, ["care.plan.write"])).toBe("care.readOnly.scope");
    // Settings only held, and reaching: no line above a form they can use.
    expect(chartsNotice({ access: planOnly }, ["care.plan.write"])).toBeNull();
    expect(chartsNotice({ access: breakGlass }, held)).toBe("care.readOnly.breakGlass");
    expect(chartsNotice({ access: own }, held)).toBeNull();
  });

  it("says in words that a break-glass record is for reading only, in English and Welsh", () => {
    expect(t("care.readOnly.breakGlass")).toContain("for reading only");
    expect(t("care.readOnly.breakGlass")).toContain("the person in charge of this shift");
    expect(t("care.readOnly.scope")).toContain("cannot record in it");
    expect(createTranslator("cy")("care.readOnly.breakGlass")).not.toBe("");
    expect(t("people.breakGlass.body")).toContain("The record opens for reading only");
  });

  it("reads the access the API sends with a person", () => {
    const person = readPersonSummary({
      id: "0194d000-0000-7000-8600-000000000150",
      locationId: "0194d000-0000-7000-8000-000000000150",
      status: "active",
      givenName: "Una",
      familyName: "Example",
      preferredName: null,
      dateOfBirth: null,
      nhsNumber: "9990001502",
      roomLabel: null,
      photoUrl: null,
      allergyStatus: "unknown",
      allergies: [],
      communicationNeeds: [],
      communicationNeedsStatus: "not_recorded",
      communicationNeedsConfirmedBy: null,
      communicationNeedsConfirmedAt: null,
      iddsiFoodLevel: "not_recorded",
      iddsiDrinkLevel: "not_recorded",
      statusChangedAt: "2026-09-01T10:00:00.000Z",
      sample: false,
      resuscitation: { status: "not_recorded" },
      version: 1,
      access: breakGlass,
    });
    expect(person?.access).toEqual(breakGlass);
  });
});
