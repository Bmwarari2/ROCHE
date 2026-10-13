import {
  advanceCareRecord,
  allergy,
  auditEvent,
  carePlan,
  carePlanSection,
  contact,
  document,
  downtimePack,
  location,
  outage,
  person,
  personCareProfile,
  riskAssessment,
  type Transaction,
  task,
} from "@harbour/db";
import {
  type AdvanceCareRecordState,
  assembleDowntimePack,
  type DowntimeFreshnessContext,
  type DowntimePack,
  type DowntimePersonInput,
  type DowntimeRisk,
  LIVE_PERSON_STATUSES,
  OPERATIONS_RATE_KEYS,
  type OperationsRates,
  type PcspDomain,
  type PersonStatus,
  type RateNation,
  RISK_TEMPLATES,
  type RiskBand,
  type RiskTemplateKey,
  resolveOperationsRates,
  ukIsoDate,
} from "@harbour/domain";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { publish } from "../outbox";
import { rateRows } from "./rates";
import { allergyStatementOf, communicationStatementOf } from "./transfer-pack";

/**
 * The downtime pack from the record (operations.md rules 1 to 8; OPS-028; HZ-001, HZ-015, HZ-016,
 * HZ-021, HZ-024). Everything is read in the caller's view, for the location's own people
 * receiving care only, so nothing is left out and the stored pack names no one else (#32 review
 * round 2); `assembleDowntimePack` does the rest. Until the eMAR and PEEPs exist, the medicines and
 * evacuation sections say where the location keeps them; a place not yet confirmed by a holder of
 * `platform.location.manage` prints as not set (H-201).
 */

export type PackSource = "server_nightly" | "server_rebuild" | "server_on_demand";
type Nation = Exclude<RateNation, "uk" | "all">;

const PLACE_NOT_SET = "where it is kept is not set in Harbour: ask the nurse in charge";

export async function operationsRates(
  tx: Transaction,
  tenantId: string,
  nation: Nation,
  now: Date,
): Promise<OperationsRates> {
  return resolveOperationsRates(
    await rateRows(tx, Object.values(OPERATIONS_RATE_KEYS)),
    nation,
    ukIsoDate(now),
    tenantId,
  );
}

/** The location as the pack needs it, or null when the caller cannot see it. */
export async function packLocation(tx: Transaction, locationId: string) {
  const [row] = await tx
    .select({
      id: location.id,
      name: location.name,
      nation: location.nation,
      mar: location.downtimeMarLocation,
      peep: location.downtimePeepLocation,
      confirmedAt: location.downtimePlacesConfirmedAt,
      updatedAt: location.updatedAt,
    })
    .from(location)
    .where(and(eq(location.id, locationId), isNull(location.deletedAt)));
  return row ?? null;
}
type PackLocation = NonNullable<Awaited<ReturnType<typeof packLocation>>>;

/** The location's own people receiving care, as the caller can see them. */
export async function livePeopleAt(tx: Transaction, locationId: string) {
  return tx
    .select()
    .from(person)
    .where(
      and(
        eq(person.locationId, locationId),
        inArray(person.status, [...LIVE_PERSON_STATUSES]),
        isNull(person.deletedAt),
      ),
    );
}

const latest = (dates: readonly (Date | null)[]): Date | null =>
  dates.reduce<Date | null>((a, d) => (d && (!a || d > a) ? d : a), null);

async function packPeople(
  tx: Transaction,
  place: PackLocation,
  people: Awaited<ReturnType<typeof livePeopleAt>>,
): Promise<DowntimePersonInput[]> {
  const ids = people.map((p) => p.id);
  if (ids.length === 0) return [];
  const [allergies, records, profiles, contacts, plans, risks] = await Promise.all([
    tx
      .select()
      .from(allergy)
      .where(
        and(
          inArray(allergy.personId, ids),
          eq(allergy.status, "active"),
          isNull(allergy.deletedAt),
        ),
      ),
    tx
      .select()
      .from(advanceCareRecord)
      .where(and(inArray(advanceCareRecord.personId, ids), isNull(advanceCareRecord.deletedAt))),
    tx.select().from(personCareProfile).where(inArray(personCareProfile.personId, ids)),
    tx
      .select()
      .from(contact)
      .where(and(inArray(contact.personId, ids), isNull(contact.deletedAt))),
    tx
      .select()
      .from(carePlan)
      .where(
        and(
          inArray(carePlan.personId, ids),
          eq(carePlan.status, "active"),
          isNull(carePlan.deletedAt),
        ),
      ),
    tx
      .select()
      .from(riskAssessment)
      .where(
        and(
          inArray(riskAssessment.personId, ids),
          eq(riskAssessment.status, "active"),
          isNull(riskAssessment.deletedAt),
        ),
      ),
  ]);
  const sections =
    plans.length === 0
      ? []
      : await tx
          .select()
          .from(carePlanSection)
          .where(
            and(
              inArray(
                carePlanSection.planId,
                plans.map((p) => p.id),
              ),
              isNull(carePlanSection.deletedAt),
            ),
          );
  const photoIds = people.flatMap((p) => (p.photoDocumentId ? [p.photoDocumentId] : []));
  const photos =
    photoIds.length === 0
      ? []
      : await tx
          .select({ id: document.id, personId: document.personId, createdAt: document.createdAt })
          .from(document)
          .where(and(inArray(document.id, photoIds), isNull(document.deletedAt)));

  const confirmed = place.confirmedAt !== null;
  const marWhere = confirmed ? place.mar : `the paper MAR (${PLACE_NOT_SET})`;
  const peepWhere = confirmed ? place.peep : `the person's PEEP (${PLACE_NOT_SET})`;
  const of = <T extends { personId: string }>(rows: readonly T[], id: string) =>
    rows.filter((r) => r.personId === id);

  return people.map((p): DowntimePersonInput => {
    const own = of(allergies, p.id);
    const acr = of(records, p.id);
    const profile = profiles.find((r) => r.personId === p.id);
    const plan = plans.find((r) => r.personId === p.id);
    const photo = photos.find((d) => d.id === p.photoDocumentId);
    const personRisks = of(risks, p.id);
    return {
      personId: p.id,
      locationId: p.locationId,
      status: p.status as PersonStatus,
      givenName: p.givenName,
      familyName: p.familyName,
      preferredName: p.preferredName,
      dateOfBirth: p.dateOfBirth,
      nhsNumber: p.nhsNumber,
      roomLabel: p.roomLabel,
      // The document's own person decides whose photo it is, so a misfiled one is withheld.
      photo: photo
        ? {
            personId: photo.personId ?? "",
            asOf: photo.createdAt,
            data: { documentId: photo.id, takenOn: ukIsoDate(photo.createdAt) },
          }
        : null,
      allergies: {
        personId: p.id,
        asOf: latest([p.allergyStatusConfirmedAt, ...own.map((a) => a.updatedAt)]),
        data: allergyStatementOf(p, own),
      },
      resuscitation: {
        personId: p.id,
        asOf: latest(acr.map((r) => r.updatedAt)),
        data: acr.map(
          (r): AdvanceCareRecordState => ({
            id: r.id,
            kind: r.kind as AdvanceCareRecordState["kind"],
            status: r.status as AdvanceCareRecordState["status"],
            cprDecision: (r.cprDecision ?? null) as AdvanceCareRecordState["cprDecision"],
            completedOn: r.completedOn,
            clinicianName: r.clinicianName,
            clinicianRole: r.clinicianRole,
            reviewDueOn: r.reviewDueOn,
          }),
        ),
      },
      eatingAndDrinking: profile
        ? {
            personId: profile.personId,
            asOf: profile.iddsiChangedAt ?? profile.updatedAt,
            data: {
              foodLevel: profile.iddsiFoodLevel,
              drinkLevel: profile.iddsiDrinkLevel,
              notes: profile.iddsiAdvisedBy ? `Levels advised by ${profile.iddsiAdvisedBy}` : null,
            },
          }
        : null,
      communication: {
        personId: p.id,
        asOf: p.communicationNeedsConfirmedAt,
        data: communicationStatementOf(p),
      },
      evacuation: {
        personId: p.id,
        asOf: null,
        data: { status: "held_elsewhere", where: peepWhere },
      },
      medicinesDue: {
        personId: p.id,
        asOf: null,
        data: { status: "held_elsewhere", where: marWhere },
      },
      contacts: of(contacts, p.id).map((c) => ({
        personId: c.personId,
        name: `${c.givenName} ${c.familyName}`,
        relationship: c.relationship,
        role: c.role,
        phone: c.phone,
      })),
      carePlan: plan
        ? {
            personId: plan.personId,
            asOf: plan.publishedAt,
            data: {
              publishedVersion: plan.publishedVersion ?? 0,
              sections: sections
                .filter((s) => s.planId === plan.id && s.personId === p.id && s.need)
                .map((s) => ({
                  domain: s.domain as PcspDomain,
                  need: s.need ?? "",
                  contingency: s.contingency,
                })),
            },
          }
        : null,
      risks: {
        personId: p.id,
        asOf: latest(personRisks.map((r) => r.updatedAt)),
        data: personRisks.map(
          (r): DowntimeRisk => ({
            title: RISK_TEMPLATES[r.templateKey as RiskTemplateKey]?.title ?? r.templateKey,
            hazard: r.hazard,
            controls: r.controls.join("; "),
            band: (r.residualBand ?? r.riskBand ?? null) as RiskBand | null,
            reviewDueOn: r.reviewDueOn,
          }),
        ),
      },
    };
  });
}

/** Counts of the pack's warnings by kind: the `warnings` column holds counts only. */
function warningCounts(pack: DowntimePack): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const w of pack.warnings) counts[w.kind] = (counts[w.kind] ?? 0) + 1;
  return counts;
}

export type StoredPackRow = typeof downtimePack.$inferSelect;

/**
 * Builds and stores the location's pack now, in the caller's view (`generatedBy` the member
 * building it, null for the nightly job), and publishes `operations.downtime_pack.generated` so
 * kiosks fetch it. The caller audits it.
 */
export async function buildDowntimePack(
  tx: Transaction,
  input: {
    readonly tenantId: string;
    readonly locationId: string;
    readonly source: PackSource;
    readonly generatedBy: string | null;
    readonly now: Date;
  },
): Promise<StoredPackRow> {
  const place = await packLocation(tx, input.locationId);
  if (!place) throw new Error("location not visible");
  const rates = await operationsRates(tx, input.tenantId, place.nation as Nation, input.now);
  const people = await livePeopleAt(tx, place.id);
  // A UUIDv7 from the database, so the stored row and the pack's own id agree.
  const [{ id: packId }] = (await tx.execute<{ id: string }>(sql`SELECT app.uuid_v7() AS id`))
    .rows as [{ id: string }];
  const result = assembleDowntimePack(
    {
      packId,
      locationId: place.id,
      locationName: place.name,
      generatedAt: input.now,
      asAt: input.now,
      people: await packPeople(tx, place, people),
    },
    rates,
  );
  if (!result.ok) throw new Error(result.problem);
  const { pack } = result;
  const [row] = await tx
    .insert(downtimePack)
    .values({
      id: pack.packId,
      locationId: pack.locationId,
      source: input.source,
      generatedAt: pack.generatedAt,
      asAt: pack.asAt,
      validUntil: pack.validUntil,
      generatedBy: input.generatedBy,
      content: JSON.parse(JSON.stringify(pack)),
      warnings: warningCounts(pack),
    })
    .returning();
  if (!row) throw new Error("pack not stored");
  await publish(tx, {
    context: "operations",
    aggregateType: "downtime_pack",
    aggregateId: row.id,
    type: "operations.downtime_pack.generated",
    payload: { locationId: row.locationId, packId: row.id, source: row.source },
  });
  return row;
}

/** The latest pack at the location that the caller can open (row-level security decides). */
export async function latestVisiblePack(
  tx: Transaction,
  locationId: string,
): Promise<StoredPackRow | null> {
  const [row] = await tx
    .select()
    .from(downtimePack)
    .where(eq(downtimePack.locationId, locationId))
    .orderBy(desc(downtimePack.generatedAt))
    .limit(1);
  return row ?? null;
}

/**
 * Whether a stored pack still serves the location now (#32 review round 1, clinical M1): it names
 * exactly the people receiving care here, each with the status they have now (so "On leave" and
 * "In hospital" are right), it was built after the location last changed (where the MAR and PEEPs
 * are kept), and it is in date. A move in or out, an admission, a discharge, a death, a stay in
 * hospital or a return since it was built, or an expired pack, means a new one is built.
 */
export function packServes(
  row: StoredPackRow | null,
  people: readonly { id: string; status: string }[],
  place: { readonly updatedAt: Date },
  now: Date,
): boolean {
  if (!row || row.validUntil.getTime() <= now.getTime()) return false;
  if (place.updatedAt.getTime() > row.generatedAt.getTime()) return false;
  const pages = (row.content as { pages?: { personId?: string; status?: string }[] }).pages ?? [];
  const statuses = new Map(pages.map((p) => [p.personId, p.status]));
  return statuses.size === people.length && people.every((p) => statuses.get(p.id) === p.status);
}

/** The outage open at the location, for the freshness words (rule 2). */
export async function freshnessContext(
  tx: Transaction,
  locationId: string,
  rates: Pick<OperationsRates, "clockDriftMinutes">,
): Promise<DowntimeFreshnessContext> {
  const [open] = await tx
    .select({ startedAt: outage.startedAt })
    .from(outage)
    .where(
      and(eq(outage.locationId, locationId), eq(outage.state, "declared"), isNull(outage.endedAt)),
    )
    .limit(1);
  return { outage: open ?? null, clockDriftMinutes: rates.clockDriftMinutes };
}

/** Written as the system: the nightly job and rebuilds after a move have no member. */
export async function auditAsSystem(
  tx: Transaction,
  tenantId: string,
  row: StoredPackRow,
  reason: string,
): Promise<void> {
  await tx.insert(auditEvent).values({
    tenantId,
    action: "operations.downtime_pack.generated",
    resourceType: "downtime_pack",
    resourceId: row.id,
    scope: { locationId: row.locationId, source: row.source, reason },
  });
}

/**
 * Builds a location's pack again, as the system, when the latest no longer serves the people
 * receiving care there (operations.md section 12; HZ-021): after a person's admission, move,
 * leave, hospital stay, return, discharge, death or correction, at the location they were at and
 * the one they are at now. Idempotent: a pack that still serves is kept.
 */
export async function rebuildAfterMove(
  tx: Transaction,
  tenantId: string,
  personId: string,
  fromLocationId: string | null,
  now: Date,
): Promise<number> {
  const [current] = await tx
    .select({ locationId: person.locationId })
    .from(person)
    .where(eq(person.id, personId));
  const locations = new Set([fromLocationId, current?.locationId].filter((l): l is string => !!l));
  let built = 0;
  for (const locationId of locations) {
    const place = await packLocation(tx, locationId);
    if (!place) continue;
    const people = await livePeopleAt(tx, locationId);
    const latestPack = await latestVisiblePack(tx, locationId);
    if (packServes(latestPack, people, place, now) || (!latestPack && people.length === 0))
      continue;
    const row = await buildDowntimePack(tx, {
      tenantId,
      locationId,
      source: "server_rebuild",
      generatedBy: null,
      now,
    });
    await auditAsSystem(tx, tenantId, row, "person_moved");
    built++;
  }
  return built;
}

/** The task asking a holder of platform.location.manage to confirm the MAR and PEEP places. */
export const DOWNTIME_PLACES_TASK = "operations.downtime_places";

/**
 * While the places are unconfirmed, one open task for the location's Registered Manager to
 * confirm them (H-201); confirming them completes it.
 */
export async function ensurePlacesTask(
  tx: Transaction,
  place: { readonly id: string; readonly confirmedAt: Date | null },
  now: Date,
): Promise<boolean> {
  if (place.confirmedAt) return false;
  const [open] = await tx
    .select({ id: task.id })
    .from(task)
    .where(
      and(
        eq(task.kind, DOWNTIME_PLACES_TASK),
        eq(task.sourceId, place.id),
        inArray(task.status, ["open", "in_progress"]),
      ),
    )
    .limit(1);
  if (open) return false;
  await tx.insert(task).values({
    kind: DOWNTIME_PLACES_TASK,
    title: "Confirm where the paper MAR and the PEEPs are kept",
    requiredPermission: "platform.location.manage",
    locationId: place.id,
    sourceType: "location",
    sourceId: place.id,
    assigneeRoleKey: "registered_manager",
    dueAt: now,
  });
  return true;
}

/**
 * The nightly pack for every location of the organisation (rule 8), once per location and UK
 * night: a location that already has tonight's nightly pack is left alone, and each location runs
 * in its own savepoint so one location's failure does not stop the others. Raises the places task
 * where the places are unconfirmed.
 */
export async function buildNightlyPacks(
  tx: Transaction,
  tenantId: string,
  now: Date,
  onFailure: (locationId: string, error: unknown) => void,
): Promise<number> {
  const night = ukIsoDate(now);
  const locations = await tx
    .select({ id: location.id, confirmedAt: location.downtimePlacesConfirmedAt })
    .from(location)
    .where(and(isNull(location.deletedAt), eq(location.status, "active")));
  let built = 0;
  for (const place of locations) {
    try {
      built += await tx.transaction(async (sp) => {
        await sp.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${`downtime-pack:${tenantId}:${place.id}:${night}`}))`,
        );
        await ensurePlacesTask(sp, place, now);
        const done = await sp
          .select({ id: downtimePack.id, generatedAt: downtimePack.generatedAt })
          .from(downtimePack)
          .where(
            and(eq(downtimePack.locationId, place.id), eq(downtimePack.source, "server_nightly")),
          )
          .orderBy(desc(downtimePack.generatedAt))
          .limit(1);
        if (done[0] && ukIsoDate(done[0].generatedAt) === night) return 0;
        const row = await buildDowntimePack(sp, {
          tenantId,
          locationId: place.id,
          source: "server_nightly",
          generatedBy: null,
          now,
        });
        await auditAsSystem(sp, tenantId, row, "nightly");
        return 1;
      });
    } catch (error) {
      onFailure(place.id, error);
    }
  }
  return built;
}
