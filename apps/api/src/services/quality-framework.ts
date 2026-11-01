import type { FrameworkVersionDetail } from "@harbour/contracts";
import {
  type evidenceLink,
  frameworkEvidenceCategory,
  frameworkKeyQuestion,
  frameworkStatement,
  frameworkVersion,
  type Transaction,
} from "@harbour/db";
import {
  cite,
  type FrameworkVersion,
  frameworkInForce,
  REGULATORS,
  type Regulator,
  ukIsoDate,
} from "@harbour/domain";
import { asc, eq } from "drizzle-orm";

/**
 * Reading the compliance framework and evidence links (quality.md section 18; ADR-0096). The
 * framework tables are global reference data; this turns their rows into the domain's
 * `FrameworkVersion` and the API's detail, and lists the versions with the one in force today.
 */

/**
 * The tables an evidence link may point at, by record type: the evidence pack's record types and
 * audits (slice 19). Compliments, policies and surveys join here when their slices add their
 * tables (18, 25 and Phase 3); until then they are refused as not yet available.
 */
export const EVIDENCE_RECORD_TABLES: Readonly<Record<string, string>> = {
  incident: "incident",
  care_note: "care_note",
  observation: "observation",
  body_map_mark: "body_map_mark",
  assessment: "assessment",
  care_plan_section: "care_plan_section",
  risk_assessment: "risk_assessment",
  activity_record: "activity_record",
  visit_log: "visit_log",
  advance_care_record: "advance_care_record",
  audit: "audit_record",
};

type VersionRow = typeof frameworkVersion.$inferSelect;

const summary = (row: VersionRow, inForce: boolean) => ({
  id: row.id,
  frameworkKey: row.frameworkKey,
  regulator: row.regulator as Regulator,
  versionNumber: row.versionNumber,
  state: row.state as FrameworkVersion["state"],
  publishedOn: row.publishedOn,
  retiredOn: row.retiredOn,
  source: { name: row.sourceName, provision: row.sourceProvision, url: row.sourceUrl },
  inForce,
});

const shell = (row: VersionRow): FrameworkVersion => ({
  id: row.id,
  frameworkKey: row.frameworkKey,
  regulator: row.regulator as Regulator,
  version: row.versionNumber,
  state: row.state as FrameworkVersion["state"],
  publishedOn: row.publishedOn,
  retiredOn: row.retiredOn,
  source: cite(row.sourceName, row.sourceProvision, row.sourceUrl),
  keyQuestions: [],
  evidenceCategories: [],
});

/** The ids of the versions in force today, one per regulator at most (rule 3). */
function inForceIds(rows: readonly VersionRow[], now: Date): Set<string> {
  const versions = rows.map(shell);
  const today = ukIsoDate(now);
  return new Set(
    REGULATORS.map((r) => frameworkInForce(versions, r, today)?.id).filter(
      (id): id is string => id !== undefined,
    ),
  );
}

/** Every framework version, newest first, each marked when it is in force today. */
export async function frameworkSummaries(tx: Transaction, now: Date) {
  const rows = await tx
    .select()
    .from(frameworkVersion)
    .orderBy(asc(frameworkVersion.regulator), asc(frameworkVersion.versionNumber));
  const live = inForceIds(rows, now);
  return rows.map((row) => summary(row, live.has(row.id)));
}

export interface FrameworkContent {
  readonly domain: FrameworkVersion;
  readonly detail: FrameworkVersionDetail;
}

/** A version's full content as the domain and the API see it, or null when there is none. */
export async function frameworkContent(
  tx: Transaction,
  id: string,
  now = new Date(),
): Promise<FrameworkContent | null> {
  const all = await tx.select().from(frameworkVersion);
  const row = all.find((v) => v.id === id);
  if (!row) return null;
  const [questions, statements, categories] = await Promise.all([
    tx
      .select()
      .from(frameworkKeyQuestion)
      .where(eq(frameworkKeyQuestion.frameworkVersionId, id))
      .orderBy(asc(frameworkKeyQuestion.position)),
    tx
      .select()
      .from(frameworkStatement)
      .where(eq(frameworkStatement.frameworkVersionId, id))
      .orderBy(asc(frameworkStatement.position)),
    tx
      .select()
      .from(frameworkEvidenceCategory)
      .where(eq(frameworkEvidenceCategory.frameworkVersionId, id))
      .orderBy(asc(frameworkEvidenceCategory.position)),
  ]);
  const keyQuestions = questions.map((q) => ({
    id: q.id,
    title: q.title,
    statements: statements
      .filter((s) => s.keyQuestionId === q.id)
      .map((s) => ({ id: s.id, title: s.title })),
  }));
  const evidenceCategories = categories.map((k) => ({ id: k.id, title: k.title }));
  return {
    domain: { ...shell(row), keyQuestions, evidenceCategories },
    detail: {
      ...summary(row, inForceIds(all, now).has(row.id)),
      keyQuestions,
      evidenceCategories,
    },
  };
}

/**
 * The statement and key question ids of the framework in force today for a regulator, which the
 * evidence pack takes as its quality statement ids; null when no version is in force (a nation
 * pack not yet loaded), so the pack keeps taking opaque ids there.
 */
export async function inForceStatementIds(
  tx: Transaction,
  regulator: Regulator,
  now = new Date(),
): Promise<ReadonlySet<string> | null> {
  const rows = await tx.select().from(frameworkVersion);
  const live = frameworkInForce(rows.map(shell), regulator, ukIsoDate(now));
  if (!live) return null;
  const content = await frameworkContent(tx, live.id, now);
  if (!content) return null;
  return new Set(
    content.domain.keyQuestions.flatMap((q) => [q.id, ...q.statements.map((s) => s.id)]),
  );
}

export const linkItem = (row: typeof evidenceLink.$inferSelect) => ({
  id: row.id,
  recordType: row.recordType,
  recordId: row.recordId,
  frameworkVersionId: row.frameworkVersionId,
  statementIds: row.statementIds,
  taggedBy: row.taggedBy,
  taggedAt: row.taggedAt.toISOString(),
  removedAt: row.removedAt?.toISOString() ?? null,
  removedBy: row.removedBy,
  removalReason: row.removalReason,
  version: row.version,
});
