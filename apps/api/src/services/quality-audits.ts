import type { AuditQuestion, AuditRecordDetail, AuditTemplateItem } from "@harbour/contracts";
import { type auditAction, auditRecord, type auditTemplate, type Transaction } from "@harbour/db";
import {
  type AuditAnswer,
  type AuditKind,
  type AuditTemplate,
  auditFindingsByStatement,
  auditScoreMethod,
  SELF_RATING_WORDS,
  scoreAudit,
} from "@harbour/domain";
import { and, desc, eq } from "drizzle-orm";
import { frameworkSummaries } from "./quality-framework";

/**
 * Reading the audit programme (quality.md section 19; QUAL-004; migration 0081): rows into the
 * API's shapes, the score and findings worked out by the domain from the questions the audit
 * started with (never the template as it is now), and the last completed audit for a schedule.
 */

type TemplateRow = typeof auditTemplate.$inferSelect;
type RecordRow = typeof auditRecord.$inferSelect;
type ActionRow = typeof auditAction.$inferSelect;
export type Answers = Record<string, AuditAnswer | null>;

export const questionsOf = (value: unknown) => value as AuditQuestion[];
export const answersOf = (value: unknown) => value as Answers;

export const templateItem = (row: TemplateRow): AuditTemplateItem => ({
  id: row.id,
  key: row.key,
  kind: row.kind as AuditKind,
  title: row.title,
  frameworkVersionId: row.frameworkVersionId,
  questions: questionsOf(row.questions),
  starterKey: row.starterKey,
  state: row.state as AuditTemplateItem["state"],
  updatedAt: row.updatedAt.toISOString(),
  version: row.version,
});

/** The template an audit was scored against, as the domain takes it: the audit's own copy. */
export const scoredTemplate = (row: RecordRow): AuditTemplate => ({
  key: row.templateId,
  title: row.title,
  kind: row.kind as AuditKind,
  frameworkVersionId: row.frameworkVersionId,
  questions: questionsOf(row.questions),
});

export const recordSummary = (row: RecordRow) => ({
  id: row.id,
  templateId: row.templateId,
  kind: row.kind as AuditKind,
  title: row.title,
  frameworkVersionId: row.frameworkVersionId,
  locationId: row.locationId,
  auditedOn: row.auditedOn,
  state: row.state as "in_progress" | "completed",
  scorePercent: row.scorePercent === null ? null : Number(row.scorePercent),
  selfRating: row.selfRating,
  version: row.version,
});

/** An audit with its score, method, findings by statement and actions. */
export function recordDetail(
  row: RecordRow,
  actions: readonly ActionRow[],
  frameworkInForce: boolean,
): AuditRecordDetail {
  const template = scoredTemplate(row);
  const answers = answersOf(row.answers);
  const score = scoreAudit(template, answers);
  return {
    ...recordSummary(row),
    templateVersion: row.templateVersion,
    frameworkInForce,
    questions: [...questionsOf(row.questions)],
    answers,
    score: {
      percent: score.percent,
      achieved: score.achieved,
      possible: score.possible,
      complete: score.complete,
      unanswered: [...score.unanswered],
      method: auditScoreMethod(score),
    },
    selfRatingWords: row.selfRating === null ? null : (SELF_RATING_WORDS[row.selfRating] ?? null),
    findings: [...auditFindingsByStatement(template, answers)].map(
      ([statementId, questionKeys]) => ({
        statementId,
        questionKeys,
      }),
    ),
    actions: actions.map((a) => ({
      id: a.id,
      questionKey: a.questionKey,
      description: a.description,
      ownerId: a.ownerId,
      dueOn: a.dueOn,
      taskId: a.taskId,
    })),
    startedBy: row.startedBy,
    completedBy: row.completedBy,
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

/** The ids of the framework versions in force today (one per regulator at most). */
export async function frameworksInForce(tx: Transaction, now: Date): Promise<Set<string>> {
  return new Set((await frameworkSummaries(tx, now)).filter((v) => v.inForce).map((v) => v.id));
}

/** When the last audit of a template at a location was completed (its audit date), if ever. */
export async function lastCompletedOn(
  tx: Transaction,
  templateId: string,
  locationId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ auditedOn: auditRecord.auditedOn })
    .from(auditRecord)
    .where(
      and(
        eq(auditRecord.templateId, templateId),
        eq(auditRecord.locationId, locationId),
        eq(auditRecord.state, "completed"),
      ),
    )
    .orderBy(desc(auditRecord.auditedOn))
    .limit(1);
  return row?.auditedOn ?? null;
}
