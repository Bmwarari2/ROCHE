import { describe, expect, it } from "vitest";
import { cite } from "../shared/citation";
import {
  auditFrameworkVersion,
  checkEvidenceTag,
  checkFrameworkVersion,
  checkMappingChange,
  type EvidenceTag,
  evidenceCoverage,
  FRAMEWORK_WORKFLOW,
  type FrameworkMapping,
  type FrameworkVersion,
  FrameworkVersionNotFoundError,
  frameworkInForce,
  mappingAt,
} from "./quality-framework";

/** An invented two-question framework: the real content is seeded by slice 14 (ADR-0096). */
const version = (over: Partial<FrameworkVersion> = {}): FrameworkVersion => ({
  id: "fw-1",
  frameworkKey: "example_framework",
  regulator: "cqc",
  version: 1,
  state: "published",
  publishedOn: "2024-01-01",
  retiredOn: null,
  source: cite("Example regulator", "framework", "https://example.invalid/framework"),
  keyQuestions: [
    {
      id: "safe",
      title: "Safe",
      statements: [
        { id: "safe.1", title: "First safe statement" },
        { id: "safe.2", title: "Second safe statement" },
      ],
    },
    {
      id: "caring",
      title: "Caring",
      statements: [{ id: "caring.1", title: "A caring statement" }],
    },
  ],
  evidenceCategories: [
    { id: "peoples_experience", title: "People's experience" },
    { id: "processes", title: "Processes" },
  ],
  ...over,
});

const MANAGE = ["quality.evidence.manage"];

describe("the compliance framework (quality.md 17.3 rules 1 to 5; QUAL-001)", () => {
  it.each<[string, Partial<FrameworkVersion>, string[]]>([
    ["a sound version", {}, []],
    ["no key questions", { keyQuestions: [] }, ["no_key_questions"]],
    [
      "a key question with no statements",
      { keyQuestions: [{ id: "safe", title: "Safe", statements: [] }] },
      ["key_question_without_statements"],
    ],
    ["no evidence categories", { evidenceCategories: [] }, ["no_evidence_categories"]],
    [
      "a duplicate statement id",
      {
        keyQuestions: [
          {
            id: "safe",
            title: "Safe",
            statements: [
              { id: "x", title: "A" },
              { id: "x", title: "B" },
            ],
          },
        ],
      },
      ["duplicate_id"],
    ],
    [
      "an id outside the evidence pack's pattern",
      { keyQuestions: [{ id: "safe", title: "Safe", statements: [{ id: "a b", title: "A" }] }] },
      ["invalid_id"],
    ],
    [
      "a blank title",
      { evidenceCategories: [{ id: "processes", title: "  " }] },
      ["missing_title"],
    ],
  ])("rule 1 checks %s", (_, over, problems) => {
    expect(checkFrameworkVersion(version(over))).toEqual(problems);
  });

  it("rule 1 takes however many statements the framework has: it never checks for a count", () => {
    const many = version({
      keyQuestions: [
        {
          id: "safe",
          title: "Safe",
          statements: Array.from({ length: 40 }, (_, i) => ({ id: `s.${i}`, title: `S ${i}` })),
        },
      ],
    });
    expect(checkFrameworkVersion(many)).toEqual([]);
  });

  it("rule 2 moves draft to published to retired, and retired is final", () => {
    expect(FRAMEWORK_WORKFLOW.initial).toBe("draft");
    expect(FRAMEWORK_WORKFLOW.terminal).toEqual(["retired"]);
    expect(FRAMEWORK_WORKFLOW.transitions.map((t) => `${t.from}>${t.to}`)).toEqual([
      "draft>published",
      "published>retired",
    ]);
  });

  const v1 = version();
  const v2 = version({ id: "fw-2", version: 2, publishedOn: "2027-01-01" });
  const draft = version({ id: "fw-3", version: 3, state: "draft", publishedOn: null });
  const wales = version({ id: "ciw-1", regulator: "ciw" });

  it.each<[string, string, string | null]>([
    ["before anything was published", "2023-12-31", null],
    ["while version 1 is the latest", "2026-10-31", "fw-1"],
    ["once version 2 takes effect", "2027-01-01", "fw-2"],
  ])("rule 3 finds the version in force %s", (_, on, id) => {
    expect(frameworkInForce([v1, v2, draft, wales], "cqc", on)?.id ?? null).toBe(id);
  });

  it("rule 3 never offers a retired version, or another regulator's", () => {
    const retired = version({ state: "retired", retiredOn: "2026-06-01" });
    expect(frameworkInForce([retired], "cqc", "2026-10-31")).toBeNull();
    expect(frameworkInForce([wales], "cqc", "2026-10-31")).toBeNull();
    expect(frameworkInForce([retired], "cqc", "2026-05-31")?.id).toBe("fw-1");
  });

  it("rule 4 reads a past audit against the version it was scored against, even retired", () => {
    const retired = version({ state: "retired", retiredOn: "2026-06-01" });
    expect(auditFrameworkVersion({ frameworkVersionId: "fw-1" }, [retired, v2]).id).toBe("fw-1");
    expect(() => auditFrameworkVersion({ frameworkVersionId: "gone" }, [v2])).toThrow(
      FrameworkVersionNotFoundError,
    );
  });

  const mapping = (n: number, madeAt: string): FrameworkMapping => ({
    frameworkVersionId: "fw-1",
    version: n,
    entries: [
      {
        statementId: "safe.1",
        localTitle: null,
        ownerRole: "quality_lead",
        evidenceCategoryIds: ["processes"],
      },
    ],
    madeBy: "user-a",
    madeAt,
  });

  it.each<[string, Omit<FrameworkMapping, "madeAt">, readonly string[], string[]]>([
    ["the next version by the quality lead", mapping(2, ""), MANAGE, []],
    ["a stale version", mapping(1, ""), MANAGE, ["version_not_next"]],
    ["someone without the permission", mapping(2, ""), [], ["missing_permission"]],
    [
      "an unknown statement",
      {
        ...mapping(2, ""),
        entries: [{ statementId: "x", localTitle: null, ownerRole: null, evidenceCategoryIds: [] }],
      },
      MANAGE,
      ["unknown_statement"],
    ],
    [
      "an unknown evidence category",
      {
        ...mapping(2, ""),
        entries: [
          {
            statementId: "safe.1",
            localTitle: null,
            ownerRole: null,
            evidenceCategoryIds: ["nope"],
          },
        ],
      },
      MANAGE,
      ["unknown_evidence_category"],
    ],
    [
      "a statement mapped twice",
      { ...mapping(2, ""), entries: [...mapping(2, "").entries, ...mapping(2, "").entries] },
      MANAGE,
      ["duplicate_statement"],
    ],
    [
      "another framework version's mapping",
      { ...mapping(1, ""), frameworkVersionId: "fw-2" },
      MANAGE,
      ["unknown_statement"],
    ],
  ])("rule 5 checks a mapping change: %s", (_, next, permissions, problems) => {
    expect(checkMappingChange([mapping(1, "2026-01-01T09:00:00Z")], next, v1, permissions)).toEqual(
      problems,
    );
  });

  it("rule 5 reads a past moment with the mapping in force then", () => {
    const all = [mapping(1, "2026-01-01T09:00:00Z"), mapping(2, "2026-06-01T09:00:00Z")];
    expect(mappingAt(all, "fw-1", "2026-03-01T00:00:00Z")?.version).toBe(1);
    expect(mappingAt(all, "fw-1", "2026-10-31T00:00:00Z")?.version).toBe(2);
    expect(mappingAt(all, "fw-1", "2025-12-31T00:00:00Z")).toBeNull();
  });
});

describe("the evidence library (quality.md 17.3 rules 6 and 7; QUAL-002)", () => {
  const v1 = version();
  const tag = (over: Partial<EvidenceTag> = {}): EvidenceTag => ({
    recordType: "audit",
    recordId: "rec-1",
    frameworkVersionId: "fw-1",
    statementIds: ["safe.1"],
    restricted: false,
    ...over,
  });

  it.each<[string, Partial<EvidenceTag>, FrameworkVersion, readonly string[], string[]]>([
    ["an audit tagged by the quality lead", {}, v1, MANAGE, []],
    ["a care note (an evidence pack record type)", { recordType: "care_note" }, v1, MANAGE, []],
    ["a compliment", { recordType: "compliment" }, v1, MANAGE, []],
    ["no statements", { statementIds: [] }, v1, MANAGE, ["no_statements"]],
    ["an unknown statement", { statementIds: ["safe.9"] }, v1, MANAGE, ["unknown_statement"]],
    [
      "a retired framework",
      {},
      version({ state: "retired", retiredOn: "2026-01-01" }),
      MANAGE,
      ["framework_not_published"],
    ],
    [
      "another version than the one named",
      { frameworkVersionId: "fw-2" },
      v1,
      MANAGE,
      ["framework_not_published"],
    ],
    ["an unknown record type", { recordType: "payslip" }, v1, MANAGE, ["unknown_record_type"]],
    ["a restricted silo record", { restricted: true }, v1, MANAGE, ["restricted_record"]],
    ["someone without the permission", {}, v1, [], ["missing_permission"]],
  ])("rule 6 checks a tag: %s", (_, over, framework, permissions, problems) => {
    expect(checkEvidenceTag(tag(over), framework, permissions)).toEqual(problems);
  });

  it("rule 7 counts each record once per statement and lists the gaps", () => {
    const coverage = evidenceCoverage(
      [
        tag(),
        tag(),
        tag({ recordId: "rec-2", statementIds: ["safe.1", "caring.1"] }),
        tag({ frameworkVersionId: "fw-2", statementIds: ["safe.2"] }),
      ],
      v1,
    );
    expect(coverage.statements).toEqual([
      { statementId: "safe.1", keyQuestionId: "safe", records: 2 },
      { statementId: "safe.2", keyQuestionId: "safe", records: 0 },
      { statementId: "caring.1", keyQuestionId: "caring", records: 1 },
    ]);
    expect(coverage.gaps).toEqual(["safe.2"]);
  });
});
