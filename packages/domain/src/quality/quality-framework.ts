/**
 * The compliance framework model and the evidence library (quality.md section 17, rules 1 to 7;
 * QUAL-001, QUAL-002; master prompt 11.2). A framework is data: key questions, quality statements and
 * evidence categories are rows of a versioned framework, so CQC's 34 quality statements now and a
 * KLOE-based version later are both just versions, and CIW, Care Inspectorate and RQIA frameworks
 * load the same way. Historical audits keep the version they were scored against. Pure functions.
 */

import { defineWorkflow } from "../platform/workflow";
import type { Citation } from "../shared/citation";
import { EVIDENCE_RECORD_TYPES } from "./evidence-pack";

export const REGULATORS = ["cqc", "ciw", "care_inspectorate", "rqia"] as const;
export type Regulator = (typeof REGULATORS)[number];

export type FrameworkState = "draft" | "published" | "retired";

/** The opaque id pattern the evidence pack already accepts for statement ids. */
const FRAMEWORK_ID = /^[A-Za-z0-9._-]{1,64}$/;

export interface FrameworkStatement {
  readonly id: string;
  readonly title: string;
}

export interface FrameworkKeyQuestion {
  readonly id: string;
  readonly title: string;
  readonly statements: readonly FrameworkStatement[];
}

export interface EvidenceCategory {
  readonly id: string;
  readonly title: string;
}

export interface FrameworkVersion {
  readonly id: string;
  /** For example "cqc_single_assessment"; a KLOE-based model is another key or version. */
  readonly frameworkKey: string;
  readonly regulator: Regulator;
  readonly version: number;
  readonly state: FrameworkState;
  /** UK date it took effect; null while a draft. */
  readonly publishedOn: string | null;
  /** UK date it stopped being used for new work; null while in use. */
  readonly retiredOn: string | null;
  readonly source: Citation;
  readonly keyQuestions: readonly FrameworkKeyQuestion[];
  readonly evidenceCategories: readonly EvidenceCategory[];
}

export type FrameworkProblem =
  | "no_key_questions"
  | "key_question_without_statements"
  | "no_evidence_categories"
  | "duplicate_id"
  | "invalid_id"
  | "missing_title";

export const FRAMEWORK_MESSAGES: Readonly<Record<FrameworkProblem, string>> = {
  no_key_questions: "Add at least one key question.",
  key_question_without_statements: "Give every key question at least one statement.",
  no_evidence_categories: "Add at least one evidence category.",
  duplicate_id: "Each key question, statement and evidence category needs its own id.",
  invalid_id: "Ids may use letters, numbers, dots, underscores and hyphens, up to 64 characters.",
  missing_title: "Give every key question, statement and evidence category a title.",
};

/** Rule 1: what is wrong with a framework version's content, in order; empty when it is sound. */
export function checkFrameworkVersion(
  version: Pick<FrameworkVersion, "keyQuestions" | "evidenceCategories">,
): FrameworkProblem[] {
  const problems = new Set<FrameworkProblem>();
  if (version.keyQuestions.length === 0) problems.add("no_key_questions");
  if (version.evidenceCategories.length === 0) problems.add("no_evidence_categories");
  const seen = new Set<string>();
  const check = (item: { readonly id: string; readonly title: string }) => {
    if (!FRAMEWORK_ID.test(item.id)) problems.add("invalid_id");
    if (seen.has(item.id)) problems.add("duplicate_id");
    seen.add(item.id);
    if (item.title.trim().length === 0) problems.add("missing_title");
  };
  for (const question of version.keyQuestions) {
    check(question);
    if (question.statements.length === 0) problems.add("key_question_without_statements");
    for (const statement of question.statements) check(statement);
  }
  for (const category of version.evidenceCategories) check(category);
  const order: FrameworkProblem[] = [
    "no_key_questions",
    "key_question_without_statements",
    "no_evidence_categories",
    "duplicate_id",
    "invalid_id",
    "missing_title",
  ];
  return order.filter((p) => problems.has(p));
}

/**
 * Rule 2: draft to published to retired; published content never changes (a change is a new
 * version). Changing the framework is the quality lead's (`quality.evidence.manage`).
 */
export const FRAMEWORK_WORKFLOW = defineWorkflow<FrameworkState>({
  key: "quality.framework_version",
  version: 1,
  states: ["draft", "published", "retired"],
  initial: "draft",
  terminal: ["retired"],
  transitions: [
    { from: "draft", to: "published", permission: "quality.evidence.manage" },
    { from: "published", to: "retired", permission: "quality.evidence.manage" },
  ],
});

/** Every statement id in a version. */
export function statementIds(version: Pick<FrameworkVersion, "keyQuestions">): Set<string> {
  return new Set(version.keyQuestions.flatMap((q) => q.statements.map((s) => s.id)));
}

const inForceOn = (v: FrameworkVersion, on: string) =>
  v.publishedOn !== null && v.publishedOn <= on && (v.retiredOn === null || v.retiredOn > on);

/**
 * Rule 3: the version in force for a regulator on a UK date: published on or before it and not
 * retired by then; the latest when two qualify; null when none (never a guess).
 */
export function frameworkInForce(
  versions: readonly FrameworkVersion[],
  regulator: Regulator,
  on: string,
): FrameworkVersion | null {
  const candidates = versions.filter(
    (v) => v.regulator === regulator && v.state !== "draft" && inForceOn(v, on),
  );
  candidates.sort(
    (a, b) => (b.publishedOn ?? "").localeCompare(a.publishedOn ?? "") || b.version - a.version,
  );
  return candidates[0] ?? null;
}

export class FrameworkVersionNotFoundError extends Error {
  constructor(id: string) {
    super(`Framework version ${id} is not loaded`);
    this.name = "FrameworkVersionNotFoundError";
  }
}

/**
 * Rule 4: the framework version an audit was scored against, even when it has since been retired.
 * Fails loudly when the version is missing rather than reading the audit against another one.
 */
export function auditFrameworkVersion(
  audit: { readonly frameworkVersionId: string },
  versions: readonly FrameworkVersion[],
): FrameworkVersion {
  const found = versions.find((v) => v.id === audit.frameworkVersionId);
  if (!found) throw new FrameworkVersionNotFoundError(audit.frameworkVersionId);
  return found;
}

// ------------------------------------------------------------------------------------------------
// Tenant mappings (rule 5)
// ------------------------------------------------------------------------------------------------

export interface FrameworkMappingEntry {
  readonly statementId: string;
  /** The tenant's own words for the statement, shown beside CQC's. */
  readonly localTitle: string | null;
  /** The role that owns the evidence for it. */
  readonly ownerRole: string | null;
  /** Evidence categories the tenant expects for it. */
  readonly evidenceCategoryIds: readonly string[];
}

export interface FrameworkMapping {
  readonly frameworkVersionId: string;
  readonly version: number;
  readonly entries: readonly FrameworkMappingEntry[];
  readonly madeBy: string;
  /** ISO instant. */
  readonly madeAt: string;
}

export type MappingProblem =
  | "missing_permission"
  | "version_not_next"
  | "unknown_statement"
  | "unknown_evidence_category"
  | "duplicate_statement";

export const MAPPING_MESSAGES: Readonly<Record<MappingProblem, string>> = {
  missing_permission: "Only the quality lead can change the framework mapping.",
  version_not_next: "Someone else changed the mapping. Reload it and try again.",
  unknown_statement: "A statement in the mapping is not in this framework version.",
  unknown_evidence_category:
    "An evidence category in the mapping is not in this framework version.",
  duplicate_statement: "Map each statement once.",
};

/** Rule 5: a new mapping version for a framework version, or why it is refused. */
export function checkMappingChange(
  previous: readonly FrameworkMapping[],
  next: Omit<FrameworkMapping, "madeAt">,
  framework: FrameworkVersion,
  permissions: readonly string[],
): MappingProblem[] {
  const problems: MappingProblem[] = [];
  if (!permissions.includes("quality.evidence.manage")) problems.push("missing_permission");
  const last = previous
    .filter((m) => m.frameworkVersionId === next.frameworkVersionId)
    .reduce((max, m) => Math.max(max, m.version), 0);
  if (next.version !== last + 1) problems.push("version_not_next");
  const statements = statementIds(framework);
  const categories = new Set(framework.evidenceCategories.map((c) => c.id));
  const seen = new Set<string>();
  let unknownStatement = false;
  let unknownCategory = false;
  let duplicate = false;
  for (const entry of next.entries) {
    if (!statements.has(entry.statementId)) unknownStatement = true;
    if (seen.has(entry.statementId)) duplicate = true;
    seen.add(entry.statementId);
    if (entry.evidenceCategoryIds.some((c) => !categories.has(c))) unknownCategory = true;
  }
  if (next.frameworkVersionId !== framework.id) unknownStatement = true;
  if (unknownStatement) problems.push("unknown_statement");
  if (unknownCategory) problems.push("unknown_evidence_category");
  if (duplicate) problems.push("duplicate_statement");
  return problems;
}

/** Rule 5: the mapping in force at a moment (the latest made at or before it), or null. */
export function mappingAt(
  mappings: readonly FrameworkMapping[],
  frameworkVersionId: string,
  at: string,
): FrameworkMapping | null {
  const atTime = Date.parse(at);
  const before = mappings.filter(
    (m) => m.frameworkVersionId === frameworkVersionId && Date.parse(m.madeAt) <= atTime,
  );
  before.sort((a, b) => b.version - a.version);
  return before[0] ?? null;
}

// ------------------------------------------------------------------------------------------------
// Evidence library (rules 6 and 7)
// ------------------------------------------------------------------------------------------------

/** Record types Phase 2 adds to the evidence library beside the evidence pack's. */
export const PHASE_2_EVIDENCE_RECORD_TYPES = ["audit", "compliment", "policy", "survey"] as const;

export const EVIDENCE_LIBRARY_RECORD_TYPES: readonly string[] = [
  ...EVIDENCE_RECORD_TYPES,
  ...PHASE_2_EVIDENCE_RECORD_TYPES,
];

export interface EvidenceTag {
  readonly recordType: string;
  readonly recordId: string;
  readonly frameworkVersionId: string;
  readonly statementIds: readonly string[];
  /** Speak-up, employee relations casework or legal advice: never evidence. */
  readonly restricted: boolean;
}

export type EvidenceTagProblem =
  | "missing_permission"
  | "no_statements"
  | "unknown_statement"
  | "framework_not_published"
  | "unknown_record_type"
  | "restricted_record";

export const EVIDENCE_TAG_MESSAGES: Readonly<Record<EvidenceTagProblem, string>> = {
  missing_permission: "Only someone who manages the evidence library can tag evidence.",
  no_statements: "Choose at least one quality statement.",
  unknown_statement: "A statement is not in this framework version.",
  framework_not_published: "Tag evidence against the framework in use, not a draft or retired one.",
  unknown_record_type: "This kind of record cannot be tagged as evidence yet.",
  restricted_record:
    "Speak-up concerns, employee relations casework and legal advice are never evidence.",
};

/** Rule 6: why a tag is refused, in order; empty when it may be saved. */
export function checkEvidenceTag(
  tag: EvidenceTag,
  framework: FrameworkVersion,
  permissions: readonly string[],
): EvidenceTagProblem[] {
  const problems: EvidenceTagProblem[] = [];
  if (!permissions.includes("quality.evidence.manage")) problems.push("missing_permission");
  if (tag.restricted) problems.push("restricted_record");
  if (!EVIDENCE_LIBRARY_RECORD_TYPES.includes(tag.recordType)) problems.push("unknown_record_type");
  if (framework.id !== tag.frameworkVersionId || framework.state !== "published") {
    problems.push("framework_not_published");
  }
  if (tag.statementIds.length === 0) problems.push("no_statements");
  const known = statementIds(framework);
  if (tag.statementIds.some((s) => !known.has(s))) problems.push("unknown_statement");
  return problems;
}

export interface StatementCoverage {
  readonly statementId: string;
  readonly keyQuestionId: string;
  readonly records: number;
}

/**
 * Rule 7: how many records evidence each statement of a version (each record once per statement),
 * and the statements with none, listed so a gap is shown rather than hidden.
 */
export function evidenceCoverage(
  tags: readonly Pick<
    EvidenceTag,
    "recordType" | "recordId" | "frameworkVersionId" | "statementIds"
  >[],
  framework: FrameworkVersion,
): { readonly statements: StatementCoverage[]; readonly gaps: string[] } {
  const records = new Map<string, Set<string>>();
  for (const tag of tags) {
    if (tag.frameworkVersionId !== framework.id) continue;
    for (const statement of tag.statementIds) {
      const set = records.get(statement) ?? new Set<string>();
      set.add(`${tag.recordType}:${tag.recordId}`);
      records.set(statement, set);
    }
  }
  const statements = framework.keyQuestions.flatMap((q) =>
    q.statements.map((s) => ({
      statementId: s.id,
      keyQuestionId: q.id,
      records: records.get(s.id)?.size ?? 0,
    })),
  );
  return { statements, gaps: statements.filter((s) => s.records === 0).map((s) => s.statementId) };
}
