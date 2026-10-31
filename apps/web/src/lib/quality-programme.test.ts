import type { AuditQuestion, FrameworkVersionDetail } from "@harbour/contracts";
import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  actionField,
  answerField,
  auditStateChip,
  auditsShown,
  coverageChip,
  coverageRows,
  evidenceManaged,
  frameworkShown,
  isTaggable,
  mappingField,
  needsAction,
  readAnswers,
  readCompletion,
  readMapping,
  readTag,
  recordHref,
  scheduleChip,
  scoreText,
  selfRatingChoices,
  statementRows,
  versionChip,
} from "./quality-programme";

const t = createTranslator("en-GB");

const form = (entries: Record<string, string | string[]>) => ({
  get: (name: string) => {
    const value = entries[name];
    return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
  },
  getAll: (name: string) => {
    const value = entries[name];
    return value === undefined ? [] : Array.isArray(value) ? value : [value];
  },
});

const detail: FrameworkVersionDetail = {
  id: "0192f1a0-0000-7000-8000-000000000001",
  frameworkKey: "cqc_single_assessment",
  regulator: "cqc",
  versionNumber: 1,
  state: "published",
  publishedOn: "2023-11-20",
  retiredOn: null,
  source: { name: "CQC", provision: "Quality statements", url: "https://www.cqc.org.uk/" },
  inForce: true,
  keyQuestions: [
    {
      id: "safe",
      title: "Safe",
      statements: [
        { id: "safe.learning_culture", title: "Learning culture" },
        { id: "safe.safeguarding", title: "Safeguarding" },
      ],
    },
    { id: "caring", title: "Caring", statements: [{ id: "caring.kindness", title: "Kindness" }] },
  ],
  evidenceCategories: [
    { id: "observation", title: "Observation" },
    { id: "processes", title: "Processes" },
  ],
};

const question = (key: string, actionRequired = true): AuditQuestion => ({
  key,
  text: `Question ${key}`,
  weight: 1,
  statementIds: [],
  actionRequired,
});

describe("who sees the screens", () => {
  it.each([
    ["an evidence manager", ["quality.evidence.manage"], true, true, false],
    ["an audit runner", ["quality.audit.manage"], true, false, true],
    ["a pack composer", ["quality.evidence_pack.compose"], true, false, false],
    ["a care worker", ["care.note.write"], false, false, false],
  ])("%s", (_label, permissions, framework, evidence, audits) => {
    expect(frameworkShown(permissions)).toBe(framework);
    expect(evidenceManaged(permissions)).toBe(evidence);
    expect(auditsShown(permissions)).toBe(audits);
  });
});

describe("the framework and the mapping", () => {
  it("says a version's state in words with an icon", () => {
    expect(versionChip(detail, t)).toMatchObject({ status: "done", label: "In force" });
    expect(versionChip({ ...detail, inForce: false, state: "retired" }, t)).toMatchObject({
      status: "neutral",
      label: "Retired",
    });
  });

  it("lists the statements in the framework's order with their key question", () => {
    expect(statementRows(detail).map((s) => [s.id, s.keyQuestionTitle])).toEqual([
      ["safe.learning_culture", "Safe"],
      ["safe.safeguarding", "Safe"],
      ["caring.kindness", "Caring"],
    ]);
  });

  it("reads the mapping, leaving empty statements out and unknown categories dropped", () => {
    const read = readMapping(
      form({
        [mappingField.title("safe.safeguarding")]: " Keeping people safe ",
        [mappingField.owner("safe.safeguarding")]: "Registered Manager",
        [mappingField.category("safe.safeguarding")]: ["observation", "made_up"],
        [mappingField.category("caring.kindness")]: ["processes"],
      }),
      detail,
      t,
    );
    expect(read).toEqual({
      ok: true,
      entries: [
        {
          statementId: "safe.safeguarding",
          localTitle: "Keeping people safe",
          ownerRole: "Registered Manager",
          evidenceCategoryIds: ["observation"],
        },
        {
          statementId: "caring.kindness",
          localTitle: null,
          ownerRole: null,
          evidenceCategoryIds: ["processes"],
        },
      ],
    });
  });

  it("says a title or owner that is too long at its field", () => {
    const read = readMapping(
      form({
        [mappingField.title("safe.safeguarding")]: "x".repeat(201),
        [mappingField.owner("caring.kindness")]: "y".repeat(65),
      }),
      detail,
      t,
    );
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(Object.keys(read.errors)).toEqual([
      mappingField.title("safe.safeguarding"),
      mappingField.owner("caring.kindness"),
    ]);
  });

  it("keeps coverage in the framework's order and says a gap in words", () => {
    const rows = coverageRows(
      { statements: [{ statementId: "caring.kindness", keyQuestionId: "caring", records: 2 }] },
      detail,
    );
    expect(rows.map((r) => [r.id, r.records])).toEqual([
      ["safe.learning_culture", 0],
      ["safe.safeguarding", 0],
      ["caring.kindness", 2],
    ]);
    expect(coverageChip(0, t)).toMatchObject({ label: "No evidence", icon: "circle-alert" });
    expect(coverageChip(2, t).label).toBe("2 records");
  });
});

describe("evidence tagging", () => {
  it("reads the ticked statements of the version only", () => {
    expect(readTag(form({ statement: ["safe.safeguarding", "safe.made_up"] }), detail, t)).toEqual({
      ok: true,
      statementIds: ["safe.safeguarding"],
    });
    const none = readTag(form({}), detail, t);
    expect(none.ok).toBe(false);
  });

  it("knows which records can be tagged and where they open", () => {
    expect(isTaggable("audit")).toBe(true);
    expect(isTaggable("payslip")).toBe(false);
    expect(recordHref("incident", "x")).toBe("/incidents/x");
    expect(recordHref("audit", "x")).toBe("/quality/audits/x");
    expect(recordHref("care_note", "x")).toBeNull();
  });
});

describe("the audit programme", () => {
  it("says an audit's state and a schedule's due date in words", () => {
    expect(auditStateChip("in_progress", t).label).toBe("In progress");
    expect(auditStateChip("completed", t).label).toBe("Completed");
    const date = (iso: string) => iso.split("-").reverse().join("/");
    expect(scheduleChip({ nextDueOn: "2026-11-30", overdue: false }, date, t)).toMatchObject({
      status: "due",
      label: "Due 30/11/2026",
    });
    expect(scheduleChip({ nextDueOn: "2026-10-01", overdue: true }, date, t)).toMatchObject({
      status: "overdue",
      label: "Overdue: was due 01/10/2026",
    });
  });

  it("reads answers for the audit's own questions, clearing anything else", () => {
    const answers = readAnswers(
      form({ [answerField("a")]: "yes", [answerField("b")]: "made_up", [answerField("x")]: "no" }),
      [question("a"), question("b")],
    );
    expect(answers).toEqual({ a: "yes", b: null });
  });

  it("asks for an action only where a required question fell short", () => {
    const questions = [question("a"), question("b"), question("c", false)];
    expect(needsAction(questions, { a: "no", b: "yes", c: "partial" }).map((q) => q.key)).toEqual([
      "a",
    ]);
  });

  it("offers the CQC words with their number for the self-rating", () => {
    expect(selfRatingChoices(t).map((c) => c.label)).toEqual([
      "Inadequate (1)",
      "Requires improvement (2)",
      "Good (3)",
      "Outstanding (4)",
    ]);
  });

  it("reads the completion with an action for each shortfall, the due date optional", () => {
    const read = readCompletion(
      form({
        selfRating: "3",
        [actionField.description("a")]: "Retrain on MAR charts",
        [actionField.owner("a")]: "owner-1",
      }),
      [question("a")],
      ["owner-1"],
      t,
    );
    expect(read).toEqual({
      ok: true,
      body: {
        selfRating: 3,
        actions: [{ questionKey: "a", description: "Retrain on MAR charts", ownerId: "owner-1" }],
      },
    });
  });

  it("says every completion problem at its field at once", () => {
    const read = readCompletion(
      form({
        [actionField.description("a")]: "x",
        [actionField.owner("a")]: "someone-else",
        [`${actionField.due("a")}-day`]: "31",
        [`${actionField.due("a")}-month`]: "2",
        [`${actionField.due("a")}-year`]: "2027",
      }),
      [question("a")],
      ["owner-1"],
      t,
    );
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(Object.keys(read.errors).sort()).toEqual(
      [
        "selfRating",
        actionField.description("a"),
        actionField.owner("a"),
        actionField.due("a"),
      ].sort(),
    );
  });

  it("says a score with one decimal, and no score in words", () => {
    expect(scoreText(83.3333, t)).toBe("Score: 83.3%");
    expect(scoreText(null, t)).toBe("No score: no question could be scored");
  });
});
