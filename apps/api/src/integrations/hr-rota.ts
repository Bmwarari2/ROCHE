import { createHash, randomUUID } from "node:crypto";
import {
  absence,
  auditEvent,
  clockEvent,
  HR_LINK_PORT,
  hrDelivery,
  hrLocationLink,
  hrPersonLink,
  hrSyncState,
  integrationConnection,
  shift,
  shiftAssignment,
  staffProfile,
  type Transaction,
} from "@harbour/db";
import {
  applyHrAbsencePlan,
  type HrAbsenceCopy,
  type HrAbsencePort,
  type HrResult,
  hrClockEventOf,
  hrShiftOf,
  inboundAbsence,
  planHrAbsence,
  type ThapsusHrPort,
} from "@harbour/domain";
import { and, eq, gte, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { raiseCoverNeeds, resolveCoverNeeds } from "../services/absence";
import { HR_ACTOR, raiseHrAlert, recordSync } from "./hr-link";

/**
 * The Thapsus-HR link's rota, clocking and absence flows (integrations.md section 11.2; slice 88;
 * INTG-014, SCHED-002, SCHED-004, SCHED-010; HZ-123, HZ-124, HZ-133). Runs in the organisation's
 * own system context. Harbour keeps the rota (ADR-0126): shifts and clock events only go out, as
 * the allow-listed fields (rule 4); absences only come in, as read-only copies through the absence
 * port (dates and type only; rule 10), and raise cover needs on rostered shifts. Nothing goes for,
 * or comes from, a person whose match is not confirmed (rule 3).
 */

const MAX_PAGES = 1_000;
const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const CANCELLED = sha256("cancelled");

async function audit(
  tx: Transaction,
  tenantId: string,
  action: string,
  resourceType: string,
  resourceId: string,
  scope: Record<string, unknown> = {},
  outcome: "success" | "denied" | "error" = "success",
) {
  await tx.insert(auditEvent).values({
    tenantId,
    actorAuthUserId: HR_ACTOR,
    actorRoleKeys: ["integration"],
    action,
    outcome,
    resourceType,
    resourceId,
    scope,
  });
}

/** The absence port over `absence` (source `thapsus_hr`), in the sync's system context. */
function absencePort(tx: Transaction, locationId: string): HrAbsencePort {
  return {
    async find(hrId) {
      const [row] = await tx
        .select()
        .from(absence)
        .where(
          and(
            eq(absence.hrId, hrId),
            eq(absence.source, "thapsus_hr"),
            ne(absence.state, "cancelled"),
          ),
        );
      return row
        ? ({
            id: row.id,
            kind: row.kind as HrAbsenceCopy["kind"],
            startsOn: row.startsOn,
            endsOn: row.endsOn,
            cancelled: false,
          } satisfies HrAbsenceCopy)
        : null;
    },
    async create(hrId, memberId, copy) {
      const [row] = await tx
        .insert(absence)
        .values({
          memberId,
          locationId,
          kind: copy.kind,
          startsOn: copy.startsOn,
          endsOn: copy.endsOn,
          state: "recorded",
          source: "thapsus_hr",
          hrId,
          createdBy: null,
          updatedBy: null,
        })
        .returning({ id: absence.id });
      return row?.id ?? "";
    },
    async setEnd(id, endsOn) {
      await tx.update(absence).set({ endsOn, updatedBy: null }).where(eq(absence.id, id));
    },
    async cancel(id) {
      await tx
        .update(absence)
        .set({ state: "cancelled", updatedBy: null })
        .where(eq(absence.id, id));
    },
  };
}

/** Linked employees: Thapsus-HR's id to the member and their home (rule 3: confirmed only). */
async function linkedMembers(tx: Transaction) {
  const rows = await tx
    .select({
      hrEmployeeId: hrPersonLink.hrEmployeeId,
      staffProfileId: staffProfile.id,
      memberId: staffProfile.tenantUserId,
      locationId: staffProfile.locationId,
    })
    .from(hrPersonLink)
    .innerJoin(
      staffProfile,
      and(
        eq(staffProfile.tenantId, hrPersonLink.tenantId),
        eq(staffProfile.id, hrPersonLink.staffProfileId),
      ),
    )
    .where(and(eq(hrPersonLink.state, "linked"), isNull(hrPersonLink.deletedAt)));
  return rows;
}

export interface AbsenceOutcome {
  readonly copied: number;
  readonly changed: number;
  readonly cancelled: number;
  readonly coverNeeds: number;
  readonly failed: number;
  readonly error: string | null;
}

/**
 * Leave and sickness from Thapsus-HR (rule 10; HZ-123, HZ-133): every page read; each absence of
 * a linked member applied in its own savepoint through the absence port; cover needs raised on
 * their rostered shifts and resolved when an absence is cut short or cancelled; and, once every
 * page is read, a copy Thapsus-HR no longer lists is cancelled (drift). A failure never moves the
 * last good sync; absences already copied still block rostering (rule 9).
 */
export async function pullAbsences(
  tx: Transaction,
  tenantId: string,
  port: ThapsusHrPort,
  now: Date,
): Promise<AbsenceOutcome> {
  const out = { copied: 0, changed: 0, cancelled: 0, coverNeeds: 0, failed: 0 };
  const members = new Map((await linkedMembers(tx)).map((m) => [m.hrEmployeeId, m]));
  const seen = new Set<string>();
  let cursor: string | null = null;
  const cursors = new Set<string>();
  let complete = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await port.absences(cursor);
    if (!result.ok) {
      await recordSync(tx, "absences", now, result.error);
      return { ...out, error: result.error };
    }
    for (const raw of result.value.items) {
      const incoming = inboundAbsence(raw);
      if (!incoming) {
        out.failed += 1;
        continue;
      }
      seen.add(incoming.id);
      const member = members.get(incoming.employeeId);
      if (!member) continue;
      if (!member.locationId) {
        await raiseHrAlert(tx, "absence_unplaced", "staff_profile", member.staffProfileId, now);
        continue;
      }
      try {
        await tx.transaction(async (sp) => {
          const absences = absencePort(sp, member.locationId as string);
          const known = await absences.find(incoming.id);
          const plan = planHrAbsence(known, incoming);
          const made = await applyHrAbsencePlan(
            absences,
            known,
            incoming.id,
            member.memberId,
            plan,
          );
          if (plan.action === "none") return;
          if (known && plan.action !== "set_end") {
            out.cancelled += 1;
            await resolveCoverNeeds(sp, { absenceId: known.id }, "absence_ended");
          }
          if (known && plan.action === "set_end") {
            out.changed += 1;
            if (plan.endsOn !== null) {
              await resolveCoverNeeds(sp, { absenceId: known.id }, "absence_ended", plan.endsOn);
            }
          }
          const current = made ?? (plan.action === "set_end" ? (known?.id ?? null) : null);
          if (made) out.copied += 1;
          if (current) {
            const [row] = await sp.select().from(absence).where(eq(absence.id, current));
            if (row) out.coverNeeds += await raiseCoverNeeds(sp, row, "hr_link");
            await audit(sp, tenantId, "integrations.hr_link.absence_copied", "absence", current, {
              action: plan.action,
            });
          }
        });
      } catch {
        out.failed += 1;
      }
    }
    cursor = result.value.nextCursor;
    if (cursor === null) {
      complete = true;
      break;
    }
    if (cursors.has(cursor)) break;
    cursors.add(cursor);
  }
  if (!complete) {
    await recordSync(tx, "absences", now, "incomplete");
    return { ...out, error: "incomplete" };
  }
  // Drift (HZ-133): a copy whose absence Thapsus-HR no longer lists stops blocking the rota.
  const copies = await tx
    .select({ id: absence.id, hrId: absence.hrId })
    .from(absence)
    .where(and(eq(absence.source, "thapsus_hr"), ne(absence.state, "cancelled")));
  for (const c of copies) {
    if (c.hrId && seen.has(c.hrId)) continue;
    await tx
      .update(absence)
      .set({ state: "cancelled", updatedBy: null })
      .where(eq(absence.id, c.id));
    await resolveCoverNeeds(tx, { absenceId: c.id }, "absence_ended");
    await audit(tx, tenantId, "integrations.hr_link.absence_removed", "absence", c.id);
    out.cancelled += 1;
  }
  await recordSync(tx, "absences", now, null);
  if (out.failed > 0) {
    // Read in full, but some absences were not applied: the status says so (rule 9).
    await tx
      .update(hrSyncState)
      .set({ lastErrorCode: "record_failed" })
      .where(eq(hrSyncState.kind, "absences"));
  }
  return { ...out, error: null };
}

export interface DeliveryOutcome {
  readonly sent: number;
  readonly cancelled: number;
  readonly refused: number;
  readonly failed: number;
  readonly error: string | null;
}

/**
 * One delivery, once (rule 5): the ledger row for this record is created or reused; a payload
 * already sent is never sent again; a changed one goes with a new idempotency key; a failure keeps
 * the key so the retry is the same request. Thapsus-HR's refusal (an overlapping shift, say; rule
 * 14) is a delivery error raised for the rota manager, never retried as is.
 */
async function deliver(
  tx: Transaction,
  tenantId: string,
  kind: "shift" | "clock_event",
  harbourRef: string,
  digest: string,
  now: Date,
  send: (key: string) => Promise<HrResult<{ readonly id: string }>>,
): Promise<"sent" | "skipped" | "refused" | "failed" | "rate_limited"> {
  const [known] = await tx
    .select()
    .from(hrDelivery)
    .where(and(eq(hrDelivery.kind, kind), eq(hrDelivery.harbourRef, harbourRef)));
  if (known && known.payloadSha256 === digest && known.state !== "failed") return "skipped";
  const key =
    known && known.payloadSha256 === digest ? known.idempotencyKey : (randomUUID() as string);
  const result = await send(key);
  const values = result.ok
    ? {
        state: "sent",
        hrId: result.value.id,
        sentAt: now,
        lastErrorCode: null,
        nextAttemptAt: null,
      }
    : {
        state: result.error === "refused" || result.error === "conflict" ? "refused" : "failed",
        lastErrorCode: result.error,
        nextAttemptAt: null,
        ...(known?.state === "sent" ? {} : { hrId: null, sentAt: null }),
      };
  // A failed change after a good send keeps the record of the good one (state stays sent).
  const keepSent = !result.ok && known?.state === "sent";
  if (known) {
    await tx
      .update(hrDelivery)
      .set({
        ...(keepSent ? { lastErrorCode: values.lastErrorCode } : values),
        idempotencyKey: key,
        payloadSha256: result.ok ? digest : known.payloadSha256,
        attempts: known.attempts + 1,
        updatedBy: null,
      })
      .where(eq(hrDelivery.id, known.id));
  } else {
    await tx.insert(hrDelivery).values({
      kind,
      harbourRef,
      idempotencyKey: key,
      payloadSha256: result.ok ? digest : null,
      attempts: 1,
      ...values,
      createdBy: null,
      updatedBy: null,
    });
  }
  if (result.ok) return "sent";
  if (result.error === "rate_limited") return "rate_limited";
  if (result.error === "refused" || result.error === "conflict") {
    if (await raiseHrAlert(tx, "delivery_refused", kind, harbourRef, now)) {
      await audit(
        tx,
        tenantId,
        "integrations.hr_link.delivery",
        kind,
        harbourRef,
        {
          code: result.error,
        },
        "error",
      );
    }
    return "refused";
  }
  return "failed";
}

/**
 * Shifts and clock events out (section 11.2; rules 3, 4, 5, 7 and 14). A published shift's
 * assignment goes as a shift, again whenever it changes, and is cancelled when the assignment is
 * removed or the shift cancelled. Clock events in and out recorded since the link was connected
 * (at most a week back) go once each. Only for members whose match is confirmed and homes that
 * are mapped. Stops at a rate limit and carries on next run (rule 6).
 */
export async function deliverRota(
  tx: Transaction,
  tenantId: string,
  port: ThapsusHrPort,
  now: Date,
): Promise<DeliveryOutcome> {
  const out = { sent: 0, cancelled: 0, refused: 0, failed: 0 };
  const [connection] = await tx
    .select({ createdAt: integrationConnection.createdAt })
    .from(integrationConnection)
    .where(eq(integrationConnection.port, HR_LINK_PORT));
  if (!connection) return { ...out, error: null };
  const places = new Map(
    (
      await tx
        .select({ locationId: hrLocationLink.locationId, hrId: hrLocationLink.hrLocationId })
        .from(hrLocationLink)
        .where(isNull(hrLocationLink.deletedAt))
    ).map((p) => [p.locationId, p.hrId]),
  );
  const people = new Map((await linkedMembers(tx)).map((m) => [m.memberId, m.hrEmployeeId]));
  const mappedPlaces = [...places.keys()];
  if (mappedPlaces.length === 0) return { ...out, error: null };
  /** Counts one outcome; true when Thapsus-HR's rate limit says to stop for now. */
  const count = (r: Awaited<ReturnType<typeof deliver>>, cancelling = false) => {
    if (r === "sent" && cancelling) out.cancelled += 1;
    else if (r === "sent") out.sent += 1;
    else if (r === "refused") out.refused += 1;
    else if (r === "failed") out.failed += 1;
    return r === "rate_limited";
  };
  const since = new Date(now.getTime() - 86_400_000);
  const assignments = await tx
    .select({
      id: shiftAssignment.id,
      workerId: shiftAssignment.workerId,
      locationId: shiftAssignment.locationId,
      removed: shiftAssignment.deletedAt,
      kind: shift.kind,
      startsAt: shift.startsAt,
      endsAt: shift.endsAt,
      breakMinutes: shift.breakMinutes,
      publishedAt: shift.publishedAt,
      shiftDeleted: shift.deletedAt,
      cancelReason: shift.cancelReason,
    })
    .from(shiftAssignment)
    .innerJoin(
      shift,
      and(eq(shift.tenantId, shiftAssignment.tenantId), eq(shift.id, shiftAssignment.shiftId)),
    )
    .where(
      and(
        inArray(shiftAssignment.locationId, mappedPlaces),
        isNotNull(shift.publishedAt),
        gte(shift.endsAt, since),
      ),
    );
  for (const a of assignments) {
    const hrEmployeeId = people.get(a.workerId);
    const hrLocationId = places.get(a.locationId);
    if (!hrEmployeeId || !hrLocationId) continue;
    const live = a.removed === null && a.shiftDeleted === null && a.cancelReason === null;
    if (live) {
      const payload = hrShiftOf({
        assignmentId: a.id,
        hrEmployeeId,
        hrLocationId,
        kind: a.kind,
        startsAt: a.startsAt,
        endsAt: a.endsAt,
        breakMinutes: a.breakMinutes,
      });
      const r = await deliver(tx, tenantId, "shift", a.id, sha256(payload), now, (key) =>
        port.upsertShift(payload, key),
      );
      if (count(r)) return { ...out, error: "rate_limited" };
    } else {
      const [sent] = await tx
        .select({ state: hrDelivery.state, digest: hrDelivery.payloadSha256 })
        .from(hrDelivery)
        .where(and(eq(hrDelivery.kind, "shift"), eq(hrDelivery.harbourRef, a.id)));
      if (!sent || sent.state !== "sent" || sent.digest === CANCELLED) continue;
      const r = await deliver(tx, tenantId, "shift", a.id, CANCELLED, now, (key) =>
        port.cancelShift(a.id, key),
      );
      if (count(r, true)) return { ...out, error: "rate_limited" };
    }
  }
  const from = new Date(Math.max(connection.createdAt.getTime(), now.getTime() - 7 * 86_400_000));
  const clocks = await tx
    .select({
      id: clockEvent.id,
      workerId: clockEvent.workerId,
      locationId: clockEvent.locationId,
      kind: clockEvent.kind,
      at: clockEvent.deviceTime,
    })
    .from(clockEvent)
    .where(
      and(
        inArray(clockEvent.locationId, mappedPlaces),
        inArray(clockEvent.kind, ["in", "out"]),
        gte(clockEvent.recordedAt, from),
      ),
    );
  for (const e of clocks) {
    const hrEmployeeId = people.get(e.workerId);
    const hrLocationId = places.get(e.locationId);
    if (!hrEmployeeId || !hrLocationId) continue;
    const payload = hrClockEventOf({
      id: e.id,
      hrEmployeeId,
      hrLocationId,
      kind: e.kind,
      at: e.at,
    });
    if (!payload) continue;
    const r = await deliver(tx, tenantId, "clock_event", e.id, sha256(payload), now, (key) =>
      port.postClockEvent(payload, key),
    );
    if (count(r)) return { ...out, error: "rate_limited" };
  }
  return { ...out, error: null };
}

/**
 * Absences in, then shifts and clock events out, each in a savepoint: anything unexpected is
 * recorded as a failed absence sync (so the rota says why its data is old; rule 9) and never
 * rolls back the rest.
 */
export async function syncRotaSafely(
  tx: Transaction,
  tenantId: string,
  port: ThapsusHrPort,
  now: Date,
): Promise<{
  readonly absences: AbsenceOutcome | null;
  readonly deliveries: DeliveryOutcome | null;
}> {
  let absences: AbsenceOutcome | null = null;
  let deliveries: DeliveryOutcome | null = null;
  try {
    absences = await tx.transaction((sp) => pullAbsences(sp, tenantId, port, now));
  } catch {
    await recordSync(tx, "absences", now, "internal");
  }
  try {
    deliveries = await tx.transaction((sp) => deliverRota(sp, tenantId, port, now));
  } catch {
    await audit(
      tx,
      tenantId,
      "integrations.hr_link.delivery",
      "integration_connection",
      HR_LINK_PORT,
      { code: "internal" },
      "error",
    );
  }
  return { absences, deliveries };
}
