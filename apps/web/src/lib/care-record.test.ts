import type { ResuscitationStatus } from "@harbour/contracts";
import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  can,
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
  it("lists the ten sections in order, the overview first and history last", () => {
    expect(RECORD_TABS.map((d) => d.tab)).toEqual([
      "overview",
      "care-plan",
      "assessments",
      "risk-assessments",
      "notes",
      "charts",
      "body-map",
      "advance-care",
      "activities",
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
    expect(notesOnly).toEqual(["overview", "notes", "charts", "body-map", "activities", "history"]);
    expect(visibleTabs(PERSON, []).length).toBe(0);
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

describe("hazard HZ-011 hazard HZ-073 recording is offered only where the API says it reaches (ADR-0071 review round 2, C2-M2)", () => {
  const writer = ["care.note.read", "care.note.write"];
  const t = createTranslator("en-GB");

  it.each([
    [
      "the API says care.note.write reaches the person",
      writer,
      { recordCare: true, editCarePlan: true, readOnlyReason: null },
      true,
      null,
    ],
    [
      "the record was opened by break-glass",
      writer,
      { recordCare: false, editCarePlan: false, readOnlyReason: "break_glass" },
      false,
      "care.readOnly.breakGlass",
    ],
    [
      "the roles reach the person for reading only",
      writer,
      { recordCare: false, editCarePlan: false, readOnlyReason: "scope" },
      false,
      "care.readOnly.scope",
    ],
    [
      "the viewer never holds care.note.write",
      ["care.note.read"],
      { recordCare: false, editCarePlan: false, readOnlyReason: "scope" },
      false,
      null,
    ],
    ["an API that does not say", writer, undefined, true, null],
  ] as const)("%s", (_name, permissions, access, canRecord, notice) => {
    expect(recordCareAccess({ access }, permissions)).toEqual({
      canRecord,
      readOnlyNotice: notice,
    });
  });

  it.each([
    ["the API says care.plan.write reaches the person", ["care.plan.write"], true, true],
    ["the record was opened by break-glass", ["care.plan.write"], false, false],
    ["the viewer never holds care.plan.write", ["care.plan.read"], true, false],
    ["an API that does not say", ["care.plan.write"], undefined, true],
  ] as const)(
    "chart settings are offered only when %s",
    (_name, permissions, editCarePlan, offered) => {
      const access =
        editCarePlan === undefined
          ? undefined
          : { recordCare: false, editCarePlan, readOnlyReason: null };
      expect(mayEditCarePlan({ access }, permissions)).toBe(offered);
    },
  );

  it("says in words that a break-glass record is for reading only, in English and Welsh", () => {
    expect(t("care.readOnly.breakGlass")).toContain("for reading only");
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
      resuscitation: { status: "not_recorded" },
      version: 1,
      access: { recordCare: false, editCarePlan: false, readOnlyReason: "break_glass" },
    });
    expect(person?.access).toEqual({
      recordCare: false,
      editCarePlan: false,
      readOnlyReason: "break_glass",
    });
  });
});
