import { createHash } from "node:crypto";
import {
  absence,
  auditEvent,
  clockEvent,
  HR_LINK_PORT,
  hrDelivery,
  hrLocationLink,
  hrPersonLink,
  integrationConnection,
  roleAssignment,
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
  hrAbsenceTypeKnown,
  hrClockEventOf,
  hrShiftOf,
  inboundAbsence,
  planHrAbsence,
  type ThapsusHrPort,
} from "@harbour/domain";
import { and, asc, eq, gte, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { publish } from "../outbox";
import { raiseCoverNeeds, resolveCoverNeeds } from "../services/absence";
import { HR_ACTOR, type HrLinkSettings, raiseHrAlert, recordSync, ukRefusal } from "./hr-link";

/**
 * The Thapsus-HR link's rota, clocking and absence flows (integrations.md section 11.2; slice 88;
 * INTG-014, SCHED-002, SCHED-004, SCHED-010; HZ-123, HZ-124, HZ-133). Runs in the organisation's
 * own system context, one run per organisation at a time. Harbour keeps the rota (ADR-0126):
 * shifts and clock events only go out, as the allow-listed fields (rule 4), and only to a UK
 * workspace on its UK address (rule 1); absences only come in, as read-only copies through the
 * absence port (dates and type only; rule 10), and raise cover needs on rostered shifts. Nothing
 * goes for, or comes from, a person whose match is not confirmed (rule 3); an absence for one is
 * raised for review.
 */

const MAX_PAGES = 1_000;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const CANCELLED = sha256("cancelled");
/** Drift never cancels more than this many copies in one run without a person (a guard). */
const DRIFT_GUARD = 5;

/**
 * The idempotency key for one version of one record (rule 5): the same record and payload always
 * give the same key, so a retry after a lost response is the same request to Thapsus-HR, whichever
 * run sends it. A UUID built from SHA-256 (version 8 layout).
 */
export function deliveryKey(kind: string, harbourRef: string, digest: string): string {
  const h = createHash("sha256").update(`${kind}:${harbourRef}:${digest}`).digest("hex");
  const variant = ((Number.parseInt(h[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

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

async function connectionId(tx: Transaction): Promise<string | null> {
  const [row] = await tx
    .select({ id: integrationConnection.id })
    .from(integrationConnection)
    .where(eq(integrationConnection.port, HR_LINK_PORT));
  return row?.id ?? null;
}

/** A failed absence sync: recorded, audited and published, as the employee pull does (rule 6). */
async function absencesFailed(tx: Transaction, tenantId: string, now: Date, code: string) {
  await recordSync(tx, "absences", now, code);
  await audit(
    tx,
    tenantId,
    "integrations.hr_link.sync_failed",
    "integration_connection",
    HR_LINK_PORT,
    { code, flow: "absences" },
    "error",
  );
  await publish(tx, {
    context: "integrations",
    aggregateType: "integration_connection",
    aggregateId: HR_LINK_PORT,
    type: "integrations.hr_link.sync_failed",
    payload: { code, flow: "absences" },
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

/**
 * Employees by Thapsus-HR id: confirmed links with the member, their home (the staff file's, else
 * the home of their oldest live role) and job title; and links waiting for a person.
 */
async function members(tx: Transaction) {
  const rows = await tx
    .select({
      linkId: hrPersonLink.id,
      state: hrPersonLink.state,
      hrEmployeeId: hrPersonLink.hrEmployeeId,
      staffProfileId: staffProfile.id,
      memberId: staffProfile.tenantUserId,
      locationId: staffProfile.locationId,
      jobTitle: staffProfile.jobTitle,
    })
    .from(hrPersonLink)
    .leftJoin(
      staffProfile,
      and(
        eq(staffProfile.tenantId, hrPersonLink.tenantId),
        eq(staffProfile.id, hrPersonLink.staffProfileId),
      ),
    )
    .where(and(ne(hrPersonLink.state, "rejected"), isNull(hrPersonLink.deletedAt)));
  const linked = new Map<
    string,
    { staffProfileId: string; memberId: string; locationId: string | null; jobTitle: string }
  >();
  const waiting = new Map<string, string>();
  for (const r of rows) {
    if (r.state === "review") waiting.set(r.hrEmployeeId, r.linkId);
    if (r.state !== "linked" || !r.staffProfileId || !r.memberId) continue;
    let locationId = r.locationId;
    if (!locationId) {
      const [role] = await tx
        .select({ locationId: roleAssignment.locationId })
        .from(roleAssignment)
        .where(
          and(
            eq(roleAssignment.tenantUserId, r.memberId),
            isNotNull(roleAssignment.locationId),
            isNull(roleAssignment.deletedAt),
            sql`(${roleAssignment.validTo} IS NULL OR ${roleAssignment.validTo} > now())`,
          ),
        )
        .orderBy(asc(roleAssignment.createdAt))
        .limit(1);
      locationId = role?.locationId ?? null;
    }
    linked.set(r.hrEmployeeId, {
      staffProfileId: r.staffProfileId,
      memberId: r.memberId,
      locationId,
      jobTitle: r.jobTitle ?? "",
    });
  }
  return { linked, waiting };
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
 * a confirmed member applied in its own savepoint through the absence port; cover needs raised on
 * their rostered shifts and resolved when an absence is cut short or cancelled. Once every page is
 * read and every record applied, a copy Thapsus-HR no longer lists is cancelled (drift) unless that
 * would cancel many at once, which waits for a person. A record that cannot be read or applied, an
 * unknown type and an absence for an unconfirmed member are raised for review; a failure is never
 * a good sync, so the rota says its data may be old (rule 9).
 */
export async function pullAbsences(
  tx: Transaction,
  tenantId: string,
  port: ThapsusHrPort,
  now: Date,
): Promise<AbsenceOutcome> {
  const out = { copied: 0, changed: 0, cancelled: 0, coverNeeds: 0, failed: 0 };
  const { linked, waiting } = await members(tx);
  const connection = await connectionId(tx);
  const seen = new Set<string>();
  const failedIds: string[] = [];
  const unknownTypes: string[] = [];
  let cursor: string | null = null;
  const cursors = new Set<string>();
  let complete = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await port.absences(cursor);
    if (!result.ok) {
      await absencesFailed(tx, tenantId, now, result.error);
      return { ...out, error: result.error };
    }
    for (const raw of result.value.items) {
      // Seen whatever else is wrong with it, so a malformed record never frees a copy (drift).
      const rawId = typeof raw.id === "string" && ID.test(raw.id) ? raw.id : null;
      if (rawId) seen.add(rawId);
      const incoming = inboundAbsence(raw);
      if (!incoming) {
        out.failed += 1;
        failedIds.push(rawId ?? "invalid");
        continue;
      }
      if (!hrAbsenceTypeKnown(raw)) unknownTypes.push(incoming.id);
      const member = linked.get(incoming.employeeId);
      if (!member) {
        const waitingLink = waiting.get(incoming.employeeId);
        if (waitingLink && incoming.status === "approved") {
          await raiseHrAlert(tx, "absence_unconfirmed", "hr_person_link", waitingLink, now, [
            incoming.id,
          ]);
        }
        continue;
      }
      if (!member.locationId) {
        await raiseHrAlert(tx, "absence_unplaced", "staff_profile", member.staffProfileId, now, [
          incoming.id,
        ]);
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
        failedIds.push(incoming.id);
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
  if (connection && unknownTypes.length > 0) {
    await raiseHrAlert(
      tx,
      "absence_type_unknown",
      "integration_connection",
      connection,
      now,
      unknownTypes,
    );
  }
  if (!complete) {
    await absencesFailed(tx, tenantId, now, "incomplete");
    return { ...out, error: "incomplete" };
  }
  if (out.failed > 0) {
    if (connection) {
      await raiseHrAlert(
        tx,
        "absence_record_failed",
        "integration_connection",
        connection,
        now,
        failedIds,
      );
    }
    // No drift on a run that could not apply everything, and never a good sync (rule 9).
    await absencesFailed(tx, tenantId, now, "record_failed");
    return { ...out, error: "record_failed" };
  }
  // Drift (HZ-133): a copy whose absence Thapsus-HR no longer lists stops blocking the rota, but
  // many at once (an empty list, say) waits for a person.
  const copies = (
    await tx
      .select({ id: absence.id, hrId: absence.hrId })
      .from(absence)
      .where(and(eq(absence.source, "thapsus_hr"), ne(absence.state, "cancelled")))
  ).filter((c) => !(c.hrId && seen.has(c.hrId)));
  if (copies.length > DRIFT_GUARD) {
    if (connection) {
      await raiseHrAlert(
        tx,
        "absence_record_failed",
        "integration_connection",
        connection,
        now,
        copies.map((c) => c.hrId ?? ""),
      );
    }
    await absencesFailed(tx, tenantId, now, "drift_held");
    return { ...out, error: "drift_held" };
  }
  for (const c of copies) {
    await tx
      .update(absence)
      .set({ state: "cancelled", updatedBy: null })
      .where(eq(absence.id, c.id));
    await resolveCoverNeeds(tx, { absenceId: c.id }, "absence_ended");
    await audit(tx, tenantId, "integrations.hr_link.absence_removed", "absence", c.id);
    out.cancelled += 1;
  }
  await recordSync(tx, "absences", now, null);
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
 * One delivery, once (rule 5). The ledger row is written with its key and digest before the call,
 * in its own savepoint, and the key is the same for the same record and payload whichever run
 * sends it, so a retry after a lost response is the same request. A payload already sent, or
 * already refused, is never sent again; a changed one goes with its own key. Thapsus-HR's refusal
 * (an overlapping shift, say; rule 14) is raised for the rota manager.
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
  const key = deliveryKey(kind, harbourRef, digest);
  const [known] = await tx
    .select()
    .from(hrDelivery)
    .where(and(eq(hrDelivery.kind, kind), eq(hrDelivery.harbourRef, harbourRef)));
  if (
    known &&
    known.payloadSha256 === digest &&
    (known.state === "sent" || known.state === "refused")
  ) {
    return "skipped";
  }
  // Pending first, with what is about to be sent (the key and digest), before any call.
  const goodBefore = known?.state === "sent" ? known : null;
  if (known) {
    await tx
      .update(hrDelivery)
      .set({
        idempotencyKey: key,
        payloadSha256: digest,
        ...(goodBefore ? {} : { state: "pending" }),
        updatedBy: null,
      })
      .where(eq(hrDelivery.id, known.id));
  } else {
    await tx.insert(hrDelivery).values({
      kind,
      harbourRef,
      idempotencyKey: key,
      payloadSha256: digest,
      state: "pending",
      createdBy: null,
      updatedBy: null,
    });
  }
  const result = await send(key);
  const attempts = sql`${hrDelivery.attempts} + 1`;
  const where = and(eq(hrDelivery.kind, kind), eq(hrDelivery.harbourRef, harbourRef));
  if (result.ok) {
    await tx
      .update(hrDelivery)
      .set({
        state: "sent",
        hrId: result.value.id,
        sentAt: now,
        lastErrorCode: null,
        nextAttemptAt: null,
        attempts,
        updatedBy: null,
      })
      .where(where);
    return "sent";
  }
  const refused = result.error === "refused" || result.error === "conflict";
  await tx
    .update(hrDelivery)
    .set({
      // A failed change after a good send keeps the record of the good one; a failure keeps the
      // digest out so the retry goes again with the same key.
      ...(goodBefore
        ? { payloadSha256: refused ? digest : goodBefore.payloadSha256 }
        : {
            state: refused ? "refused" : "failed",
            ...(refused ? {} : { payloadSha256: null }),
          }),
      lastErrorCode: result.error,
      attempts,
      updatedBy: null,
    })
    .where(where);
  if (result.error === "rate_limited") return "rate_limited";
  if (refused) {
    if (await raiseHrAlert(tx, "delivery_refused", kind, harbourRef, now)) {
      await audit(
        tx,
        tenantId,
        "integrations.hr_link.delivery",
        kind,
        harbourRef,
        { code: result.error },
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
 * removed or the shift cancelled; its role is the member's job title (a sleep-in or on-call shift
 * is never sent as a pay attribute: pay units carry those, rule 12). Clock events in and out
 * recorded since the link was connected (at most a week back) go once each. Only for members
 * whose match is confirmed and homes that are mapped. Stops at a rate limit and carries on next
 * run (rule 6). Each delivery is its own savepoint.
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
  const people = new Map(
    [...(await members(tx)).linked.entries()].map(([hrId, m]) => [
      m.memberId,
      { hrEmployeeId: hrId, jobTitle: m.jobTitle },
    ]),
  );
  const mappedPlaces = [...places.keys()];
  if (mappedPlaces.length === 0) return { ...out, error: null };
  const once = async (
    kind: "shift" | "clock_event",
    ref: string,
    digest: string,
    send: (key: string) => Promise<HrResult<{ readonly id: string }>>,
    cancelling = false,
  ): Promise<boolean> => {
    let r: Awaited<ReturnType<typeof deliver>>;
    try {
      r = await tx.transaction((sp) => deliver(sp, tenantId, kind, ref, digest, now, send));
    } catch {
      r = "failed";
    }
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
      startsAt: shift.startsAt,
      endsAt: shift.endsAt,
      breakMinutes: shift.breakMinutes,
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
    const person = people.get(a.workerId);
    const hrLocationId = places.get(a.locationId);
    if (!person || !hrLocationId) continue;
    const live = a.removed === null && a.shiftDeleted === null && a.cancelReason === null;
    if (live) {
      const payload = hrShiftOf({
        assignmentId: a.id,
        hrEmployeeId: person.hrEmployeeId,
        hrLocationId,
        kind: person.jobTitle,
        startsAt: a.startsAt,
        endsAt: a.endsAt,
        breakMinutes: a.breakMinutes,
      });
      if (await once("shift", a.id, sha256(payload), (key) => port.upsertShift(payload, key))) {
        return { ...out, error: "rate_limited" };
      }
    } else {
      const [sent] = await tx
        .select({ state: hrDelivery.state, digest: hrDelivery.payloadSha256 })
        .from(hrDelivery)
        .where(and(eq(hrDelivery.kind, "shift"), eq(hrDelivery.harbourRef, a.id)));
      if (sent?.state !== "sent" || sent.digest === CANCELLED) continue;
      if (await once("shift", a.id, CANCELLED, (key) => port.cancelShift(a.id, key), true)) {
        return { ...out, error: "rate_limited" };
      }
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
    const person = people.get(e.workerId);
    const hrLocationId = places.get(e.locationId);
    if (!person || !hrLocationId) continue;
    const payload = hrClockEventOf({
      id: e.id,
      hrEmployeeId: person.hrEmployeeId,
      hrLocationId,
      kind: e.kind,
      at: e.at,
    });
    if (!payload) continue;
    if (
      await once("clock_event", e.id, sha256(payload), (key) => port.postClockEvent(payload, key))
    ) {
      return { ...out, error: "rate_limited" };
    }
  }
  return { ...out, error: null };
}

/**
 * Absences in, then shifts and clock events out, for one organisation at a time (an advisory
 * lock, so the 5-minute sync, a rota publication and a manual sync never overlap). Rule 1 first:
 * a workspace no longer in the UK, or not answering, gets nothing and sends nothing in. Each part
 * in a savepoint; anything unexpected is recorded and never rolls back the rest.
 */
export async function syncRotaSafely(
  tx: Transaction,
  tenantId: string,
  port: ThapsusHrPort,
  settings: HrLinkSettings,
  now: Date,
  parts: { readonly absences: boolean } = { absences: true },
): Promise<{
  readonly absences: AbsenceOutcome | null;
  readonly deliveries: DeliveryOutcome | null;
}> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`hr_link_rota:${tenantId}`}))`);
  const refusal = await ukRefusal(port, settings);
  if (refusal) {
    await audit(
      tx,
      tenantId,
      "integrations.hr_link.sync_failed",
      "integration_connection",
      HR_LINK_PORT,
      { code: refusal, flow: "rota" },
      "denied",
    );
    if (parts.absences) await recordSync(tx, "absences", now, refusal);
    return { absences: null, deliveries: null };
  }
  let absences: AbsenceOutcome | null = null;
  let deliveries: DeliveryOutcome | null = null;
  if (parts.absences) {
    try {
      absences = await tx.transaction((sp) => pullAbsences(sp, tenantId, port, now));
    } catch {
      await absencesFailed(tx, tenantId, now, "internal");
    }
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

/** Thapsus-HR copies still in force (the staleness route reads whether any remain). */
export async function activeHrAbsenceCopies(tx: Transaction): Promise<number> {
  const rows = await tx
    .select({ id: absence.id })
    .from(absence)
    .where(and(eq(absence.source, "thapsus_hr"), ne(absence.state, "cancelled")))
    .limit(1);
  return rows.length;
}
