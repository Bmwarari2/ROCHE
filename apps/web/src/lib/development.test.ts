import { COMPETENCES, TRAINING_TOPICS } from "@harbour/domain";
import { createTranslator } from "@harbour/i18n";
import enGB from "@harbour/i18n/messages/en-GB.json";
import { describe, expect, it } from "vitest";
import {
  codeLabel,
  codeOptions,
  competenceChip,
  developmentActions,
  developmentShown,
  listOf,
  matrixCounts,
  meetingChip,
  OBSERVE,
  present,
  REVALIDATION_REQUIREMENTS,
  requirementChip,
  STAFF_FILE_READ,
  SUPERVISION,
  SUPERVISION_KINDS,
  TRAINING,
  trainingChip,
  ukDate,
  visibleWindow,
  WINDOW_THRESHOLD,
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
        "confirmation",
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

describe("status as an icon and a word", () => {
  it.each([
    ["valid", "done", "circle-check", "Up to date"],
    ["due_soon", "due", "clock", "Due soon"],
    ["expired", "overdue", "circle-alert", "Lapsed"],
    ["missing", "overdue", "circle-minus", "Not done"],
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
    ["due", "due", "Due now"],
    ["upcoming", "info", "Not due yet"],
  ])("next meeting %s", (state, status, label) => {
    expect(meetingChip(state, t)).toMatchObject({ status, label });
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

  it("draws every row of a short list", () => {
    expect(visibleWindow(WINDOW_THRESHOLD, 5000, 700, 72)).toEqual({
      start: 0,
      end: WINDOW_THRESHOLD,
      before: 0,
      after: 0,
    });
  });

  it.each([
    // total, scrollTop, viewport, start, end
    [1000, 0, 720, 0, 26],
    [1000, 7200, 720, 92, 118],
    [1000, 72_000, 720, 992, 1000],
  ])("windows %i rows scrolled to %i", (total, scrollTop, viewport, start, end) => {
    const view = visibleWindow(total, scrollTop, viewport, 72);
    expect([view.start, view.end]).toEqual([start, end]);
    // The spacers and the drawn rows always add up to the whole list's height.
    expect(view.before + (view.end - view.start) * 72 + view.after).toBe(total * 72);
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
