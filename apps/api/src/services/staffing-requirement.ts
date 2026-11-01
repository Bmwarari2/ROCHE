import {
  admissionDecision,
  dependencyAssessment,
  dependencyScale,
  dependencyScaleVersion,
  person,
  type Transaction,
} from "@harbour/db";
import {
  type DependencyAssessmentKind,
  type DependencyRecord,
  type DependencyScaleDefinition,
  type DependencyScaleState,
  LIVE_PERSON_STATUSES,
  type PeriodMinutes,
  type PresenceFacts,
  presenceOn,
  type ScaleVersionRecord,
  type StaffingRequirement,
  scaleForLocation,
  staffingRequirement,
  ukIsoDate,
} from "@harbour/domain";
import { and, eq, inArray, isNull } from "drizzle-orm";

/**
 * The required care hours for a location on a UK date (scheduling.md section 13 rules 9 and 10;
 * HZ-123), shared by the requirement route (slice 12) and the rota's staffing comparison (slice
 * 21). Reads with the caller's rights: both callers first require scheduling.rota.manage and
 * care.plan.read in a scope that covers the whole location, so nobody living there is hidden.
 */

type ScaleRow = typeof dependencyScale.$inferSelect;
type VersionRow = typeof dependencyScaleVersion.$inferSelect;
type RecordRow = typeof dependencyAssessment.$inferSelect;

export const domainVersion = (row: VersionRow): ScaleVersionRecord => ({
  id: row.id,
  scaleId: row.scaleId,
  versionNumber: row.versionNumber,
  state: row.state as DependencyScaleState,
  definition: row.definition as DependencyScaleDefinition,
  authorId: row.authorId,
  contributorIds: row.contributorIds,
  approvedBy: row.approvedBy,
  approvedAt: row.approvedAt,
});

export const domainRecord = (row: RecordRow): DependencyRecord => ({
  id: row.id,
  personId: row.personId,
  scaleId: row.scaleId,
  scaleVersionId: row.scaleVersionId,
  categoryKey: row.categoryKey,
  oneToOne: row.oneToOne as PeriodMinutes[],
  kind: row.kind as DependencyAssessmentKind,
  effectiveFrom: row.effectiveFrom,
  supersedesId: row.supersedesId,
  decidedBy: row.decidedBy,
  reason: row.reason,
  recordedAt: row.recordedAt,
});

/** The organisation's scales still in use, with each one's versions. */
export async function liveScales(tx: Transaction): Promise<ScaleRow[]> {
  return tx.select().from(dependencyScale).where(isNull(dependencyScale.deletedAt));
}

export async function recordsOf(
  tx: Transaction,
  personIds: readonly string[],
): Promise<RecordRow[]> {
  if (personIds.length === 0) return [];
  return tx
    .select()
    .from(dependencyAssessment)
    .where(inArray(dependencyAssessment.personId, [...personIds]));
}

/**
 * The planned admission date of each person being admitted, from the admission decision in force
 * (the one no later decision supersedes) when it says needs can be met; absent when none.
 */
async function plannedAdmissions(
  tx: Transaction,
  personIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (personIds.length === 0) return out;
  const decisions = await tx
    .select({
      id: admissionDecision.id,
      personId: admissionDecision.personId,
      canMeetNeeds: admissionDecision.canMeetNeeds,
      plannedAdmissionOn: admissionDecision.plannedAdmissionOn,
      supersedesId: admissionDecision.supersedesId,
    })
    .from(admissionDecision)
    .where(inArray(admissionDecision.personId, [...personIds]));
  const superseded = new Set(decisions.map((d) => d.supersedesId).filter(Boolean));
  for (const d of decisions) {
    if (superseded.has(d.id) || d.canMeetNeeds === "no" || !d.plannedAdmissionOn) continue;
    out.set(d.personId, d.plannedAdmissionOn);
  }
  return out;
}

/** The requirement for each period of the date (or one), with how many people were read. */
export async function locationRequirement(
  tx: Transaction,
  locationId: string,
  date: string,
  periodKey: string | null,
  asAt: Date,
): Promise<{ results: StaffingRequirement[]; people: number; scaleId: string | null }> {
  const scale = scaleForLocation(await liveScales(tx), locationId);
  const versions = scale
    ? await tx
        .select()
        .from(dependencyScaleVersion)
        .where(eq(dependencyScaleVersion.scaleId, scale.id))
    : [];
  // Everyone living at the location or being admitted to it; where each is on the date
  // asked comes from their status, when it began, and a planned admission (rule 9).
  const people = await tx
    .select({
      id: person.id,
      status: person.status,
      statusChangedAt: person.statusChangedAt,
    })
    .from(person)
    .where(
      and(
        eq(person.locationId, locationId),
        inArray(person.status, [...LIVE_PERSON_STATUSES, "pre_admission"]),
        isNull(person.deletedAt),
      ),
    );
  const planned = await plannedAdmissions(
    tx,
    people.filter((p) => p.status === "pre_admission").map((p) => p.id),
  );
  const records = (
    await recordsOf(
      tx,
      people.map((p) => p.id),
    )
  ).map(domainRecord);
  const today = ukIsoDate(asAt);
  const results = staffingRequirement({
    locationId,
    date: date,
    periodKey: periodKey,
    scale: scale
      ? { scaleId: scale.id, name: scale.name, versions: versions.map(domainVersion) }
      : null,
    people: people.map((p) => ({
      personId: p.id,
      presence: presenceOn(
        {
          status: p.status as PresenceFacts["status"],
          statusSince: p.status === "pre_admission" ? null : ukIsoDate(p.statusChangedAt),
          plannedAdmissionOn: planned.get(p.id) ?? null,
        },
        date,
        today,
      ),
      records: records.filter((r) => r.personId === p.id),
    })),
  });
  return { results, people: people.length, scaleId: scale?.id ?? null };
}
