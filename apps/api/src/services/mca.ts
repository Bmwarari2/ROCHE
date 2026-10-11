import {
  type capacityAssessment,
  type consentRecord,
  dolsAuthorisation,
  featureFlag,
  notification,
  person,
  role,
  roleAssignment,
  type Transaction,
  task,
} from "@harbour/db";
import {
  type CapacityAssessmentView,
  type ConsentDecisionKind,
  type ConsentRecordView,
  type DolsNation,
  type DolsRates,
  dolsReminders,
  type FlagRow,
  isClosedRecord,
  type RepresentativeAuthority,
  ukIsoDate,
} from "@harbour/domain";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { publish } from "../outbox";
import { dolsRates, toDolsView } from "./safety";

/**
 * Consent, capacity and DoLS wired to the database (docs/specs/care.md rules 9 to 11; HZ-020 and
 * HZ-026): rows as the domain rules read them, and the DoLS expiry reminders the worker raises.
 */

type ConsentRow = typeof consentRecord.$inferSelect;
type CapacityRow = typeof capacityAssessment.$inferSelect;

/** The representative's authority as `checkConsentRecord` reads it. */
export function representativeAuthority(row: ConsentRow): RepresentativeAuthority | null {
  switch (row.representativeKind) {
    case null:
      return null;
    case "lpa_health_welfare":
      return {
        kind: "lpa_health_welfare",
        registered: row.lpaRegistered === true,
        excludedDecisions: row.excludedDecisions as ConsentDecisionKind[],
        opgReference: row.opgReference,
      };
    case "lpa_property_financial":
      return {
        kind: "lpa_property_financial",
        registered: row.lpaRegistered === true,
        opgReference: row.opgReference,
      };
    case "deputy":
      return {
        kind: "deputy",
        scope: row.deputyScope === "personal_welfare" ? "personal_welfare" : "property_and_affairs",
        decisions: row.deputyDecisions as ConsentDecisionKind[],
        restraintExpresslyAuthorised: row.deputyRestraintAuthorised === true,
        orderEndsAt: row.deputyOrderEndsAt,
        courtReference: row.courtReference,
      };
    case "appointee":
    case "imca":
    case "advocate":
    case "family_or_friend":
      return { kind: row.representativeKind };
    default:
      return { kind: "family_or_friend" };
  }
}

export function consentView(row: ConsentRow): ConsentRecordView {
  const authority = representativeAuthority(row);
  return {
    id: row.id,
    decision: row.decision as ConsentDecisionKind,
    outcome: row.outcome as "given" | "refused",
    givenBy:
      row.givenByKind === "representative" && authority
        ? { kind: "representative", authority }
        : { kind: "person" },
    capacity:
      row.capacityStatus === "assumed" || !row.capacityAssessmentId
        ? { status: "assumed" }
        : {
            status: row.capacityStatus as "has_capacity" | "lacks_capacity",
            assessmentId: row.capacityAssessmentId,
          },
    givenAt: row.givenAt,
    expiresAt: row.expiresAt,
    withdrawnAt: row.withdrawnAt,
    evidence: row.evidence,
    restraintConditions:
      row.restraintNecessary === null || row.restraintProportionate === null
        ? null
        : {
            necessaryToPreventHarm: row.restraintNecessary,
            proportionate: row.restraintProportionate,
          },
    bestInterestsDecisionId: row.bestInterestsDecisionId,
  };
}

/** The current assessments (not superseded) as the capacity rules read them. */
export function capacityViews(rows: readonly CapacityRow[]): CapacityAssessmentView[] {
  const superseded = new Set(rows.flatMap((r) => (r.supersedesId ? [r.supersedesId] : [])));
  return rows
    .filter((r) => !superseded.has(r.id))
    .map((r) => ({
      id: r.id,
      decisionKind: (r.decisionKind ?? null) as ConsentDecisionKind | null,
      assessedAt: r.assessedAt,
      outcome: r.outcome as "has_capacity" | "lacks_capacity",
      reviewOn: r.reviewOn,
    }));
}

export async function flagRows(tx: Transaction): Promise<FlagRow[]> {
  return tx
    .select({
      flagKey: featureFlag.flagKey,
      locationId: featureFlag.locationId,
      enabled: featureFlag.enabled,
    })
    .from(featureFlag)
    .where(isNull(featureFlag.deletedAt));
}

/** Registered Managers at a location (tenant-wide ones too); the owner when there is none. */
async function registeredManagers(tx: Transaction, locationId: string): Promise<string[]> {
  const holders = (keys: readonly string[]) =>
    tx
      .selectDistinct({ id: roleAssignment.tenantUserId })
      .from(roleAssignment)
      .innerJoin(role, eq(role.id, roleAssignment.roleId))
      .where(
        and(
          inArray(role.key, [...keys]),
          isNull(roleAssignment.deletedAt),
          or(isNull(roleAssignment.locationId), eq(roleAssignment.locationId, locationId)),
        ),
      );
  const managers = await holders(["registered_manager"]);
  return (managers.length > 0 ? managers : await holders(["owner"])).map((m) => m.id);
}

export const DOLS_EXPIRY_TASK = "care.dols_expiry";

/**
 * DoLS expiry reminders (care.md rule 11; HZ-020): at `dols.expiry_reminder_days.first` and
 * `.second` days before an authorisation ends, one task and one alert for the Registered Manager
 * and the `care.dols.expiring` event. Each reminder fires once: a task already raised for the
 * authorisation at that time, whatever its status, stops a second.
 */
export async function raiseDolsReminders(
  tx: Transaction,
  tenantId: string,
  now: Date,
): Promise<number> {
  const rows = await tx
    .select({ auth: dolsAuthorisation, personStatus: person.status })
    .from(dolsAuthorisation)
    .innerJoin(person, eq(person.id, dolsAuthorisation.personId))
    .where(
      and(
        eq(dolsAuthorisation.outcome, "granted"),
        isNull(dolsAuthorisation.endedAt),
        isNull(dolsAuthorisation.deletedAt),
      ),
    );
  const ratesByNation = new Map<DolsNation, DolsRates>();
  let raised = 0;
  for (const { auth, personStatus } of rows) {
    if (isClosedRecord(personStatus)) continue;
    const nation = auth.nation as DolsNation;
    const rates =
      ratesByNation.get(nation) ?? (await dolsRates(tx, tenantId, nation, ukIsoDate(now)));
    ratesByNation.set(nation, rates);
    for (const reminder of dolsReminders(toDolsView(auth), rates)) {
      if (reminder.dueAt.getTime() > now.getTime()) continue;
      if (reminder.endsAt.getTime() <= now.getTime()) continue;
      const [already] = await tx
        .select({ id: task.id })
        .from(task)
        .where(
          and(
            eq(task.kind, DOLS_EXPIRY_TASK),
            eq(task.sourceId, auth.id),
            eq(task.dueAt, reminder.dueAt),
          ),
        )
        .limit(1);
      if (already) continue;
      const [created] = await tx
        .insert(task)
        .values({
          kind: DOLS_EXPIRY_TASK,
          title: "Renew or review a DoLS authorisation before it ends",
          requiredPermission: "care.dols.manage",
          personId: auth.personId,
          locationId: auth.locationId,
          sourceType: "dols_authorisation",
          sourceId: auth.id,
          assigneeRoleKey: "registered_manager",
          dueAt: reminder.dueAt,
          windowStart: reminder.dueAt,
          windowEnd: reminder.endsAt,
          priority: reminder.key === "second" ? "urgent" : "routine",
        })
        .returning({ id: task.id });
      for (const recipient of await registeredManagers(tx, auth.locationId)) {
        await tx
          .insert(notification)
          .values({
            recipientTenantUserId: recipient,
            kind: "care.dols.expiring",
            severity: reminder.key === "second" ? "urgent" : "warning",
            title: "A DoLS authorisation ends soon",
            body: "Open the person's DoLS register to renew or review it.",
            link: `/people/${auth.personId}/dols`,
            channels: ["in_app", "email"],
            sourceType: "task",
            sourceId: created?.id ?? null,
            dedupeKey: `dols_expiry:${auth.id}:${reminder.key}:${reminder.endsAt.toISOString()}`,
          })
          .onConflictDoNothing();
      }
      await publish(tx, {
        context: "care",
        aggregateType: "dols_authorisation",
        aggregateId: auth.id,
        type: "care.dols.expiring",
        payload: {
          dolsAuthorisationId: auth.id,
          reminder: reminder.key,
          endsAt: reminder.endsAt.toISOString(),
        },
      });
      raised++;
    }
  }
  return raised;
}
