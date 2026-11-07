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
  type MedicinesDueStatement,
  type MedicinesRates,
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
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { publish } from "../outbox";
import { medicinesRates } from "./medicine-administrations";
import { downtimeMedicinesFrom, emarFacts } from "./medicines-outputs";
import { rateNumber, rateRows } from "./rates";
import { allergyStatementOf, communicationStatementOf, currentAllergiesOf } from "./transfer-pack";

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

const PLACE_NOT_SET = "where it is kept is not set in Thapsus Care: ask the nurse in charge";

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

/**
 * Each person's medicines from the eMAR (slice 49; HZ-021): the doses due from `asAt` for the next
 * two days (the pack keeps its own window) and those still outstanding, and their when-required
 * medicines. A person with no eMAR entry, or whose eMAR cannot be read, keeps where the paper MAR
 * is kept; one person's failure never takes the pack from everyone else.
 */
async function packMedicines(
  tx: Transaction,
  place: PackLocation,
  tenantId: string,
  ids: readonly string[],
  asAt: Date,
  validHours: number,
): Promise<Map<string, MedicinesDueStatement | "unreadable">> {
  const out = new Map<string, MedicinesDueStatement | "unreadable">();
  // The pack's own validity (the rate `downtime_pack.valid_hours`), never a literal (review M5).
  const until = new Date(asAt.getTime() + validHours * 3_600_000);
  // The medicines rates once for the pack, for the location's nation (security review M3).
  let rates: MedicinesRates | null = null;
  for (const id of ids) {
    try {
      const statement = await tx.transaction(async (sp) => {
        const t = sp as unknown as Transaction;
        rates ??= await medicinesRates(t, tenantId, place.nation as Nation, ukIsoDate(asAt));
        const facts = await emarFacts(t, tenantId, id, asAt, rates);
        return facts ? downtimeMedicinesFrom(facts, asAt, until, asAt) : null;
      });
      if (statement) out.set(id, statement);
    } catch {
      // Never a silent fallback to the paper MAR for someone on the eMAR (reviews B2 and M1): the
      // page says the eMAR could not be read, the pack carries a warning, and the caller logs and
      // audits the person ids (`medicinesUnreadable`).
      out.set(id, "unreadable");
    }
  }
  return out;
}

async function packPeople(
  tx: Transaction,
  place: PackLocation,
  people: Awaited<ReturnType<typeof livePeopleAt>>,
  tenantId: string,
  asAt: Date,
  validHours: number,
): Promise<DowntimePersonInput[]> {
  const ids = people.map((p) => p.id);
  if (ids.length === 0) return [];
  const medicines = await packMedicines(tx, place, tenantId, ids, asAt, validHours);
  const [allergies, records, profiles, contacts, plans, risks] = await Promise.all([
    // Every allergy row of these people; allergyStatementOf keeps each person's current ones.
    tx
      .select()
      .from(allergy)
      .where(and(inArray(allergy.personId, ids), isNull(allergy.deletedAt))),
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
    const own = currentAllergiesOf(p.id, allergies);
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
      sample: p.isSample,
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
        data: allergyStatementOf(p, allergies),
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
        asOf: medicines.has(p.id) ? asAt : null,
        data: medicineStatement(medicines.get(p.id), marWhere),
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

/**
 * Whether anything the location's pack is built from has changed since `since` (#45 review round
 * 1, H1): the people themselves (identity, room, location, status, photo), their allergies,
 * advance care records, eating and drinking profile, contacts, care plans and their sections,
 * risk assessments and photo documents, and the location (where the MAR and PEEPs are kept), soft
 * deletes included. Compared in the database, to the microsecond, on its own clock; read in the
 * caller's view.
 */
export async function sourcesChangedSince(
  tx: Transaction,
  locationId: string,
  personIds: readonly string[],
  since: Date,
  snapshot: string | null = null,
): Promise<boolean> {
  const ids = sql`ARRAY[${sql.join(
    personIds.length > 0 ? personIds.map((id) => sql`${id}`) : [sql`NULL`],
    sql`, `,
  )}]::uuid[]`;
  const newest = (table: string, key = "person_id") =>
    sql`(SELECT max(greatest(t.updated_at, t.deleted_at)) FROM ${sql.identifier(table)} t
         WHERE t.${sql.identifier(key)} = ANY (${ids}))`;
  const { rows } = await tx.execute<{ changed: boolean | null }>(
    sql`SELECT greatest(
          (SELECT max(greatest(l.updated_at, l.deleted_at)) FROM location l WHERE l.id = ${locationId}),
          ${newest("person", "id")},
          ${newest("allergy")},
          ${newest("advance_care_record")},
          ${newest("person_care_profile")},
          ${newest("contact")},
          ${newest("care_plan")},
          ${newest("care_plan_section")},
          ${newest("risk_assessment")},
          ${newest("medication")},
          (SELECT max(a.recorded_at) FROM medication_administration a
            WHERE a.person_id = ANY (${ids})),
          (SELECT max(d.updated_at) FROM medication_dosing_record d
            WHERE d.person_id = ANY (${ids})),
          (SELECT max(greatest(d.updated_at, d.deleted_at)) FROM document d
            WHERE d.id IN (SELECT p.photo_document_id FROM person p WHERE p.id = ANY (${ids})))
        ) > ${since.toISOString()}::timestamptz AS changed`,
  );
  if (rows[0]?.changed === true) return true;
  return snapshot !== null && (await writtenAfterSnapshot(tx, locationId, ids, snapshot, since));
}

/**
 * Whether any source row was written by a transaction the build's snapshot could not see (slice
 * 49 review): a record's time is when its transaction began, so a write that began before the build
 * and committed after it has a time before the pack's "as at" and the time check misses it. The row's
 * `xmin` against the snapshot is commit order, so the printed "as at" never claims data it lacks.
 * Rows a later build saw are visible to its snapshot, so this never rebuilds in a loop. Limit: the
 * snapshot lists top-level transactions only, so a row written inside a savepoint of a transaction
 * still open at the build can read as seen; the administration route writes at the top level.
 */
async function writtenAfterSnapshot(
  tx: Transaction,
  locationId: string,
  ids: ReturnType<typeof sql>,
  snapshot: string,
  since: Date,
): Promise<boolean> {
  // The snapshot's xmax and in-progress ids as 32-bit ids, compared by age (newer is younger).
  const unseen = (alias: string) =>
    sql`(age(${sql.raw(alias)}.xmin) <= age(((split_part(${snapshot}, ':', 2))::bigint % 4294967296)::text::xid)
         OR ${sql.raw(alias)}.xmin::text = ANY (
           SELECT (x::bigint % 4294967296)::text
           FROM unnest(string_to_array(nullif(split_part(${snapshot}, ':', 3), ''), ',')) AS x))`;
  const byPerson = (table: string, key = "person_id") =>
    sql`EXISTS (SELECT 1 FROM ${sql.identifier(table)} t
         WHERE t.${sql.identifier(key)} = ANY (${ids}) AND ${unseen("t")})`;
  const { rows } = await tx.execute<{ changed: boolean }>(
    sql`SELECT (
          EXISTS (SELECT 1 FROM location l WHERE l.id = ${locationId} AND ${unseen("l")})
          OR ${byPerson("person", "id")}
          OR ${byPerson("allergy")}
          OR ${byPerson("advance_care_record")}
          OR ${byPerson("person_care_profile")}
          OR ${byPerson("contact")}
          OR ${byPerson("care_plan")}
          OR ${byPerson("care_plan_section")}
          OR ${byPerson("risk_assessment")}
          OR ${byPerson("medication")}
          -- Append-only and the largest: only rows recorded in the day before the pack (no write
          -- transaction runs that long), so the check never scans the whole history.
          OR EXISTS (SELECT 1 FROM medication_administration t
               WHERE t.person_id = ANY (${ids})
                 AND t.recorded_at > ${since.toISOString()}::timestamptz - interval '1 day'
                 AND ${unseen("t")})
          OR ${byPerson("medication_dosing_record")}
          OR EXISTS (SELECT 1 FROM document d
            WHERE d.id IN (SELECT p.photo_document_id FROM person p WHERE p.id = ANY (${ids}))
              AND ${unseen("d")})
        ) AS changed`,
  );
  return rows[0]?.changed === true;
}

/** The people whose eMAR could not be read when the pack was built (ids only, for logs and audit). */
export function medicinesUnreadable(row: Pick<StoredPackRow, "content">): string[] {
  const pages =
    (row.content as { pages?: { personId?: string; content?: { medicinesDue?: unknown } }[] })
      .pages ?? [];
  return pages
    .filter((p) => (p.content?.medicinesDue as { status?: string } | null)?.status === "unreadable")
    .map((p) => p.personId as string);
}

function medicineStatement(
  read: MedicinesDueStatement | "unreadable" | undefined,
  where: string,
): MedicinesDueStatement {
  if (read === "unreadable") return { status: "unreadable", where };
  return read ?? { status: "held_elsewhere", where };
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
  // The information's time is the database's clock before anything is read, so a change after it
  // (on the same clock) means the pack no longer serves (`sourcesChangedSince`).
  // With the snapshot taken at the same moment (`writtenAfterSnapshot`), stored with the pack.
  const [{ at, snapshot }] = (
    await tx.execute<{ at: string; snapshot: string }>(
      sql`SELECT clock_timestamp() AS at, pg_current_snapshot()::text AS snapshot`,
    )
  ).rows as [{ at: string; snapshot: string }];
  const asAt = new Date(at);
  const people = await livePeopleAt(tx, place.id);
  // A UUIDv7 from the database, so the stored row and the pack's own id agree.
  const [{ id: packId }] = (await tx.execute<{ id: string }>(sql`SELECT app.uuid_v7() AS id`))
    .rows as [{ id: string }];
  const result = assembleDowntimePack(
    {
      packId,
      locationId: place.id,
      locationName: place.name,
      generatedAt: asAt,
      asAt,
      people: await packPeople(
        tx,
        place,
        people,
        input.tenantId,
        asAt,
        rates.downtimePackValidHours,
      ),
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
      content: { ...JSON.parse(JSON.stringify(pack)), buildSnapshot: snapshot },
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
 * Whether a stored pack still serves the location now (#32 review round 1, clinical M1; #45
 * review round 1, H1): it names exactly the people receiving care here, each with the status they
 * have now (so "On leave" and "In hospital" are right), nothing it was built from has changed
 * since (`sourceChangedAt`: a new DNACPR, an allergy, a room swap, the places), and it is in date.
 * Otherwise a new one is built.
 */
export async function packServes(
  tx: Transaction,
  row: StoredPackRow | null,
  people: readonly { id: string; status: string }[],
  now: Date,
): Promise<boolean> {
  if (!row || row.validUntil.getTime() <= now.getTime()) return false;
  const ids = people.map((p) => p.id);
  const snapshot = (row.content as { buildSnapshot?: string }).buildSnapshot ?? null;
  if (await sourcesChangedSince(tx, row.locationId, ids, row.asAt, snapshot)) return false;
  // A pack whose eMAR read failed for someone is built again on the next read (security M1).
  if (medicinesUnreadable(row).length > 0) return false;
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
    scope: {
      locationId: row.locationId,
      source: row.source,
      reason,
      medicinesUnreadable: medicinesUnreadable(row),
    },
  });
}

/**
 * Builds a location's pack again, as the system, when the latest no longer serves the people
 * receiving care there (operations.md section 12; HZ-021). Idempotent: a pack that still serves is
 * kept. Returns whether one was built.
 */
export async function rebuildLocation(
  tx: Transaction,
  tenantId: string,
  locationId: string,
  reason: string,
  now: Date,
): Promise<boolean> {
  const place = await packLocation(tx, locationId);
  if (!place) return false;
  // One build at a time per location, as on a read.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`downtime-pack-build:${tenantId}:${locationId}`}))`,
  );
  const people = await livePeopleAt(tx, locationId);
  const latestPack = await latestVisiblePack(tx, locationId);
  if ((await packServes(tx, latestPack, people, now)) || (!latestPack && people.length === 0)) {
    return false;
  }
  const row = await buildDowntimePack(tx, {
    tenantId,
    locationId,
    source: "server_rebuild",
    generatedBy: null,
    now,
  });
  await auditAsSystem(tx, tenantId, row, reason);
  return true;
}

/**
 * After a person's admission, bed move, leave, hospital stay, return, discharge, death or
 * correction: the pack again at the location they were at and the one they are at now.
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
    if (await rebuildLocation(tx, tenantId, locationId, "person_moved", now)) built++;
  }
  return built;
}

/** The task asking a holder of platform.location.manage to confirm the MAR and PEEP places. */
export const DOWNTIME_PLACES_TASK = "operations.downtime_places";

/** The task telling the Registered Manager a location has no pack in date (#47 review round 1). */
export const DOWNTIME_PACK_MISSING_TASK = "operations.downtime_pack_missing";

/** The end of the UK day `days` after today, from the database's clock. */
async function endOfUkDay(tx: Transaction, days: number): Promise<Date> {
  const { rows } = await tx.execute<{ at: string }>(
    sql`SELECT ((((now() AT TIME ZONE 'Europe/London')::date + ${days}::int + 1)::timestamp
          AT TIME ZONE 'Europe/London') - interval '1 minute') AS at`,
  );
  return new Date(rows[0]?.at as string);
}

/** Whether the location already has an open task of this kind. */
async function hasOpenTask(tx: Transaction, kind: string, locationId: string): Promise<boolean> {
  const [open] = await tx
    .select({ id: task.id })
    .from(task)
    .where(
      and(
        eq(task.kind, kind),
        eq(task.sourceId, locationId),
        inArray(task.status, ["open", "in_progress"]),
      ),
    )
    .limit(1);
  return open !== undefined;
}

/**
 * While the places are unconfirmed, one open task for the location's Registered Manager to
 * confirm them (H-201), due at the end of the day `downtime.places_confirm_due_days` from now, so
 * it does not escalate the moment it is raised (HZ-008); confirming them completes it.
 */
export async function ensurePlacesTask(
  tx: Transaction,
  tenantId: string,
  place: { readonly id: string; readonly confirmedAt: Date | null },
): Promise<boolean> {
  if (place.confirmedAt) return false;
  if (await hasOpenTask(tx, DOWNTIME_PLACES_TASK, place.id)) return false;
  const days = await rateNumber(tx, tenantId, "downtime.places_confirm_due_days");
  await tx.insert(task).values({
    kind: DOWNTIME_PLACES_TASK,
    title: "Confirm where the paper MAR and the PEEPs are kept",
    requiredPermission: "platform.location.manage",
    locationId: place.id,
    sourceType: "location",
    sourceId: place.id,
    assigneeRoleKey: "registered_manager",
    dueAt: await endOfUkDay(tx, days),
  });
  return true;
}

/**
 * The nightly pack for every location of the organisation (rule 8), once per location and UK
 * night: a location that already has tonight's nightly pack is left alone, and each location runs
 * in its own savepoint so one location's failure does not stop the others. Then, each in a
 * savepoint of its own: the places task where the places are unconfirmed, and a task for the
 * Registered Manager wherever the location has no pack in date (#47 review round 1).
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
        if (medicinesUnreadable(row).length > 0) {
          // Raises the operator's job alarm by location id; the page says so (review B2).
          const unreadable = new Error("a person's eMAR could not be read");
          unreadable.name = "MedicinesUnreadable";
          onFailure(place.id, unreadable);
        }
        return 1;
      });
    } catch (error) {
      onFailure(place.id, error);
    }
    try {
      await tx.transaction((sp) => ensurePlacesTask(sp, tenantId, place));
    } catch (error) {
      onFailure(place.id, error);
    }
    try {
      await tx.transaction(async (sp) => {
        const [inDate] = await sp
          .select({ id: downtimePack.id })
          .from(downtimePack)
          .where(and(eq(downtimePack.locationId, place.id), gt(downtimePack.validUntil, now)))
          .limit(1);
        if (inDate || (await hasOpenTask(sp, DOWNTIME_PACK_MISSING_TASK, place.id))) return;
        await sp.insert(task).values({
          kind: DOWNTIME_PACK_MISSING_TASK,
          title: "This location has no downtime pack in date: build one and find out why",
          requiredPermission: "operations.downtime.read",
          locationId: place.id,
          sourceType: "location",
          sourceId: place.id,
          assigneeRoleKey: "registered_manager",
          dueAt: now,
        });
      });
    } catch (error) {
      onFailure(place.id, error);
    }
  }
  return built;
}
