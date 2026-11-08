import {
  SyncDeviceReport,
  SyncDiscard,
  SyncDiscardResult,
  SyncKeyLost,
  SyncToken,
  SyncUpload,
  SyncUploadResult,
} from "@harbour/contracts";
import {
  auditEvent,
  deviceDiscardEntry,
  deviceDiscardRecord,
  discardReason,
  location,
  person,
  personAssignment,
  tenantUser,
} from "@harbour/db";
import {
  type EffectiveAccess,
  HANDOVER_RATE_KEYS,
  hasClockDrift,
  narrowestScope,
  type Permission,
  scopeFor,
} from "@harbour/domain";
import {
  estimateBuckets,
  isValidWindowDays,
  medsRecentDays,
  OFFLINE_WINDOW_RATE_KEY,
  offlineWindowBlocks,
  offlineWindowDays,
  SYNC_BUCKET_LIMIT,
  shiftWindowDays,
} from "@harbour/sync/streams";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { auditInTx } from "../http/audit";
import { mfaRefusal, requirePermission, withTenant } from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { PerUserQuota } from "../http/quota";
import { accessRowsOfMember, workLocationIds } from "../services/access-rows";
import { agencyUploadCheck, agencyWindowEnd } from "../services/agency-window";
import {
  closeDeviceHoldOnDeletion,
  DISCARD_ACTIONS,
  DISCARD_OTHERS_PERMISSION,
  flagEntriesAlreadyUploaded,
  recordDeviceHold,
  recordKeyLost,
} from "../services/device-holds";
import {
  bindDevice,
  inSystemView,
  refuseCareModeOff,
  refuseRevokedDevice,
} from "../services/devices";
import { rateNumber } from "../services/rates";
import { withTenantWideScope } from "../services/safety";
import type { SyncTokenSigner } from "../sync/token";

/**
 * The window used when the rate table gives no usable figure: today (and tomorrow, for drift) only,
 * so a misconfigured tenant keeps less on its devices, never more. An alert is logged.
 */
const FAIL_SAFE_WINDOW_DAYS = 1;

/**
 * The day and night shift start times (minutes after midnight, UK time) for each nation, from the
 * rate table. A nation whose figures are missing, not whole minutes of a day, or not day before
 * night is left out, so the phone says it cannot tell which handover to expect rather than
 * guessing (ADR-0074), and is listed in `missing` for the operator's log (#50 review round 1,
 * clinical M4).
 */
async function shiftPatternsByNation(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  tenantId: string,
  nations: readonly string[],
): Promise<{
  readonly patterns: Record<string, { day: number; night: number; lead?: number }>;
  readonly missing: readonly string[];
}> {
  const out: Record<string, { day: number; night: number; lead?: number }> = {};
  const missing: string[] = [];
  const known = new Set<string>(["england", "wales", "scotland", "northern_ireland"]);
  const ours = [...new Set(nations)]
    .filter((n): n is "england" | "wales" | "scotland" | "northern_ireland" => known.has(n))
    .sort();
  for (const nation of ours) {
    const day = await rateNumber(
      tx,
      tenantId,
      HANDOVER_RATE_KEYS.dayShiftStartMinute,
      nation,
    ).catch(() => null);
    const night = await rateNumber(
      tx,
      tenantId,
      HANDOVER_RATE_KEYS.nightShiftStartMinute,
      nation,
    ).catch(() => null);
    // How long before a shift ends the phone shows its own handover first (H-420); without a
    // readable figure the phone shows the handover the shift received first.
    const lead = await rateNumber(
      tx,
      tenantId,
      HANDOVER_RATE_KEYS.previewLeadMinutes,
      nation,
    ).catch(() => null);
    const minute = (m: number | null): m is number =>
      m !== null && Number.isInteger(m) && m >= 0 && m < 24 * 60;
    if (minute(day) && minute(night) && day < night) {
      out[nation] = { day, night, ...(minute(lead) ? { lead } : {}) };
    } else missing.push(nation);
  }
  return { patterns: out, missing };
}

/**
 * Per-user quotas on what a device sends on its own (security reviews round 4, M4 and round 5,
 * S-M2). Real use is a deletion now and then (two stages each, sent again a few times when the
 * network fails) and a report after each sync; a full window is a 429, which the device reads as
 * "try again later". Each deletion record lists at most 500 entry ids, and each person's new
 * records list at most a day's worth, so one token cannot grow the hash-chained audit trail for
 * good. Each person starts at most 20 deletion records a day, with or without ids (security review
 * round 6, M2 remainder): a record with no ids costs nothing against the id quota.
 */
const DISCARDS_PER_HOUR = 30;
const DISCARD_RECORDS_PER_DAY = 20;
const DISCARD_IDS_PER_DAY = 2_000;
const REPORTS_PER_HOUR = 120;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * The permissions each family of sync streams follows (packages/sync/src/streams/
 * sync-config.yaml): the person and their allergies, the care reference (profile, active plan,
 * risk assessments, tool results, advance care records) with the active plan's details, and the
 * recent notes, charts, marks, activities and visits. Each family syncs where its own permissions
 * reach, from the roles and grants carrying them (ADR-0071 review round 1, C-M1). A person syncs
 * only where their care reference syncs too, so the phone never shows a resuscitation decision
 * or IDDSI level as "not recorded" when it is merely absent from the device (review round 2).
 * The round's open tasks follow the care family (care.plan.read, the round view's permission), and
 * the handovers with their items, notes and acknowledgements follow care.handover.manage, the
 * permission the handover views read them with.
 * `entries_write` is not a stream: it tells the phone where it may record (care.note.write), so it
 * never offers to record what the server would refuse (review round 2, C2-M3).
 */
export const SYNCED_READS = {
  people: ["people.person.read", "care.plan.read"],
  care: ["care.plan.read"],
  entries: ["care.note.read"],
  handover: ["care.handover.manage"],
  entries_write: ["care.note.write"],
  // Medicines on the phone (medicines.md section 13.8; slice 68): who gives medicines.
  // A MAR syncs only with the person's name, photo and allergies (clinical review of the slice 68
  // rebuild, M1; HZ-007): the narrowest of giving medicines and the people family's reads.
  meds: ["medicines.emar.administer", "people.person.read", "care.plan.read"],
} as const satisfies Record<string, readonly Permission[]>;

type SyncFamily = keyof typeof SYNCED_READS;

/**
 * At most this many assigned people are named in the token's `entries_write_person_ids`, so the
 * token stays small; beyond it the claim is left out and the phone lets the server decide (review
 * round 3, C3-M2). A care worker is assigned to a handful of people.
 */
export const MAX_WRITE_PERSON_IDS = 100;

/**
 * Where one family syncs for a member: the locations whose people it carries in full, and whether
 * the people the member is assigned to sync for it (only when a role scoped to assigned people
 * carries every one of its permissions; S-M1), each the narrowest of its permissions' scopes. A
 * break-glass record never syncs.
 */
/** The token's bucket estimate passed PowerSync's limit (ADR-0134): refused by name, audited. */
class SyncScopeTooLarge extends Error {
  constructor(readonly estimate: number) {
    super("sync scope too large");
    this.name = "SyncScopeTooLarge";
  }
}

/** The statuses whose people the whole-home streams carry (sync-config.yaml, L1). */
const LIVE_STATUSES: ReadonlySet<string> = new Set(["active", "on_leave", "in_hospital"]);

/**
 * Whether a family's whole-home streams already carry every person the member is assigned to:
 * each one lives at a home in `locationIds` and is a person receiving care. Only then are the
 * assigned streams left off (ADR-0134); a member with no assignments is covered trivially.
 */
export function assignedCovered(
  locationIds: readonly string[],
  assigned: readonly { readonly locationId: string; readonly status: string }[],
): boolean {
  const homes = new Set(locationIds);
  return assigned.every((a) => homes.has(a.locationId) && LIVE_STATUSES.has(a.status));
}

export function familyReach(
  effective: EffectiveAccess,
  family: SyncFamily,
  allLocationIds: readonly string[],
): { readonly locationIds: string[]; readonly assigned: boolean } {
  const scope = narrowestScope(SYNCED_READS[family].map((p) => scopeFor(effective, p)));
  return {
    locationIds:
      scope.scope === "tenant"
        ? [...allLocationIds]
        : scope.scope === "locations"
          ? [...scope.locationIds]
          : [],
    assigned: scope.scope !== "none" && scope.includesAssigned,
  };
}

/** Deletions that remove a device's whole hold (or its unsent work at sign-out). */
const WHOLE_HOLD_KINDS: ReadonlySet<string> = new Set(["held_deleted", "signed_out_with_unsent"]);

import { createRouter, errorResponses, jsonBody, problem, security } from "./openapi";

/**
 * Offline sync (sections 6 and 17): the API mints PowerSync tokens and applies client uploads. It
 * is authoritative: uploads are validated and written through the same permission checks and
 * row-level security as any other write. Phase 0 has no writable synced tables yet, so every
 * operation is rejected with a reason the device can show.
 */
const WRITABLE_TABLES = new Set<string>();

export function createSyncRouter(signer: SyncTokenSigner) {
  const discardQuota = new PerUserQuota("sync.discards", DISCARDS_PER_HOUR, HOUR_MS);
  const discardRecordsQuota = new PerUserQuota(
    "sync.discard_records",
    DISCARD_RECORDS_PER_DAY,
    DAY_MS,
  );
  const discardIdsQuota = new PerUserQuota("sync.discard_ids", DISCARD_IDS_PER_DAY, DAY_MS);
  const reportQuota = new PerUserQuota("sync.reports", REPORTS_PER_HOUR, HOUR_MS);
  return createRouter()
    .openapi(
      createRoute({
        method: "get",
        path: "/v1/sync/jwks",
        tags: ["sync"],
        summary: "Public keys PowerSync uses to verify sync tokens",
        responses: {
          200: jsonBody(z.object({ keys: z.array(z.record(z.string(), z.unknown())) }), "JWKS"),
        },
      }),
      async (c) => c.json(await signer.jwks(), 200),
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/sync/token",
        tags: ["sync"],
        summary: "A short-lived token for the PowerSync service, scoped to tenant and assignments",
        description:
          "Claims: sub, tenant_id, location_ids, people_location_ids, care_location_ids, entries_location_ids and handover_location_ids with people_assigned, care_assigned, entries_assigned and handover_assigned (each stream family where its own read permissions reach: people.person.read with care.plan.read, care.plan.read (also the round's open tasks), care.note.read and care.handover.manage), entries_write_location_ids and entries_write_assigned (where the phone may record: care.note.write) with entries_write_person_ids (the people the member is assigned to, when entries_write_assigned, up to 100), offline_days (the offline window from the rate table, never from the device), shift_days (the UTC days of the member's own shifts and clock events, two back and eight ahead, for holders of scheduling.timesheet.self only, else empty), meds_location_ids and meds_assigned (where medicines.emar.administer reaches) with meds_recent_days (the UTC days of the administrations that sync, today and the 34 before; empty when it reaches no one) and meds_recent_blocks (the ten-day blocks of those days, at most eight, which both administrations streams filter on; empty when the reach is empty), and handover_shifts (where the handover family reaches: for each nation the organisation has homes in, the day and night shift start times in minutes after midnight, UK time, from the rate table, with `lead`, how many minutes before a shift ends the phone shows its own handover first (`handover.preview_lead_minutes`, left out when unreadable); a nation whose figures are missing, not whole minutes of a day or not day before night is left out, so the phone says it cannot tell which handover to expect, and the operator is told in the log; read by the phone only, never by a stream). The device the request names (x-harbour-device) is bound to the member; a device a manager revoked is refused with 403 device_revoked, which the device reads apart from an expired session (401) and the session codes. While the organisation has not switched Care mode on (`care.mobile_care_mode`, off by default, H-381) the token is refused with 403 care_mode_off.",
        security,
        responses: {
          200: jsonBody(SyncToken, "Token"),
          ...errorResponses,
          409: problem(
            "sync_scope_too_large: the member's access reaches more homes and people than a phone can hold offline under PowerSync's buckets per connection (ADR-0134); no token",
          ),
        },
      }),
      async (c) => {
        const access = await requirePermission(c, "people.person.read");
        const { config } = c.get("services");
        // A revoked device never gets another token (care.md section 6, Device integrity part 2).
        await refuseRevokedDevice(c.get("services"), access, "sync.token", c.get("requestId"));
        // No token while Care mode is off for the organisation (H-381).
        await refuseCareModeOff(c.get("services"), access);
        const claims = await withTenant(c, async (tx) => {
          const locations = await tx
            .select({ id: location.id, nation: location.nation })
            .from(location)
            .where(isNull(location.deletedAt));
          // Where the member works (`workLocationIds`: their roles in force now; ADR-0071 review
          // round 2), the same list as the location switcher in /v1/me.
          const allIds = locations.map((l) => l.id);
          const workIds = workLocationIds(
            await accessRowsOfMember(tx, access.tenantUserId),
            allIds,
            new Date(),
          );
          // Each family of streams syncs where its own read permission reaches, never where
          // another role reaches further (ADR-0071 review round 1, C-M1 and S-M1).
          // A family's assigned streams are left off where its whole-home streams already carry
          // every person the member is assigned to: the same rows twice would double the
          // buckets of the connection, which PowerSync caps (ADR-0134).
          const assignedHomes = await tx
            .select({ locationId: person.locationId, status: person.status })
            .from(personAssignment)
            .innerJoin(person, eq(person.id, personAssignment.personId))
            .where(
              and(
                eq(personAssignment.tenantUserId, access.tenantUserId),
                isNull(personAssignment.deletedAt),
              ),
            );
          const covered = (reach: { locationIds: string[]; assigned: boolean }) =>
            reach.assigned &&
            reach.locationIds.length > 0 &&
            assignedCovered(reach.locationIds, assignedHomes)
              ? { ...reach, assigned: false }
              : reach;
          const people = covered(familyReach(access.effective, "people", allIds));
          const careReach = familyReach(access.effective, "care", allIds);
          const care = covered(careReach);
          const entries = covered(familyReach(access.effective, "entries", allIds));
          const handovers = covered(familyReach(access.effective, "handover", allIds));
          const recording = familyReach(access.effective, "entries_write", allIds);
          const meds = covered(familyReach(access.effective, "meds", allIds));
          // The offline window comes from the rate table here, never from the device (care.md
          // section 6): the streams read it from this claim and ignore connection parameters.
          const rated = await rateNumber(tx, access.tenantId, OFFLINE_WINDOW_RATE_KEY).catch(
            () => null,
          );
          const windowDays = isValidWindowDays(rated) ? rated : FAIL_SAFE_WINDOW_DAYS;
          if (windowDays !== rated) {
            // Opaque ids only: the tenant and the rate key, never the user or the people.
            c.get("services").logger.warn(
              { tenantId: access.tenantId, rateKey: OFFLINE_WINDOW_RATE_KEY },
              "offline window rate missing or out of range; using the fail-safe window",
            );
          }
          const offlineDays = offlineWindowDays(new Date(), windowDays);
          // Buckets per connection (ADR-0134; HZ-002): a phone over PowerSync's limit gets no
          // fresh data at all.
          // People receiving care at these homes (the whole-home streams key a bucket per person).
          const livePeopleAt = async (homes: readonly string[]) => {
            if (homes.length === 0) return 0;
            const [row] = await tx
              .select({ n: sql<number>`count(*)::int` })
              .from(person)
              .where(
                and(
                  inArray(person.locationId, [...homes]),
                  inArray(person.status, ["active", "on_leave", "in_hospital"]),
                ),
              );
            return row?.n ?? 0;
          };
          const estimateFor = async () => {
            const n = await livePeopleAt([
              ...new Set([...people.locationIds, ...care.locationIds]),
            ]);
            // The medicines family's own reach, which may be wider than the care family's.
            const medsPeople = await livePeopleAt(meds.locationIds);
            const anyAssigned =
              people.assigned || care.assigned || entries.assigned || handovers.assigned;
            return estimateBuckets({
              days: offlineDays.length,
              blocks: offlineWindowBlocks(offlineDays).length,
              shiftDays: shiftWindowDays(new Date()).length,
              entriesHomes: entries.locationIds.length,
              careHomes: care.locationIds.length,
              handoverHomes: handovers.locationIds.length,
              wholePeople: n,
              assignedPeople: anyAssigned ? assignedHomes.length : 0,
              assignedHomes: new Set(assignedHomes.map((a) => a.locationId)).size,
              medsHomes: meds.locationIds.length,
              medsDays: medsRecentDays(new Date()).length,
              medsBlocks: offlineWindowBlocks(medsRecentDays(new Date())).length,
              medsAssignedPeople: meds.assigned ? assignedHomes.length : 0,
              medsPeople,
              locations: allIds.length,
            });
          };
          const estimate = await estimateFor();
          if (estimate > SYNC_BUCKET_LIMIT) {
            // PowerSync would refuse this phone's connection and leave it with nothing fresh, out
            // of sight: refuse the token instead, by name, so the phone shows a failed sync with a
            // retry (HZ-002, HZ-006). Narrowing to fewer homes, with a notice on the phone, is
            // H-1430. Opaque ids and counts only.
            c.get("services").logger.warn(
              { tenantId: access.tenantId, estimate, limit: SYNC_BUCKET_LIMIT },
              "sync token refused: the phone would pass the buckets per connection",
            );
            throw new SyncScopeTooLarge(estimate);
          }
          // Where handovers reach the phone, the shift pattern of each nation the organisation
          // has homes in (the rate table's two shifts, until rotas define them per location), so
          // the phone can work out, offline, which handover it should hold and say when it is not
          // compiled yet or not final (care.md section 6, screens gate (e); ADR-0074).
          const shiftPatterns =
            handovers.locationIds.length > 0 || handovers.assigned
              ? await shiftPatternsByNation(
                  tx,
                  access.tenantId,
                  locations.map((l) => l.nation),
                )
              : { patterns: {}, missing: [] };
          const handoverShifts = shiftPatterns.patterns;
          if (shiftPatterns.missing.length > 0) {
            // Phones at homes in these nations say they cannot tell which handover to expect until
            // the rate table is fixed: tell the operator (opaque ids and rate keys only).
            c.get("services").logger.warn(
              {
                tenantId: access.tenantId,
                nations: shiftPatterns.missing,
                rateKeys: [
                  HANDOVER_RATE_KEYS.dayShiftStartMinute,
                  HANDOVER_RATE_KEYS.nightShiftStartMinute,
                ],
              },
              "handover shift pattern missing or out of order; left out of the sync token",
            );
          }
          await auditInTx(tx, access, {
            action: "sync.token.issue",
            // The device the token is for, when it says; the binding itself is `device_binding`.
            ...(access.deviceId ? { resourceType: "device", resourceId: access.deviceId } : {}),
            scope: {
              peopleLocations: people.locationIds.length,
              careLocations: care.locationIds.length,
              entriesLocations: entries.locationIds.length,
              handoverLocations: handovers.locationIds.length,
              peopleAssigned: people.assigned,
              careAssigned: care.assigned,
              entriesAssigned: entries.assigned,
              handoverAssigned: handovers.assigned,
              medsLocations: meds.locationIds.length,
              medsAssigned: meds.assigned,
              offlineWindowDays: windowDays,
              bucketEstimate: estimate,
            },
            requestId: c.get("requestId"),
          });
          // The people the member is assigned to now (their own rows), named only when a role
          // scoped to assigned people carries care.note.write, so the phone decides per person
          // (review round 3, C3-M2); left out beyond MAX_WRITE_PERSON_IDS.
          const now = new Date();
          const assignedNow = recording.assigned
            ? await tx
                .selectDistinct({ personId: personAssignment.personId })
                .from(personAssignment)
                .where(
                  and(
                    eq(personAssignment.tenantUserId, access.tenantUserId),
                    isNull(personAssignment.deletedAt),
                    lte(personAssignment.validFrom, now),
                    or(isNull(personAssignment.validTo), gt(personAssignment.validTo, now)),
                  ),
                )
                .orderBy(personAssignment.personId)
                .limit(MAX_WRITE_PERSON_IDS + 1)
            : [];
          const writePersonIds =
            recording.assigned && assignedNow.length <= MAX_WRITE_PERSON_IDS
              ? assignedNow.map((a) => a.personId)
              : null;
          return {
            sub: access.tenantUserId,
            tenant_id: access.tenantId,
            location_ids: workIds,
            people_location_ids: people.locationIds,
            care_location_ids: care.locationIds,
            entries_location_ids: entries.locationIds,
            people_assigned: people.assigned,
            care_assigned: care.assigned,
            // Tasks about nobody given to the member, at any home: never left off by the cover
            // above, which only knows about people (security review of ADR-0134, M2).
            care_own_tasks: careReach.assigned,
            entries_assigned: entries.assigned,
            handover_location_ids: handovers.locationIds,
            handover_assigned: handovers.assigned,
            // The homes where the member's assigned people live: the handovers they may open
            // there sync per home and day (`app.handover_location_visible`; ADR-0134).
            handover_assigned_location_ids: handovers.assigned
              ? [
                  ...new Set(
                    assignedHomes
                      .map((a) => a.locationId)
                      .filter((l): l is string => typeof l === "string"),
                  ),
                ].sort()
              : [],
            entries_write_location_ids: recording.locationIds,
            entries_write_assigned: recording.assigned,
            ...(writePersonIds ? { entries_write_person_ids: writePersonIds } : {}),
            offline_days: offlineDays,
            offline_blocks: offlineWindowBlocks(offlineDays),
            handover_shifts: handoverShifts,
            // Medicines (slice 68): the people of the member's medicines.emar.administer scope, and
            // the days of the administrations they need, with their ten-day blocks, which the
            // streams filter on, at the member's homes and for their assigned people alike;
            // none when it reaches no one (rebuild review, B1).
            meds_location_ids: meds.locationIds,
            meds_assigned: meds.assigned,
            meds_recent_days:
              meds.assigned || meds.locationIds.length > 0 ? medsRecentDays(new Date()) : [],
            meds_recent_blocks:
              meds.assigned || meds.locationIds.length > 0
                ? offlineWindowBlocks(medsRecentDays(new Date()))
                : [],
            // The member's own shifts and clock events (scheduling.md section 18): only for those
            // who clock their own time; empty otherwise, so no shift syncs (fails closed).
            shift_days:
              scopeFor(access.effective, "scheduling.timesheet.self").scope === "none"
                ? []
                : shiftWindowDays(new Date()),
          };
        }).catch(async (error: unknown) => {
          if (!(error instanceof SyncScopeTooLarge)) throw error;
          // Audited in its own transaction (the token's was rolled back), with counts only, so a
          // manager can see whose phone was refused (clinical review of the slice 68 rebuild, M2).
          await withTenant(c, (tx) =>
            auditInTx(tx, access, {
              action: "sync.token.refused",
              ...(access.deviceId ? { resourceType: "device", resourceId: access.deviceId } : {}),
              scope: {
                reason: "sync_scope_too_large",
                estimate: error.estimate,
                limit: SYNC_BUCKET_LIMIT,
              },
              requestId: c.get("requestId"),
            }),
          );
          throw new HttpProblem(
            409,
            "sync_scope_too_large",
            "This phone cannot sync.",
            "You can see more homes and people than a phone can keep. Before giving medicines, check the paper MAR or ask the nurse in charge. Use the web app, or ask your manager to reduce the homes and people you can see.",
          );
        });
        // The member has used this device (care.md section 6, Device integrity part 1): written in
        // the system's view, so a hold report naming them as its owner counts.
        const deviceId = access.deviceId;
        if (deviceId) {
          await inSystemView(c.get("services").db, access, (tx) =>
            bindDevice(tx, deviceId, access.tenantUserId, new Date(), access.session.sessionId),
          );
        }
        // A bank or agency member's token ends with their access window (ADR-0088).
        const notAfter = await withTenant(c, (tx) =>
          agencyWindowEnd(tx, access.tenantId, access.tenantUserId),
        );
        const { token, expiresAt } = await signer.sign(claims, new Date(), notAfter);
        return c.json(
          { token, endpoint: config.POWERSYNC_URL, expiresAt: expiresAt.toISOString() },
          200,
        );
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/sync/upload",
        tags: ["sync"],
        summary: "Apply a batch of offline changes from a device",
        security,
        request: { body: { content: { "application/json": { schema: SyncUpload } } } },
        responses: {
          200: jsonBody(SyncUploadResult, "Applied and rejected operations"),
          ...errorResponses,
        },
      }),
      async (c) => {
        const access = c.get("access");
        await refuseRevokedDevice(c.get("services"), access, "sync.upload", c.get("requestId"));
        await refuseCareModeOff(c.get("services"), access);
        const { operations } = c.req.valid("json");
        const receivedAt = new Date();
        const drift = operations.some(
          (op) =>
            op.deviceSentAt !== undefined && hasClockDrift(new Date(op.deviceSentAt), receivedAt),
        );
        const rejected: { id: string; code: string; message: string }[] = [];
        let lateAfterAccess = 0;
        await withTenant(c, async (tx) => {
          // H-921: a bank or agency worker's entries only from inside a booked window; after it
          // closes, still accepted, flagged late, for the upload grace period (HZ-006).
          const check = await agencyUploadCheck(
            tx,
            access.tenantId,
            access.tenantUserId,
            receivedAt,
          );
          for (const op of operations) {
            if (check) {
              const at = op.recordedAt ?? op.deviceSentAt;
              const decision = check(at ? new Date(at) : null);
              if (!decision.accept) {
                rejected.push({
                  id: op.id,
                  code: decision.reason,
                  message:
                    decision.reason === "outside_booking"
                      ? "This was recorded outside any shift you were booked for."
                      : "This was recorded on a booked shift, but the time to upload it has passed. Tell the person in charge.",
                });
                continue;
              }
              if (decision.late) lateAfterAccess++;
            }
            if (!WRITABLE_TABLES.has(op.table)) {
              rejected.push({
                id: op.id,
                code: "table_not_writable",
                message: "This kind of record cannot be changed from a device yet.",
              });
            }
          }
          await auditInTx(tx, access, {
            action: "sync.upload",
            outcome: rejected.length > 0 ? "denied" : "success",
            scope: {
              operations: operations.length,
              rejected: rejected.length,
              clockDrift: drift,
              lateAfterAccess,
            },
            requestId: c.get("requestId"),
          });
        });
        return c.json({ applied: operations.length - rejected.length, rejected }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/sync/discards",
        tags: ["sync"],
        summary: "Record that a device deleted entries that never reached the server",
        description:
          "Writes an append-only audit event for one stage of a deletion (requested, deleted or failed): who deleted them, whose they were, the coded reason, how many and from which device (HZ-040). Anyone but the caller's own entries, deleted by the caller, needs a manager's permission. Each stage of an id is recorded once, and later stages must match the first (kind and owner) and come from its sender, the owner or a manager. Each person starts at most 20 deletion records a day. A deletion recorded as deleted closes the hold tasks of the device it names (or the sender's) when the sender owns the hold, raised its task or can act on it there, and listed entries already on the server are counted on one review task for the record.",
        security,
        request: { body: { content: { "application/json": { schema: SyncDiscard } } } },
        responses: { 200: jsonBody(SyncDiscardResult, "Recorded"), ...errorResponses },
      }),
      async (c) => {
        let access = await requirePermission(c, "care.note.write");
        await withTenant(c, (tx) => discardQuota.take(tx, access.tenantUserId));
        const body = c.req.valid("json");
        // Who deleted, as the device recorded it; unknown stays unknown in the record (security
        // review round 5, S-L2). For the permission decision only, an unknown deleter is the caller.
        const recordedDeleter = body.deletedByTenantUserId ?? null;
        const deleter = recordedDeleter ?? access.tenantUserId;
        // Anyone's but the caller's own entries, deleted by the caller, need a manager: an unknown
        // owner, another member of staff's entries, or a deletion the device says someone else made
        // (security review round 4, M1). Registered Managers, deputies and nurses hold it.
        let asManager = false;
        if (
          !body.ownerTenantUserId ||
          body.ownerTenantUserId !== access.tenantUserId ||
          deleter !== access.tenantUserId
        ) {
          access = await requirePermission(c, DISCARD_OTHERS_PERMISSION);
          asManager = true;
        }
        const owner = body.ownerTenantUserId?.toLowerCase() ?? null;
        // A later stage from someone other than the first stage's sender or the owner needs a
        // manager too. Decided before the deletion's transaction opens, so that transaction runs
        // in the narrowed scope from its start and its audit carries it (ADR-0071 review round 1,
        // L3); a first stage that appears in between is refused as a conflict below.
        const needsManager = (first: { senderTenantUserId: string | null } | undefined) =>
          first !== undefined &&
          first.senderTenantUserId !== access.tenantUserId &&
          owner !== access.tenantUserId;
        if (!asManager) {
          const [first] = await withTenant(c, (tx) =>
            withTenantWideScope(tx, () =>
              tx
                .select({ senderTenantUserId: deviceDiscardRecord.senderTenantUserId })
                .from(deviceDiscardRecord)
                .where(eq(deviceDiscardRecord.discardId, body.id))
                .orderBy(asc(deviceDiscardRecord.recordedAt), asc(deviceDiscardRecord.id))
                .limit(1),
            ),
          );
          if (needsManager(first)) {
            access = await requirePermission(c, DISCARD_OTHERS_PERMISSION);
            asManager = true;
          }
        }
        const action = DISCARD_ACTIONS[body.stage];
        // The code the record carries: one the organisation added, or one of the five.
        const reasonCode = body.organisationReasonCode ?? body.reasonCode;
        const { replay } = await withTenant(c, async (tx) => {
          // The owner and the deleter must be staff of this organisation (row-level security keeps
          // the lookup inside the tenant).
          const staffIds = [
            ...new Set([body.ownerTenantUserId, recordedDeleter].filter((v) => v !== null)),
          ];
          if (staffIds.length > 0) {
            const staff = await tx
              .select({ id: tenantUser.id })
              .from(tenantUser)
              .where(inArray(tenantUser.id, staffIds));
            if (staff.length !== staffIds.length) {
              throw problems.invalid("The member of staff is not in this organisation.");
            }
          }
          // One of the organisation's coded reasons (care.md section 6, Device integrity part 8): a
          // code it never had is refused; a retired one is still taken, because the device may
          // have recorded the deletion before it was retired, and a deletion is never stranded.
          const [reason] = await tx
            .select({ id: discardReason.id, code: discardReason.code })
            .from(discardReason)
            .where(eq(discardReason.code, reasonCode));
          if (!reason) {
            throw problems.invalid(
              "That reason is not one of your organisation's coded reasons for deleting entries.",
            );
          }
          // The stages of one deletion are taken in turn. What stops a second record of a stage,
          // however two requests race, is the unique index on (deletion, stage) of
          // device_discard_record (the discard replay index); the stages are read in the system's
          // view, so the guard sees every stage whoever sent it.
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext(${`device_discard:${body.id}`}))`,
          );
          const recorded = await withTenantWideScope(tx, () =>
            tx
              .select()
              .from(deviceDiscardRecord)
              .where(eq(deviceDiscardRecord.discardId, body.id))
              .orderBy(asc(deviceDiscardRecord.recordedAt), asc(deviceDiscardRecord.id)),
          );
          // A later stage belongs to the deletion it continues (security review round 5, S-L1):
          // the same kind and owner, from the same sender, the owner, or a manager.
          const [earliest] = recorded;
          if (earliest) {
            if (earliest.kind !== body.kind || earliest.ownerTenantUserId !== owner) {
              throw problems.invalid("This deletion was recorded for other entries.");
            }
            // A first stage recorded since the check above: the device sends again.
            if (needsManager(earliest) && !asManager) {
              throw problems.conflict(
                "Another stage of this deletion arrived first; send it again.",
              );
            }
          }
          if (recorded.some((r) => r.stage === body.stage)) return { replay: true };
          // A new deletion counts against the sender's day: one record, and its entry ids (S-M2;
          // security review round 6, M2 remainder).
          if (!earliest) {
            await discardRecordsQuota.check(tx, access.tenantUserId);
            await discardIdsQuota.take(tx, access.tenantUserId, body.entryIds.length);
            await discardRecordsQuota.take(tx, access.tenantUserId);
          }
          const written = await withTenantWideScope(tx, () =>
            tx
              .insert(deviceDiscardRecord)
              .values({
                discardId: body.id,
                stage: body.stage,
                kind: body.kind,
                reasonCode,
                ownerTenantUserId: owner,
                deletedByTenantUserId: recordedDeleter,
                senderTenantUserId: access.tenantUserId,
                deviceId: (body.deviceId ?? access.deviceId)?.toLowerCase() ?? null,
                entryCount: body.count,
                discardedAt: new Date(body.discardedAt),
              })
              .onConflictDoNothing()
              .returning({ id: deviceDiscardRecord.id }),
          );
          if (written.length === 0) return { replay: true };
          // A failure supersedes the request it follows (clinical review round 4, H1).
          const [requested] =
            body.stage === "failed" && recorded.some((r) => r.stage === "requested")
              ? await tx
                  .select({ id: auditEvent.id })
                  .from(auditEvent)
                  .where(
                    and(
                      eq(auditEvent.resourceType, "device_discard"),
                      eq(auditEvent.resourceId, body.id),
                      eq(auditEvent.action, DISCARD_ACTIONS.requested),
                    ),
                  )
                  .orderBy(asc(auditEvent.seq))
                  .limit(1)
              : [];
          await auditInTx(tx, access, {
            action,
            resourceType: "device_discard",
            resourceId: body.id,
            // The coded reason only: the person's words never enter the hash-chained trail (M3).
            // One of the five is audited by its code; a code the organisation wrote is audited as
            // "other" with the reason's id, so no name it might contain enters the trail (#26
            // review round 2, low). The deletion record keeps the code.
            reason: body.organisationReasonCode ? "other" : reasonCode,
            scope: {
              kind: body.kind,
              stage: body.stage,
              reasonCode: body.organisationReasonCode ? "other" : reasonCode,
              ...(body.organisationReasonCode ? { organisationReasonId: reason.id } : {}),
              ownerTenantUserId: body.ownerTenantUserId,
              // As the device recorded it; the event's actor is whoever sent this request.
              deletedByTenantUserId: recordedDeleter,
              entryIds: body.entryIds,
              personIds: body.personIds,
              count: body.count,
              discardedAt: body.discardedAt,
              ...(body.idsMissing ? { idsMissing: body.idsMissing } : {}),
              // The device the entries were held on, when it differs from the sender's now.
              ...(body.deviceId ? { heldOnDeviceId: body.deviceId } : {}),
              ...(body.stage === "failed" && requested
                ? { supersedesAuditEventId: requested.id }
                : {}),
            },
            requestId: c.get("requestId"),
          });
          // The entry ids this stage lists, one row each, so an upload finds its deletion by an
          // index (care.md section 6, Device integrity part 3; the HZ-040 go-live blocker).
          if (body.entryIds.length > 0) {
            await tx
              .insert(deviceDiscardEntry)
              .values(
                [...new Set(body.entryIds.map((id) => id.toLowerCase()))].map((entryId) => ({
                  discardId: body.id,
                  stage: body.stage,
                  entryId,
                  ownerTenantUserId: body.ownerTenantUserId,
                })),
              )
              .onConflictDoNothing();
          }
          // Part of the database left on the device after its entries became unreadable is a
          // security event of its own (clinical review round 5, C-M1).
          if (body.stage === "deleted" && body.leftover && body.leftover.length > 0) {
            await auditInTx(tx, access, {
              action: "sync.device.residue",
              resourceType: "device_discard",
              resourceId: body.id,
              scope: { leftover: body.leftover },
              requestId: c.get("requestId"),
            });
          }
          return { replay: false };
        });
        if (!replay) {
          const services = c.get("services");
          const requestId = c.get("requestId");
          // The device's hold is gone: its tasks close (clinical review round 5, C-M3), found by
          // the device the deletion names, since a stage sent later comes from the device's next
          // database (clinical review round 6, M1).
          if (body.stage === "deleted" && WHOLE_HOLD_KINDS.has(body.kind)) {
            await closeDeviceHoldOnDeletion(
              services.db,
              access,
              body.deviceId ?? access.deviceId,
              new Date(),
              requestId,
            );
          }
          // Listed entries the server already had are flagged once the deletion is done (C-L2;
          // security review round 6, N1).
          if (body.stage === "deleted") {
            await flagEntriesAlreadyUploaded(services.db, access, body, requestId);
          }
        }
        return c.json({ id: body.id, recorded: true, replay }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/sync/key-lost",
        tags: ["sync"],
        summary:
          "Record that a device's key stopped opening its database and its unsent entries were lost",
        description:
          "Nobody chose this loss (H-1531, HZ-006), so it carries no reason, no deleter and no ids. The server writes the deletion record (kind key_invalidated, cause device_key_lost), its audit event and an urgent review task for the holders of safety.incident.manage where the owner worked, in one transaction. Any member of the staff may send it (with MFA when their roles call for it; never a family portal session), up to 3 a day. The owner counts only when an active member and the sender or bound to the device; the device only when the sender or that owner is bound to it; otherwise each is audited as a claim. The count is the higher of the device's and the device's last report. Its sender's replay raises the review if it is missing; the old device's open hold tasks are linked to it and left open. The staff route POST /v1/sync/discards never takes this kind.",
        security,
        request: { body: { content: { "application/json": { schema: SyncKeyLost } } } },
        responses: { 200: jsonBody(SyncDiscardResult, "Recorded"), ...errorResponses },
      }),
      async (c) => {
        const access = c.get("access");
        // Staff only: a family portal session never records a device's loss (security re-review
        // L-a).
        if (access.context.family) throw problems.forbidden();
        if (!access.mfaSatisfied) throw mfaRefusal(access);
        const body = c.req.valid("json");
        const result = await recordKeyLost(
          c.get("services").db,
          access,
          body,
          new Date(),
          c.get("requestId"),
        );
        if (result.outcome === "other_deletion") {
          throw problems.invalid("This deletion was recorded for other entries.");
        }
        return c.json({ id: body.id, recorded: true, replay: result.outcome === "replay" }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/sync/device-report",
        tags: ["sync"],
        summary: "A device's unsent work: counts and the oldest age, no personal data",
        description:
          "Writes an audit event with the device's queued, refused, held and blocked counts and the age of the oldest, so the server knows what a lost or wiped device held (HZ-006). Any member of the organisation may report (with MFA when their roles call for it), so a device whose Care mode access was withdrawn can still report its hold. A named owner counts only when bound to the device (a sync token issued to it or a report sent from it, kept as a device binding); otherwise the claim is recorded and changes nothing. Times later than the server's are taken as the server's, and a hold's start is never earlier than the device's last report for it said, nor than the server first saw the device. While anything waits, the device has a task for the Registered Manager at each location of its sync scope where the hold's owner or the reporter works, due when its hold escalates and never moved later; one closed in the last day is reopened, its escalation reset at most once a day. A report with nothing waiting closes them when it comes from the hold's owner, from whoever raised them or from a manager at one of their locations. Each reporter raises tasks for a few devices a day; past that, their holds join one task for that reporter, due at the earliest of them.",
        security,
        request: { body: { content: { "application/json": { schema: SyncDeviceReport } } } },
        responses: { 204: { description: "Recorded" }, ...errorResponses },
      }),
      async (c) => {
        // Any member of the organisation may report what their device holds: counts and times, no
        // personal data. A hold often starts because the access Care mode needs was withdrawn, and
        // its report must still get through at once (clinical review round 4, H2). What a member
        // can do with it is bounded (security reviews rounds 5 to 7): raise a task for a few
        // devices a day, bring a due time earlier, and close only a task for a hold they own or
        // raised, unless they can act on it at its location; naming an owner who has never used the
        // device changes nothing. MFA is asked wherever the member's roles call for it, as on the
        // care routes.
        const access = c.get("access");
        if (!access.mfaSatisfied) throw mfaRefusal(access);
        await withTenant(c, (tx) => reportQuota.take(tx, access.tenantUserId));
        const report = c.req.valid("json");
        const receivedAt = new Date();
        // The hold's owner must be staff of this organisation (row-level security keeps the lookup
        // inside the tenant): they may close the task (clinical review round 6, M1).
        const owner = report.ownerTenantUserId ?? null;
        if (owner && owner !== access.tenantUserId) {
          const [member] = await withTenant(c, (tx) =>
            tx.select({ id: tenantUser.id }).from(tenantUser).where(eq(tenantUser.id, owner)),
          );
          if (!member) throw problems.invalid("The member of staff is not in this organisation.");
        }
        // The audit event and the Registered Manager's task for this device (clinical review
        // round 4, H2).
        await recordDeviceHold(
          c.get("services").db,
          access,
          access.deviceId,
          report,
          receivedAt,
          c.get("requestId"),
        );
        return c.body(null, 204);
      },
    );
}
