import { describe, expect, it } from "vitest";
import {
  checkCourseMapping,
  classifyLmsRow,
  classifyLmsRows,
  countLmsClasses,
  type LmsClassifyContext,
  type LmsStagedRow,
  lmsDate,
  lmsDryRunFingerprint,
  lmsRecordId,
  parseLmsCsv,
  parseLmsJson,
  stageLmsRow,
  trainingKey,
} from "./lms-import";

/**
 * Learning platform imports (workforce.md section 13; WORK-006, slice 78). Table-driven. The
 * learners and records are invented.
 */

const TODAY = "2026-11-01";
const IMPORTER = "importer";
const ADA = "member-ada";
const BEN = "member-ben";

const ctx = (over: Partial<LmsClassifyContext> = {}): LmsClassifyContext => ({
  links: new Map([
    ["L-100", ADA],
    ["L-200", BEN],
    ["L-900", IMPORTER],
  ]),
  courses: new Map([
    ["FIRE-01", { topic: "fire_safety", tier: null }],
    ["OMMT-2", { topic: "oliver_mcgowan", tier: 2 }],
  ]),
  importedRecordIds: new Set(["rec-old"]),
  existing: new Map([[BEN, new Set([trainingKey("fire_safety", null, "2026-03-01")])]]),
  importerId: IMPORTER,
  ...over,
});

const row = (over: Partial<Parameters<typeof stageLmsRow>[1]> = {}, n = 1): LmsStagedRow =>
  stageLmsRow(
    n,
    { learnerId: "L-100", courseCode: "FIRE-01", completedOn: "2026-10-01", ...over },
    TODAY,
  );

describe("WORK-006 rule 2 dates and ids", () => {
  it.each([
    ["2026-10-01", "2026-10-01"],
    ["01/10/2026", "2026-10-01"],
    ["31/02/2026", null],
    ["2026-02-31", null],
    ["10/01/26", null],
    ["", null],
  ])("reads %j as %j", (text, want) => {
    expect(lmsDate(text)).toBe(want);
  });

  it("keeps the platform's record id, or derives one from the completion", () => {
    expect(
      lmsRecordId({
        learnerId: "L-1",
        courseCode: "C",
        completedOn: "2026-01-01",
        recordId: "r-9",
      }),
    ).toBe("r-9");
    const derived = lmsRecordId({ learnerId: "L-1", courseCode: "C", completedOn: "2026-01-01" });
    expect(derived).toBe("derived:L-1/C/2026-01-01");
    expect(
      lmsRecordId({ learnerId: "L-1", courseCode: "C", completedOn: "2026-01-01", recordId: " " }),
    ).toBe(derived);
  });
});

describe("WORK-006 rule 2 checking a row", () => {
  it.each<[string, Partial<Parameters<typeof stageLmsRow>[1]>, string[]]>([
    ["a good row", {}, []],
    ["an email as the learner id", { learnerId: "ada@example.invalid" }, ["learner_id"]],
    ["a blank learner id", { learnerId: " " }, ["learner_id"]],
    ["a course code with a space", { courseCode: "FIRE 01" }, ["course_code"]],
    ["a completion in the future", { completedOn: "2026-11-02" }, ["completed_in_future"]],
    ["no completion date", { completedOn: "" }, ["completed_on"]],
    ["an expiry before completion", { expiresOn: "2026-09-01" }, ["expires_before_completion"]],
    ["an expiry that is not a date", { expiresOn: "soon" }, ["expires_on"]],
    ["a record id with a space", { recordId: "rec 1" }, ["record_id"]],
    ["a provider of one letter", { provider: "A" }, ["provider"]],
  ])("%s", (_name, over, problems) => {
    expect(row(over).problems).toEqual(problems);
  });

  it("keeps none of a value that broke a check", () => {
    const bad = row({ learnerId: "ada@example.invalid" });
    expect(bad.learnerId).toBe("");
    expect(JSON.stringify(bad)).not.toContain("example.invalid");
  });
});

describe("WORK-006 rule 2 reading files", () => {
  it("reads a CSV by heading and ignores every other column, names included", () => {
    const csv = [
      "First name,Surname,Email,Learner ID,Course code,Completion date,Expiry date,Score",
      "Ada,Example,ada@example.invalid,L-100,FIRE-01,01/10/2026,01/10/2027,95",
    ].join("\r\n");
    const out = parseLmsCsv(csv, TODAY);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.rows[0]).toMatchObject({
      learnerId: "L-100",
      courseCode: "FIRE-01",
      completedOn: "2026-10-01",
      expiresOn: "2027-10-01",
      problems: [],
    });
    expect(JSON.stringify(out.rows)).not.toMatch(/Ada|Example|example\.invalid|95/);
  });

  it.each([
    ["no learner id column", "Course code,Completion date\nFIRE-01,01/10/2026"],
    ["no rows", "Learner ID,Course code,Completion date\n"],
    ["a broken quote", 'Learner ID,Course code,Completion date\n"L-100,FIRE-01,01/10/2026'],
  ])("refuses a CSV with %s", (_name, csv) => {
    expect(parseLmsCsv(csv, TODAY).ok).toBe(false);
  });

  it("reads JSON completions and refuses anything that is not a list", () => {
    const out = parseLmsJson(
      JSON.stringify([
        { learnerId: "L-100", courseCode: "FIRE-01", completedOn: "2026-10-01", name: "Ada" },
        { learnerId: 5, courseCode: "FIRE-01", completedOn: "2026-10-01" },
      ]),
      TODAY,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.rows.map((r) => r.problems)).toEqual([[], ["learner_id"]]);
    expect(parseLmsJson("{}", TODAY).ok).toBe(false);
    expect(parseLmsJson("not json", TODAY).ok).toBe(false);
    expect(parseLmsJson("[]", TODAY).ok).toBe(false);
  });
});

describe("hazard HZ-124 WORK-006 rules 3 to 6 classifying rows", () => {
  it.each<[string, Partial<Parameters<typeof stageLmsRow>[1]>, string]>([
    ["linked, mapped and new", {}, "ready"],
    ["a learner not linked", { learnerId: "L-404" }, "unmatched_learner"],
    ["a course not mapped", { courseCode: "NEW-1" }, "unmapped_course"],
    ["the importer's own record", { learnerId: "L-900" }, "own_record"],
    ["a record id already imported", { recordId: "rec-old" }, "already_recorded"],
    [
      "a Harbour record of the same topic and date",
      { learnerId: "L-200", completedOn: "2026-03-01" },
      "already_recorded",
    ],
    ["an invalid row, whatever else", { learnerId: "L-404", completedOn: "x" }, "invalid"],
  ])("%s is %s", (_name, over, want) => {
    expect(classifyLmsRow(row(over), ctx()).class).toBe(want);
  });

  it("gives the member and the mapped topic and tier", () => {
    expect(classifyLmsRow(row({ courseCode: "OMMT-2" }), ctx())).toMatchObject({
      class: "ready",
      workerId: ADA,
      topic: "oliver_mcgowan",
      tier: 2,
    });
  });

  it("treats the same completion twice in one batch as one", () => {
    const rows = [row({}, 1), row({}, 2), row({ courseCode: "OMMT-2" }, 3)];
    const out = classifyLmsRows(rows, ctx());
    expect(out.map((c) => c.class)).toEqual(["ready", "already_recorded", "ready"]);
    expect(countLmsClasses(out)).toMatchObject({ ready: 2, already_recorded: 1, invalid: 0 });
  });

  it("fingerprints only the ready rows, in a fixed order", () => {
    const a = classifyLmsRows([row({}, 1), row({ courseCode: "OMMT-2" }, 2)], ctx());
    const b = [...a].reverse();
    expect(lmsDryRunFingerprint(a)).toBe(lmsDryRunFingerprint(b));
    const later = classifyLmsRows(
      [row({}, 1), row({ courseCode: "OMMT-2" }, 2)],
      ctx({
        courses: new Map([["FIRE-01", { topic: "fire_safety", tier: null }]]),
      }),
    );
    expect(lmsDryRunFingerprint(later)).not.toBe(lmsDryRunFingerprint(a));
  });
});

describe("WORK-006 course mappings", () => {
  it.each<[string, number | null, string | null]>([
    ["fire_safety", null, null],
    ["fire_safety", 1, "tier"],
    ["oliver_mcgowan", 2, null],
    ["oliver_mcgowan", null, "tier"],
    ["knitting", null, "unknown_topic"],
  ])("%s tier %j", (topic, tier, want) => {
    expect(checkCourseMapping(topic, tier)).toBe(want);
  });
});
