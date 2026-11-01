import {
  AdministrationConflictList,
  AdministrationConflictOut,
  ConflictsQuery,
  LocationRound,
  LocationRoundQuery,
  ResolveConflict,
} from "@harbour/contracts";
import { medicationAdministrationConflict, person, type Transaction, task } from "@harbour/db";
import { ukIsoDate } from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { AuditedRefusal, auditInTx, withAuditedRefusal } from "../http/audit";
import {
  type AppEnv,
  requireAnyPermission,
  requirePermission,
  type TenantAccess,
  withTenant,
} from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { medicinesRates, personAdministrations } from "../services/medicine-administrations";
import {
  CONFLICT_TASK,
  type ConflictRow,
  conflictOut,
  roundFor,
} from "../services/medicine-rounds";
import { guardConcurrent, lockPerson, personEntries } from "../services/medicines";
import { loadPerson } from "../services/people";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";

/**
 * Rounds and conflict review (Phase 2 slice 48; MEDS-002; medicines.md section 15). The round for
 * a location reuses the person round; a device's second record of a dose is kept as a conflict
 * (raised by the administrations route) and resolved here once by the nurse in charge. API only:
 * the screens are slice 53. Audit by id only.
 */

const tags = ["medicines"];
const ADMINISTER = "medicines.emar.administer" as const;
const MANAGE = "medicines.record.manage" as const;
const LocationParam = z.object({ id: z.uuid() });
const ConflictParam = z.object({ id: z.uuid() });
const HOUR_MS = 3_600_000;

function audit(
  c: Context<AppEnv>,
  tx: Transaction,
  access: TenantAccess,
  input: Parameters<typeof auditInTx>[2],
) {
  return auditInTx(tx, access, { ...input, requestId: c.get("requestId") });
}

export const medicineRoundsRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/locations/{id}/medicine-round",
      tags,
      summary: "The medicines round for a location in a time slot",
      description:
        "For each person living at the location whom you may see: the scheduled doses in the slot (at most 12 hours) with their state in words, time-critical first, and each when-required medicine with when it was last given. People by room, then name. Audited.",
      security,
      request: { params: LocationParam, query: LocationRoundQuery },
      responses: { 200: jsonBody(LocationRound, "The round"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, ADMINISTER);
      const { id: locationId } = c.req.valid("param");
      const q = c.req.valid("query");
      const from = new Date(q.from);
      const to = new Date(q.to);
      const span = to.getTime() - from.getTime();
      if (span <= 0 || span > 12 * HOUR_MS) {
        throw problems.invalid("Choose a slot of up to 12 hours, its start before its end.");
      }
      const now = new Date();
      const out = await withTenant(c, async (tx) => {
        // RLS and person scope decide whom the caller sees.
        const people = await tx
          .select({ id: person.id, room: person.roomLabel })
          .from(person)
          .where(
            and(
              eq(person.locationId, locationId),
              eq(person.status, "active"),
              isNull(person.deletedAt),
            ),
          )
          .orderBy(asc(person.roomLabel), asc(person.familyName), asc(person.givenName));
        const rounds = [];
        let rates: Awaited<ReturnType<typeof medicinesRates>> | null = null;
        for (const p of people) {
          const entries = (await personEntries(tx, p.id)).map((s) => s.entry);
          if (entries.length === 0) continue;
          if (!rates) {
            const one = await loadPerson(tx, p.id);
            rates = await medicinesRates(tx, access.tenantId, one.nation, ukIsoDate(now));
          }
          const rows = await personAdministrations(tx, p.id);
          const round = roundFor({ entries, rows, rates }, { from, to }, now, now);
          if (round.doses.length === 0 && round.whenRequired.length === 0) continue;
          rounds.push({ personId: p.id, room: p.room, ...round });
        }
        await audit(c, tx, access, {
          action: "medicines.round.viewed",
          resourceType: "location",
          resourceId: locationId,
          scope: { people: rounds.length, from: from.toISOString(), to: to.toISOString() },
        });
        return { from: from.toISOString(), to: to.toISOString(), people: rounds };
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/medicine-administration-conflicts",
      tags,
      summary: "Conflicts for the nurse in charge to review",
      description:
        "A device's second record of a dose already recorded, with the record that stands. Open ones by default. Audited.",
      security,
      request: { query: ConflictsQuery },
      responses: { 200: jsonBody(AdministrationConflictList, "The conflicts"), ...errorResponses },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [MANAGE, ADMINISTER]);
      const q = c.req.valid("query");
      const out = await withTenant(c, async (tx) => {
        const personIds = q.locationId
          ? (
              await tx
                .select({ id: person.id })
                .from(person)
                .where(eq(person.locationId, q.locationId))
            ).map((p) => p.id)
          : null;
        if (personIds && personIds.length === 0) return { conflicts: [] };
        const rows = await tx
          .select()
          .from(medicationAdministrationConflict)
          .where(
            and(
              q.all === "true" ? undefined : isNull(medicationAdministrationConflict.resolvedAt),
              q.personId ? eq(medicationAdministrationConflict.personId, q.personId) : undefined,
              personIds ? inArray(medicationAdministrationConflict.personId, personIds) : undefined,
            ),
          )
          .orderBy(asc(medicationAdministrationConflict.receivedAt))
          .limit(200);
        const conflicts = [];
        for (const row of rows) {
          conflicts.push(await conflictOut(tx, row, await personAdministrations(tx, row.personId)));
        }
        await audit(c, tx, access, {
          action: "medicines.administration.conflict_viewed",
          resourceType: q.locationId ? "location" : "person",
          resourceId: q.locationId ?? q.personId,
          scope: { count: conflicts.length },
        });
        return { conflicts };
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/medicine-administration-conflicts/{id}",
      tags,
      summary: "A conflict: both records side by side",
      description: "Audited.",
      security,
      request: { params: ConflictParam },
      responses: {
        200: jsonBody(AdministrationConflictOut, "The conflict"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [MANAGE, ADMINISTER]);
      const { id } = c.req.valid("param");
      const out = await withTenant(c, async (tx) => {
        const [row] = await tx
          .select()
          .from(medicationAdministrationConflict)
          .where(eq(medicationAdministrationConflict.id, id));
        if (!row) throw problems.notFound();
        await audit(c, tx, access, {
          action: "medicines.administration.conflict_viewed",
          resourceType: "medication_administration_conflict",
          resourceId: id,
          scope: { personId: row.personId },
        });
        return conflictOut(tx, row, await personAdministrations(tx, row.personId));
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/medicine-administration-conflicts/{id}/resolve",
      tags,
      summary: "Resolve a conflict: the record that stands, or the correction made",
      description:
        "With medicines.record.manage. first_stands: the record on the server stands and the upload was the same dose sent twice. corrected: the record was corrected through the corrections route, naming the correction, which must correct this dose. Resolved once, with why; its task is closed. Audited, refusals included.",
      security,
      request: {
        params: ConflictParam,
        body: { content: { "application/json": { schema: ResolveConflict } } },
      },
      responses: {
        200: jsonBody(AdministrationConflictOut, "Resolved"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const out = await withAuditedRefusal(c, access, () =>
        withTenant(c, async (tx) => {
          const [first] = await tx
            .select({ personId: medicationAdministrationConflict.personId })
            .from(medicationAdministrationConflict)
            .where(eq(medicationAdministrationConflict.id, id));
          if (!first) throw problems.notFound();
          await lockPerson(tx, first.personId);
          const [row] = (await tx
            .select()
            .from(medicationAdministrationConflict)
            .where(eq(medicationAdministrationConflict.id, id))) as ConflictRow[];
          const deny = (problem: string, message: string) =>
            new AuditedRefusal(
              new HttpProblem(
                422,
                `conflict_${problem}`,
                "This conflict cannot be resolved like this.",
                message,
              ),
              {
                action: "medicines.administration.conflict_resolved",
                outcome: "denied",
                resourceType: "medication_administration_conflict",
                resourceId: id,
                scope: { personId: first.personId, problems: [problem] },
              },
            );
          if (!row || row.resolvedAt) {
            throw problems.conflict("This conflict has been resolved already.");
          }
          const rows = await personAdministrations(tx, row.personId);
          if (body.outcome === "corrected") {
            // The correction must be a record that corrects this dose (any record in its chain).
            const correction = rows.find((r) => r.id === body.correctionId);
            if (
              !correction?.supersedesId ||
              correction.medicationId !== row.medicationId ||
              correction.dueAt?.getTime() !== row.dueAt.getTime()
            ) {
              throw deny(
                "correction_not_for_dose",
                "Name the correction made to this dose through the corrections route.",
              );
            }
          } else if (body.correctionId !== null) {
            throw deny("correction_not_expected", "A record that stands names no correction.");
          }
          const [updated] = await guardConcurrent(() =>
            tx
              .update(medicationAdministrationConflict)
              .set({
                resolvedBy: access.tenantUserId,
                resolvedAt: now,
                resolution: body.outcome,
                correctionId: body.correctionId,
                resolutionNote: body.note,
              })
              .where(eq(medicationAdministrationConflict.id, id))
              .returning(),
          );
          await tx
            .update(task)
            .set({
              status: "done",
              completedAt: now,
              completedBy: access.tenantUserId,
              evidenceType: "medication_administration_conflict",
              evidenceId: id,
            })
            .where(
              and(
                eq(task.kind, CONFLICT_TASK),
                eq(task.sourceId, id),
                inArray(task.status, ["open", "in_progress"]),
              ),
            );
          await audit(c, tx, access, {
            action: "medicines.administration.conflict_resolved",
            resourceType: "medication_administration_conflict",
            resourceId: id,
            scope: {
              personId: row.personId,
              outcome: body.outcome,
              correctionId: body.correctionId,
            },
          });
          return conflictOut(tx, updated as ConflictRow, rows);
        }),
      );
      return c.json(out, 200);
    },
  );
