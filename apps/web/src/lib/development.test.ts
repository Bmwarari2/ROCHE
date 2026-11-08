import { COMPETENCES, TRAINING_TOPICS } from "@harbour/domain";
import { createTranslator } from "@harbour/i18n";
import enGB from "@harbour/i18n/messages/en-GB.json";
import { describe, expect, it } from "vitest";
import {
  byMeetingUrgency,
  codeLabel,
  codeOptions,
  competenceChip,
  developmentActions,
  developmentArrivalKey,
  developmentShown,
  listOf,
  matchesName,
  matrixCounts,
  meetingChip,
  meetingCounts,
  notNeededChip,
  OBSERVE,
  present,
  REVALIDATION_REQUIREMENTS,
  requirementChip,
  revalidationConfirmActions,
  STAFF_FILE_READ,
  SUPERVISION,
  SUPERVISION_KINDS,
  TRAINING,
  trainingChip,
  ukDate,
} from "./development";

const t = createTranslator("en-GB");
const catalogue = enGB as Record<string, string>;

describe("every code the screens show has words", () => {
  it.each<[string, readonly string[]]>([
    ["development.topic", TRAINING_TOPICS],
    ["development.competence.kind", COMPETENCES],
    ["development.competence.reason", ["missing", "expired", "withdrawn"]],
    ["development.supervision.kind", SUPERVISION_KINDS],
    ["development.supervision.next", ["supervision", "appraisal"]],
    ["development.revalidation.requirement", REVALIDATION_REQUIREMENTS],
    [
      "development.revalidation.field",
      [
        "practiceHours",
        "cpdHours",
        "participatoryCpdHours",
        "feedbackPieces",
        "reflectiveAccounts",
        "reflectiveDiscussion",
        "healthAndCharacter",
        "professionalIndemnity",
      ],
    ],
    ["development.tier", ["1", "2"]],
    ["development.status", ["valid", "due_soon", "expired", "missing"]],
  ])("%s", (prefix, codes) => {
    expect(codes.filter((code) => !(`${prefix}.${code}` in catalogue))).toEqual([]);
  });
});

describe("who is offered what", () => {
  it.each([
    [[TRAINING], true],
    [[OBSERVE], true],
    [[SUPERVISION], true],
    [[STAFF_FILE_READ], true],
    [["workforce.self.read"], false],
    [[], false],
  ])("the matrix for %j: %s", (permissions, shown) => {
    expect(developmentShown(permissions)).toBe(shown);
  });

  it("offers each form only to its permission", () => {
    expect(developmentActions([TRAINING], false)).toEqual({
      recordTraining: true,
      signOff: false,
      withdraw: true,
      supervise: false,
      revalidation: true,
    });
    expect(developmentActions([OBSERVE], false)).toMatchObject({ signOff: true, withdraw: true });
    expect(developmentActions([SUPERVISION], false)).toMatchObject({
      supervise: true,
      recordTraining: false,
    });
    expect(developmentActions([STAFF_FILE_READ], false)).toEqual({
      recordTraining: false,
      signOff: false,
      withdraw: false,
      supervise: false,
      revalidation: false,
    });
  });

  it("offers nothing on one's own record, whatever one holds (HZ-119)", () => {
    expect(Object.values(developmentActions([TRAINING, OBSERVE, SUPERVISION], true))).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});

describe("the revalidation confirmation is offered only to the named confirmer (rule 8)", () => {
  const NURSE = "u-nurse";
  const HR = "u-hr";
  const MANAGER = "u-manager";
  const reviewed = {
    confirmerId: MANAGER,
    reviewedById: "u-other-hr",
    reviewState: "reviewed",
    confirmation: false,
  } as const;
  it.each([
    [
      "HR, not named",
      HR,
      [TRAINING, SUPERVISION],
      reviewed,
      { nameConfirmer: true, confirm: false },
    ],
    [
      "the named line manager",
      MANAGER,
      [SUPERVISION],
      reviewed,
      { nameConfirmer: false, confirm: true },
    ],
    [
      "HR, named by someone else",
      HR,
      [TRAINING],
      { ...reviewed, confirmerId: HR },
      { nameConfirmer: true, confirm: true },
    ],
    [
      "the nurse",
      NURSE,
      [TRAINING, SUPERVISION],
      reviewed,
      { nameConfirmer: false, confirm: false },
    ],
    [
      "the named confirmer before HR's review",
      MANAGER,
      [SUPERVISION],
      { ...reviewed, reviewState: "submitted" },
      { nameConfirmer: false, confirm: false },
    ],
    [
      "anyone once confirmed",
      MANAGER,
      [TRAINING, SUPERVISION],
      { ...reviewed, confirmation: true },
      { nameConfirmer: false, confirm: false },
    ],
    ["HR with no evidence yet", HR, [TRAINING], null, { nameConfirmer: false, confirm: false }],
    [
      "the named confirmer who also reviewed it (separate duties)",
      MANAGER,
      [TRAINING, SUPERVISION],
      { ...reviewed, reviewedById: MANAGER },
      { nameConfirmer: true, confirm: false },
    ],
    [
      "the named confirmer without a confirming permission",
      MANAGER,
      [OBSERVE],
      reviewed,
      { nameConfirmer: false, confirm: false },
    ],
  ] as const)("%s", (_name, me, permissions, plan, expected) => {
    expect(revalidationConfirmActions({ permissions, me, memberId: NURSE, plan })).toEqual(
      expected,
    );
  });
});

describe("what the training pages announce on arrival", () => {
  it.each([
    ["development.revalidation.confirmedSaved", true],
    ["development.competence.signedOff", true],
    // The Care Certificate's section is on the training record too.
    ["workforce.careCertificate.assessed", true],
    ["workforce.careCertificate.observed", true],
    ["workforce.careCertificate.nothing", false],
    ["workforce.leaving.recorded", false],
    ["Anything typed into the address", false],
  ])("%s: %s", (key, said) => {
    expect(developmentArrivalKey(key)).toBe(said);
  });
});

describe("status as an icon and a word", () => {
  it.each([
    ["valid", "done", "circle-check", "Up to date"],
    ["due_soon", "due", "clock", "Due soon"],
    ["expired", "overdue", "circle-alert", "Lapsed"],
    ["missing", "overdue", "triangle-alert", "Not done"],
  ])("training %s", (code, status, icon, label) => {
    expect(trainingChip(code, t)).toEqual({ status, icon, label });
  });

  it.each([
    [{ allowed: true, reason: null }, "done", "Signed off"],
    [{ allowed: false, reason: "missing" }, "overdue", "Not signed off"],
    [{ allowed: false, reason: "expired" }, "overdue", "Sign-off lapsed"],
    [{ allowed: false, reason: "withdrawn" }, "overdue", "Sign-off withdrawn"],
  ])("competence %j", (state, status, label) => {
    expect(competenceChip(state, t)).toMatchObject({ status, label });
  });

  it.each([
    ["overdue", "overdue", "Overdue"],
    ["due", "due", "Due soon"],
    ["none_recorded", "due", "None recorded"],
    ["upcoming", "info", "Not due yet"],
  ])("next meeting %s", (state, status, label) => {
    expect(meetingChip(state, t)).toMatchObject({ status, label });
  });

  it("never shows none recorded with the overdue icon", () => {
    expect(meetingChip("none_recorded", t).icon).not.toBe(meetingChip("overdue", t).icon);
  });

  it("revalidation requirements", () => {
    expect(requirementChip(true, t).label).toBe("Met");
    expect(requirementChip(false, t).label).toBe("To do");
  });
});

describe("the matrix", () => {
  it("counts cells by status", () => {
    expect(
      matrixCounts([
        { cells: [{ status: "missing" }, { status: "valid" }] },
        { cells: [{ status: "expired" }, { status: "due_soon" }, { status: "missing" }] },
      ]),
    ).toEqual({ missing: 2, expired: 1, due_soon: 1, valid: 1 });
  });

  it("finds a member by any part of their name, ignoring case and accents", () => {
    expect(matchesName("Zoë Example", "zoe")).toBe(true);
    expect(matchesName("Ada Example", "EXAM")).toBe(true);
    expect(matchesName("Ada Example", "ben")).toBe(false);
    expect(matchesName("Ada Example", undefined)).toBe(true);
    expect(matchesName("Ada Example", "  ")).toBe(true);
  });

  it("says a topic their roles do not need in words, with its own icon", () => {
    expect(notNeededChip(t)).toEqual({
      status: "notApplicable",
      icon: "circle-minus",
      label: "Not needed for their roles",
    });
    expect(trainingChip("missing", t).icon).not.toBe(notNeededChip(t).icon);
  });
});

describe("helpers", () => {
  it("codeLabel and codeOptions give each code its words", () => {
    expect(codeLabel("development.topic", "fire_safety", t)).toBe("Fire safety");
    expect(codeOptions(["appraisal"], "development.supervision.kind", t)).toEqual([
      { value: "appraisal", label: "Appraisal" },
    ]);
  });

  it.each([
    ["2027-03-09", "09/03/2027"],
    [null, ""],
    ["", ""],
  ])("ukDate(%s)", (iso, expected) => {
    expect(ukDate(iso)).toBe(expected);
  });

  it("lists in British English and drops missing names", () => {
    expect(listOf(["A", "B", "C"])).toBe("A, B and C");
    expect(present([{ id: "a" }, null, undefined])).toEqual([{ id: "a" }]);
  });
});

describe("WORK-009 supervisions and appraisals across staff", () => {
  const member = (name: string, ...states: string[]) => ({
    member: { displayName: name },
    meetings: states.map((state) => ({ state })),
  });

  it("counts each state", () => {
    expect(
      meetingCounts([member("A", "overdue", "upcoming"), member("B", "none_recorded", "due")]),
    ).toEqual({ overdue: 1, due: 1, none_recorded: 1, upcoming: 1 });
  });

  it("puts the most urgent first, then by name", () => {
    const sorted = byMeetingUrgency([
      member("Zoe", "upcoming", "upcoming"),
      member("Bea", "none_recorded", "upcoming"),
      member("Al", "upcoming", "overdue"),
      member("Cy", "due", "upcoming"),
      member("Ann", "upcoming", "upcoming"),
    ]);
    expect(sorted.map((m) => m.member.displayName)).toEqual(["Al", "Cy", "Bea", "Ann", "Zoe"]);
  });
});
