import {
  BodyMapMarkItem,
  BodyMapMarkList,
  CareNoteItem,
  CareNoteList,
  CreateBodyMapMark,
  CreateCareNote,
  CreateObservation,
  FluidDay,
  ObservationItem,
  ObservationList,
  PersonCareProfile,
  UpdatePersonCareProfile,
} from "@harbour/contracts";
import {
  bodyMapMark,
  careNote,
  incident,
  observation,
  personCareProfile,
  type Transaction,
} from "@harbour/db";
import {
  type BodyMarkType,
  type CareTrigger,
  calculateNews2,
  checkBowelEntry,
  checkIddsiEntry,
  fluidDaySummary,
  markTriggers,
  type PressureUlcerCategory,
  UK_TIME_ZONE,
  ukDayBounds,
  ukIsoDate,
  validateMark,
  weightInterval,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, desc, eq, gte, inArray, lt } from "drizzle-orm";
import type { Context } from "hono";
import { auditInTx } from "../http/audit";
import { type AppEnv, requirePermission, withTenant } from "../http/context";
import { problems } from "../http/problem";
import { publish } from "../outbox";
import {
  careProfile,
  careRates,
  completeOpenTasks,
  entryTimes,
  personContext,
  raiseCareTriggers,
} from "../services/care";
import { latestMustBand } from "../services/care-planning";
import { flagIfReportedDeleted } from "../services/device-holds";
import { loadPerson, type PersonRecord, requireWrite } from "../services/people";
import {
  applyLink,
  entryOut,
  entryWriteAccess,
  eventKind,
  PersonParam,
  planLink,
  range,
  requireCorrection,
  SENT_AT_HEADER,
  supersededIds,
  triggersAfterChange,
  window,
  withLateEntryReview,
} from "./care-shared";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";

/**
 * The point-of-care record (master prompt 10.1, docs/specs/care.md): daily notes, chart
 * observations with the validated rules, body-map marks and the person's care profile. Entries are
 * append-only; a correction supersedes. Reads and writes are audited by record id, never content.
 */

async function checkSuperseded(
  tx: Transaction,
  table: typeof careNote | typeof observation | typeof bodyMapMark,
  supersedesId: string | undefined,
  personId: string,
) {
  if (!supersedesId) return;
  const [original] = await tx
    .select({ personId: table.personId })
    .from(table)
    .where(eq(table.id, supersedesId));
  if (original?.personId !== personId)
    throw problems.invalid("The entry being corrected was not found.");
}

/** A mark recorded for an incident: the incident must be visible and the person on it. */
async function checkMarkIncident(
  tx: Transaction,
  incidentId: string | undefined,
  personId: string,
) {
  if (!incidentId) return;
  const [found] = await tx
    .select({ personIds: incident.personIds })
    .from(incident)
    .where(eq(incident.id, incidentId));
  if (!found?.personIds.includes(personId)) {
    throw problems.invalid("Add the person to the incident before recording a mark for it.");
  }
}

async function writeContext(c: Context<AppEnv>, personId: string, tx: Transaction) {
  const person = await personContext(tx, personId);
  const record = await loadPerson(tx, personId);
  const rates = await careRates(tx, c.get("access").tenantId, person.nation);
  return { person, record, rates };
}

/**
 * people.md rule 3 (HZ-006): what the person's status allows for an event at this time. An entry
 * about an event at or before a discharge, death or move to hospital is accepted and flagged as
 * recorded after it; anything later is refused, except post-event notes.
 */
function allowedAt(
  record: PersonRecord,
  kind: "care_note" | "observation" | "body_map_mark",
  occurredAt: Date,
  clockToleranceMinutes: number,
): boolean {
  return requireWrite(
    record,
    eventKind(record, kind, occurredAt),
    occurredAt,
    clockToleranceMinutes,
  ).recordedAfterExit;
}

export const careRouter = createRouter()
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/notes",
      tags: ["care"],
      summary: "Write a daily note (append-only; corrections supersede)",
      security,
      request: {
        params: PersonParam,
        body: { content: { "application/json": { schema: CreateCareNote } } },
      },
      responses: {
        201: jsonBody(CareNoteItem, "Note saved (or the earlier copy of a replayed upload)"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await entryWriteAccess(c, "care_note");
      const { id: personId } = c.req.valid("param");
      const body = c.req.valid("json");
      requireCorrection(body);
      const now = new Date();
      const item = await withLateEntryReview(
        c,
        { kind: "care_note", clientId: body.id, occurredAt: body.occurredAt },
        () =>
          withTenant(c, async (tx) => {
            // A replayed upload (the same device id) returns the stored entry before anything is
            // planned or checked again, so a replay never raises a second review (S-L5).
            if (body.id) {
              const [replayed] = await tx.select().from(careNote).where(eq(careNote.id, body.id));
              if (replayed) {
                if (replayed.personId !== personId)
                  throw problems.invalid("That id is already used.");
                return noteItem(replayed, new Set());
              }
            }
            const { person, record, rates } = await writeContext(c, personId, tx);
            const times = entryTimes(body, c.req.header(SENT_AT_HEADER), now, rates);
            const recordedAfterExit = allowedAt(
              record,
              "care_note",
              times.occurredAt,
              rates.clockDriftMinutes,
            );
            await checkSuperseded(tx, careNote, body.supersedesId, personId);
            const link = await planLink(tx, access, body.taskId, personId, times.occurredAt);
            const [inserted] = await tx
              .insert(careNote)
              .values({
                ...(body.id ? { id: body.id } : {}),
                personId,
                locationId: person.locationId,
                category: body.category,
                body: body.body,
                tags: body.tags,
                attachmentDocumentIds: body.attachmentDocumentIds,
                occurredAt: times.occurredAt,
                deviceTime: times.deviceTime,
                deviceId: access.deviceId,
                lateEntry: times.lateEntry,
                clockDrift: times.clockDrift,
                recordedAfterExit,
                taskId: link?.taskId ?? null,
                taskOutcome: link?.outcome ?? null,
                supersedesId: body.supersedesId ?? null,
                correctionReason: body.correctionReason ?? null,
              })
              .onConflictDoNothing()
              .returning();
            const row =
              inserted ??
              (
                await tx
                  .select()
                  .from(careNote)
                  .where(eq(careNote.id, body.id ?? ""))
              )[0];
            if (!row || row.personId !== personId)
              throw problems.invalid("That id is already used.");
            if (inserted) {
              // An entry a device reported deleted is kept but flagged for the manager (round 4, H1).
              await flagIfReportedDeleted(tx, access, {
                resourceType: "care_note",
                id: row.id,
                locationId: person.locationId,
                requestId: c.get("requestId"),
              });
              if (link) {
                await applyLink(tx, access, c.get("requestId"), link, {
                  evidenceType: "care_note",
                  evidenceId: row.id,
                  personId,
                  locationId: person.locationId,
                  actorTenantUserId: access.tenantUserId,
                  deviceId: access.deviceId,
                  now,
                });
              }
              await auditInTx(tx, access, {
                action: body.supersedesId ? "care.note.correct" : "care.note.create",
                resourceType: "care_note",
                resourceId: row.id,
                reason: body.correctionReason,
                requestId: c.get("requestId"),
              });
              await publish(tx, {
                context: "care",
                aggregateType: "person",
                aggregateId: personId,
                type: "care.note.recorded",
                payload: { noteId: row.id, lateEntry: row.lateEntry },
              });
            }
            return noteItem(row, new Set());
          }),
      );
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/notes",
      tags: ["care"],
      summary: "Daily notes, newest first (default: the last three days)",
      security,
      request: {
        params: PersonParam,
        query: range.extend({
          category: z
            .enum([
              "personal_care",
              "nutrition",
              "mood",
              "activity",
              "visit",
              "health",
              "night",
              "other",
            ])
            .optional(),
        }),
      },
      responses: { 200: jsonBody(CareNoteList, "Notes"), ...errorResponses, ...notFoundResponse },
    }),
    async (c) => {
      const access = await requirePermission(c, "care.note.read");
      const { id: personId } = c.req.valid("param");
      const q = c.req.valid("query");
      const { from, to } = window(q, new Date());
      const items = await withTenant(c, async (tx) => {
        await personContext(tx, personId);
        const rows = await tx
          .select()
          .from(careNote)
          .where(
            and(
              eq(careNote.personId, personId),
              gte(careNote.occurredAt, from),
              lt(careNote.occurredAt, to),
              q.category ? eq(careNote.category, q.category) : undefined,
            ),
          )
          .orderBy(desc(careNote.occurredAt))
          .limit(1000);
        await auditInTx(tx, access, {
          action: "care.note.list",
          resourceType: "person",
          resourceId: personId,
          scope: { count: rows.length },
          requestId: c.get("requestId"),
        });
        const superseded = supersededIds(rows);
        return rows.map((r) => noteItem(r, superseded));
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/observations",
      tags: ["care"],
      summary: "Record a chart entry (fluids, food, repositioning, bowel, weight, vital signs)",
      description:
        "Vital signs are scored with NEWS2 using the person's recorded SpO2 scale; a score that needs a response alerts the nurse in charge and creates the follow-up tasks. Food and drink are checked against the person's IDDSI levels.",
      security,
      request: {
        params: PersonParam,
        body: { content: { "application/json": { schema: CreateObservation } } },
      },
      responses: {
        201: jsonBody(ObservationItem, "Saved (or the earlier copy of a replayed upload)"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await entryWriteAccess(c, "observation");
      const { id: personId } = c.req.valid("param");
      const body = c.req.valid("json");
      requireCorrection(body);
      const now = new Date();
      const item = await withLateEntryReview(
        c,
        { kind: "observation", clientId: body.id, occurredAt: body.occurredAt },
        () =>
          withTenant(c, async (tx) => {
            // A replayed upload (the same device id) returns the stored entry before anything is
            // planned or checked again, so a replay never raises a second review (S-L5).
            if (body.id) {
              const [replayed] = await tx
                .select()
                .from(observation)
                .where(eq(observation.id, body.id));
              if (replayed) {
                if (replayed.personId !== personId)
                  throw problems.invalid("That id is already used.");
                return observationItem(replayed, new Set());
              }
            }
            const { person, record, rates } = await writeContext(c, personId, tx);
            const times = entryTimes(body, c.req.header(SENT_AT_HEADER), now, rates);
            const recordedAfterExit = allowedAt(
              record,
              "observation",
              times.occurredAt,
              rates.clockDriftMinutes,
            );
            await checkSuperseded(tx, observation, body.supersedesId, personId);
            const profile = await careProfile(tx, personId);
            const { flags, triggers } = chartRules(body.values, profile, times.occurredAt);
            const link = await planLink(tx, access, body.taskId, personId, times.occurredAt);
            const [inserted] = await tx
              .insert(observation)
              .values({
                ...(body.id ? { id: body.id } : {}),
                personId,
                locationId: person.locationId,
                chart: body.values.chart,
                values: body.values,
                flags,
                occurredAt: times.occurredAt,
                deviceTime: times.deviceTime,
                deviceId: access.deviceId,
                lateEntry: times.lateEntry,
                clockDrift: times.clockDrift,
                recordedAfterExit,
                taskId: link?.taskId ?? null,
                taskOutcome: link?.outcome ?? null,
                supersedesId: body.supersedesId ?? null,
                correctionReason: body.correctionReason ?? null,
              })
              .onConflictDoNothing()
              .returning();
            const row =
              inserted ??
              (
                await tx
                  .select()
                  .from(observation)
                  .where(eq(observation.id, body.id ?? ""))
              )[0];
            if (!row || row.personId !== personId)
              throw problems.invalid("That id is already used.");
            if (inserted) {
              // An entry a device reported deleted is kept but flagged for the manager (round 4, H1).
              await flagIfReportedDeleted(tx, access, {
                resourceType: "observation",
                id: row.id,
                locationId: person.locationId,
                requestId: c.get("requestId"),
              });
              // A result recorded before a move to hospital or on leave still alerts the nurse in
              // charge; after a discharge or death only the safety prompts are raised (rule 3).
              await raiseCareTriggers(
                tx,
                {
                  personId,
                  locationId: person.locationId,
                  sourceType: "observation",
                  sourceId: row.id,
                },
                triggersAfterChange(triggers, recordedAfterExit, record.status),
                now,
              );
              if (link) {
                await applyLink(tx, access, c.get("requestId"), link, {
                  evidenceType: "observation",
                  evidenceId: row.id,
                  personId,
                  locationId: person.locationId,
                  actorTenantUserId: access.tenantUserId,
                  deviceId: access.deviceId,
                  now,
                });
              }
              if (body.values.chart === "weight" && !body.supersedesId && !recordedAfterExit) {
                // The weight answers the scheduled check and sets the next one: weekly while the
                // latest MUST result is medium or high, otherwise monthly (care.md rule 6).
                await completeOpenTasks(tx, {
                  personId,
                  kind: "care.weight_check",
                  evidenceType: "observation",
                  evidenceId: row.id,
                  actorTenantUserId: access.tenantUserId,
                  now,
                });
                await raiseCareTriggers(
                  tx,
                  {
                    personId,
                    locationId: person.locationId,
                    sourceType: "observation",
                    sourceId: row.id,
                    occurredOn: ukIsoDate(times.occurredAt),
                  },
                  [
                    {
                      kind: "weight_interval",
                      interval: weightInterval(await latestMustBand(tx, personId), rates),
                    },
                  ],
                  now,
                );
              }
              await auditInTx(tx, access, {
                action: body.supersedesId ? "care.observation.correct" : "care.observation.create",
                resourceType: "observation",
                resourceId: row.id,
                reason: body.correctionReason,
                requestId: c.get("requestId"),
              });
              await publish(tx, {
                context: "care",
                aggregateType: "person",
                aggregateId: personId,
                type: "care.observation.recorded",
                payload: { observationId: row.id, chart: row.chart },
              });
            }
            return observationItem(row, new Set());
          }),
      );
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/observations",
      tags: ["care"],
      summary: "Chart entries, newest first (default: the last three days)",
      security,
      request: {
        params: PersonParam,
        query: range.extend({
          chart: z
            .enum([
              "fluid_intake",
              "fluid_output",
              "food",
              "repositioning",
              "bowel",
              "weight",
              "vitals",
            ])
            .optional(),
        }),
      },
      responses: {
        200: jsonBody(ObservationList, "Entries"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "care.note.read");
      const { id: personId } = c.req.valid("param");
      const q = c.req.valid("query");
      const { from, to } = window(q, new Date());
      const items = await withTenant(c, async (tx) => {
        await personContext(tx, personId);
        const rows = await tx
          .select()
          .from(observation)
          .where(
            and(
              eq(observation.personId, personId),
              gte(observation.occurredAt, from),
              lt(observation.occurredAt, to),
              q.chart ? eq(observation.chart, q.chart) : undefined,
            ),
          )
          .orderBy(desc(observation.occurredAt))
          .limit(2000);
        await auditInTx(tx, access, {
          action: "care.observation.list",
          resourceType: "person",
          resourceId: personId,
          scope: { count: rows.length, chart: q.chart ?? null },
          requestId: c.get("requestId"),
        });
        const superseded = supersededIds(rows);
        return rows.map((r) => observationItem(r, superseded));
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/charts/fluid",
      tags: ["care"],
      summary: "Fluid balance for one UK calendar day, with the shortfall against the target",
      security,
      request: { params: PersonParam, query: z.object({ date: z.iso.date() }) },
      responses: {
        200: jsonBody(FluidDay, "Fluid balance"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "care.note.read");
      const { id: personId } = c.req.valid("param");
      const { date } = c.req.valid("query");
      const day = await withTenant(c, async (tx) => {
        await personContext(tx, personId);
        const bounds = ukDayBounds(date);
        const rows = await tx
          .select()
          .from(observation)
          .where(
            and(
              eq(observation.personId, personId),
              inArray(observation.chart, ["fluid_intake", "fluid_output"]),
              gte(observation.occurredAt, bounds.startsAt),
              lt(observation.occurredAt, bounds.endsAt),
            ),
          )
          .orderBy(asc(observation.occurredAt));
        const superseded = supersededIds(rows);
        const current = rows.filter((r) => !superseded.has(r.id));
        const profile = await careProfile(tx, personId);
        const outcome = fluidDaySummary({
          date,
          timeZone: UK_TIME_ZONE,
          targetMl: profile?.fluidTargetMl ?? null,
          entries: current
            .map((r) => ({
              occurredAt: r.occurredAt,
              kind: r.chart === "fluid_intake" ? ("intake" as const) : ("output" as const),
              volumeMl: Number((r.values as { ml?: number }).ml ?? 0),
            }))
            .filter((e) => e.volumeMl > 0),
        });
        if (!outcome.ok) throw problems.invalid(outcome.issues.map((i) => i.message).join(" "));
        await auditInTx(tx, access, {
          action: "care.chart.view",
          resourceType: "person",
          resourceId: personId,
          scope: { chart: "fluid", date },
          requestId: c.get("requestId"),
        });
        const s = outcome.summary;
        return {
          date,
          intakeMl: s.intakeMl,
          outputMl: s.outputMl,
          targetMl: s.target.status === "target_set" ? s.target.targetMl : null,
          shortfallMl: s.target.status === "target_set" ? s.target.shortfallMl : null,
          entries: s.entriesCounted,
        };
      });
      return c.json(day, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/body-map",
      tags: ["care"],
      summary:
        "Record a body-map mark (the side is stated in words and checked against the drawing)",
      security,
      request: {
        params: PersonParam,
        body: { content: { "application/json": { schema: CreateBodyMapMark } } },
      },
      responses: {
        201: jsonBody(BodyMapMarkItem, "Mark saved"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await entryWriteAccess(c, "body_map_mark");
      const { id: personId } = c.req.valid("param");
      const body = c.req.valid("json");
      requireCorrection(body);
      const check = validateMark({
        view: body.view,
        region: body.region,
        drawnSide: body.drawnSide,
        statedSide: body.side,
        markType: body.markType as BodyMarkType,
        pressureUlcerCategory: (body.pressureCategory ?? null) as PressureUlcerCategory | null,
        deviceRelated: body.deviceRelated ?? null,
        bruiseExplained: body.bruiseExplained ?? null,
      });
      if (!check.ok) throw problems.invalid(check.issues.map((i) => i.message).join(" "));
      const now = new Date();
      const item = await withLateEntryReview(
        c,
        { kind: "body_map_mark", clientId: body.id, occurredAt: body.occurredAt },
        () =>
          withTenant(c, async (tx) => {
            // A replayed upload (the same device id) returns the stored entry before anything is
            // planned or checked again, so a replay never raises a second review (S-L5).
            if (body.id) {
              const [replayed] = await tx
                .select()
                .from(bodyMapMark)
                .where(eq(bodyMapMark.id, body.id));
              if (replayed) {
                if (replayed.personId !== personId)
                  throw problems.invalid("That id is already used.");
                return markItem(replayed, new Set());
              }
            }
            const { person, record, rates } = await writeContext(c, personId, tx);
            const times = entryTimes(body, c.req.header(SENT_AT_HEADER), now, rates);
            const recordedAfterExit = allowedAt(
              record,
              "body_map_mark",
              times.occurredAt,
              rates.clockDriftMinutes,
            );
            await checkSuperseded(tx, bodyMapMark, body.supersedesId, personId);
            await checkMarkIncident(tx, body.incidentId, personId);
            const link = await planLink(tx, access, body.taskId, personId, times.occurredAt);
            const [inserted] = await tx
              .insert(bodyMapMark)
              .values({
                ...(body.id ? { id: body.id } : {}),
                personId,
                locationId: person.locationId,
                view: body.view,
                region: body.region,
                side: body.side,
                markType: body.markType,
                pressureCategory: body.pressureCategory ?? null,
                deviceRelated: body.deviceRelated ?? null,
                bruiseExplained: body.bruiseExplained ?? null,
                lengthMm: body.lengthMm?.toString() ?? null,
                widthMm: body.widthMm?.toString() ?? null,
                depthMm: body.depthMm?.toString() ?? null,
                description: body.description ?? null,
                photoDocumentId: body.photoDocumentId ?? null,
                incidentId: body.incidentId ?? null,
                status: body.status,
                occurredAt: times.occurredAt,
                deviceTime: times.deviceTime,
                deviceId: access.deviceId,
                lateEntry: times.lateEntry,
                clockDrift: times.clockDrift,
                recordedAfterExit,
                taskId: link?.taskId ?? null,
                taskOutcome: link?.outcome ?? null,
                supersedesId: body.supersedesId ?? null,
                correctionReason: body.correctionReason ?? null,
              })
              .onConflictDoNothing()
              .returning()
              .catch((error: unknown) => {
                const code =
                  (error as { code?: string }).code ??
                  (error as { cause?: { code?: string } }).cause?.code;
                if (code === "23503") throw problems.invalid("The photo was not found.");
                throw error;
              });
            const row =
              inserted ??
              (
                await tx
                  .select()
                  .from(bodyMapMark)
                  .where(eq(bodyMapMark.id, body.id ?? ""))
              )[0];
            if (!row || row.personId !== personId)
              throw problems.invalid("That id is already used.");
            if (inserted && body.status === "present") {
              // After a status change, the incident and safeguarding prompts still apply (rule 3).
              await raiseCareTriggers(
                tx,
                {
                  personId,
                  locationId: person.locationId,
                  sourceType: "body_map_mark",
                  sourceId: row.id,
                },
                triggersAfterChange(
                  markTriggers({
                    markType: body.markType as BodyMarkType,
                    pressureUlcerCategory: (body.pressureCategory ??
                      null) as PressureUlcerCategory | null,
                    bruiseExplained: body.bruiseExplained ?? null,
                  }),
                  recordedAfterExit,
                  record.status,
                ),
                now,
              );
            }
            if (inserted) {
              // An entry a device reported deleted is kept but flagged for the manager (round 4, H1).
              await flagIfReportedDeleted(tx, access, {
                resourceType: "body_map_mark",
                id: row.id,
                locationId: person.locationId,
                requestId: c.get("requestId"),
              });
              if (link) {
                await applyLink(tx, access, c.get("requestId"), link, {
                  evidenceType: "body_map_mark",
                  evidenceId: row.id,
                  personId,
                  locationId: person.locationId,
                  actorTenantUserId: access.tenantUserId,
                  deviceId: access.deviceId,
                  now,
                });
              }
              await auditInTx(tx, access, {
                action: body.supersedesId ? "care.body_map.correct" : "care.body_map.create",
                resourceType: "body_map_mark",
                resourceId: row.id,
                reason: body.correctionReason,
                requestId: c.get("requestId"),
              });
            }
            return markItem(row, new Set());
          }),
      );
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/body-map",
      tags: ["care"],
      summary: "Current body-map marks (the latest of each corrected or healed mark)",
      security,
      request: {
        params: PersonParam,
        query: z.object({ includeHealed: z.enum(["true", "false"]).default("false") }),
      },
      responses: {
        200: jsonBody(BodyMapMarkList, "Marks"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "care.note.read");
      const { id: personId } = c.req.valid("param");
      const { includeHealed } = c.req.valid("query");
      const items = await withTenant(c, async (tx) => {
        await personContext(tx, personId);
        const rows = await tx
          .select()
          .from(bodyMapMark)
          .where(eq(bodyMapMark.personId, personId))
          .orderBy(desc(bodyMapMark.occurredAt))
          .limit(2000);
        const superseded = supersededIds(rows);
        const current = rows.filter(
          (r) => !superseded.has(r.id) && (includeHealed === "true" || r.status === "present"),
        );
        await auditInTx(tx, access, {
          action: "care.body_map.view",
          resourceType: "person",
          resourceId: personId,
          scope: { count: current.length },
          requestId: c.get("requestId"),
        });
        return current.map((r) => markItem(r, superseded));
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/care-profile",
      tags: ["care"],
      summary: "IDDSI levels, fluid target, NEWS2 SpO2 scale and skin risk",
      security,
      request: { params: PersonParam },
      responses: {
        200: jsonBody(PersonCareProfile, "Profile"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      await requirePermission(c, "care.plan.read");
      const { id: personId } = c.req.valid("param");
      const profile = await withTenant(c, async (tx) => {
        await personContext(tx, personId);
        return careProfile(tx, personId);
      });
      return c.json(profileItem(personId, profile), 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/people/{id}/care-profile",
      tags: ["care"],
      summary: "Change IDDSI levels, the fluid target, the SpO2 scale or skin risk",
      description:
        "A changed IDDSI level must say who advised it (HZ-016); switching NEWS2 to SpO2 scale 2 needs the clinician who decided it.",
      security,
      request: {
        params: PersonParam,
        body: { content: { "application/json": { schema: UpdatePersonCareProfile } } },
      },
      responses: {
        200: jsonBody(PersonCareProfile, "Profile"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "care.plan.write");
      const { id: personId } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const saved = await withTenant(c, async (tx) => {
        await personContext(tx, personId);
        const current = await careProfile(tx, personId);
        if ((current?.version ?? 0) !== body.version) throw problems.conflict();
        const iddsiChanged =
          (body.iddsiFoodLevel !== undefined &&
            body.iddsiFoodLevel !== (current?.iddsiFoodLevel ?? null)) ||
          (body.iddsiDrinkLevel !== undefined &&
            body.iddsiDrinkLevel !== (current?.iddsiDrinkLevel ?? null));
        if (iddsiChanged && !body.iddsiAdvisedBy) {
          throw problems.invalid(
            "Say who advised the IDDSI level (for example the speech and language therapist).",
          );
        }
        if (body.spo2Scale2 === true && !current?.spo2Scale2 && !body.spo2Scale2Clinician) {
          throw problems.invalid("Record the clinician who decided to use SpO2 scale 2.");
        }
        const values = {
          ...(body.iddsiFoodLevel !== undefined ? { iddsiFoodLevel: body.iddsiFoodLevel } : {}),
          ...(body.iddsiDrinkLevel !== undefined ? { iddsiDrinkLevel: body.iddsiDrinkLevel } : {}),
          ...(iddsiChanged ? { iddsiAdvisedBy: body.iddsiAdvisedBy, iddsiChangedAt: now } : {}),
          ...(body.fluidTargetMl !== undefined ? { fluidTargetMl: body.fluidTargetMl } : {}),
          ...(body.spo2Scale2 !== undefined ? { spo2Scale2: body.spo2Scale2 } : {}),
          ...(body.spo2Scale2 === true && body.spo2Scale2Clinician
            ? {
                spo2Scale2Clinician: body.spo2Scale2Clinician,
                spo2Scale2RecordedOn: body.spo2Scale2RecordedOn ?? now.toISOString().slice(0, 10),
              }
            : {}),
          ...(body.spo2Scale2 === false
            ? { spo2Scale2Clinician: null, spo2Scale2RecordedOn: null }
            : {}),
          ...(body.skinRisk !== undefined ? { skinRisk: body.skinRisk } : {}),
        };
        let row: typeof personCareProfile.$inferSelect | undefined;
        if (current) {
          [row] = await tx
            .update(personCareProfile)
            .set(values)
            .where(
              and(
                eq(personCareProfile.id, current.id),
                eq(personCareProfile.version, current.version),
              ),
            )
            .returning();
        } else {
          [row] = await tx
            .insert(personCareProfile)
            .values({ personId, ...values })
            .onConflictDoNothing()
            .returning();
        }
        if (!row) throw problems.conflict();
        await auditInTx(tx, access, {
          action: "care.profile.update",
          resourceType: "person",
          resourceId: personId,
          after: { iddsiChanged, version: row.version },
          requestId: c.get("requestId"),
        });
        return row;
      });
      return c.json(profileItem(personId, saved), 200);
    },
  );

type ProfileRow = typeof personCareProfile.$inferSelect | null;

/** The checks and flags each chart applies before an entry is saved. */
function chartRules(
  values: CreateObservation["values"],
  profile: ProfileRow,
  occurredAt: Date,
): { flags: Record<string, unknown>; triggers: CareTrigger[] } {
  if (values.chart === "fluid_intake" || values.chart === "food") {
    if (!values.iddsiLevel) return { flags: {}, triggers: [] };
    const kind = values.chart === "food" ? "food" : "drink";
    const check = checkIddsiEntry({
      kind,
      prescribed: (kind === "food" ? profile?.iddsiFoodLevel : profile?.iddsiDrinkLevel) ?? null,
      recorded: values.iddsiLevel,
      reason: values.overrideReason ?? null,
    });
    if (!check.ok) throw problems.invalid(check.message);
    return {
      flags: { iddsi: check.comparison, iddsiAlert: check.alertNurseInCharge },
      triggers: check.alertNurseInCharge
        ? [
            {
              kind: "urgent_alert",
              recipient: "nurse_in_charge",
              reason: "IDDSI level differs from the prescribed level",
            },
          ]
        : [],
    };
  }
  if (values.chart === "bowel") {
    const check = checkBowelEntry(
      values.noMovement || values.bristolType === null
        ? { kind: "no_movement", occurredAt }
        : { kind: "movement", occurredAt, bristolType: values.bristolType },
    );
    if (!check.ok) throw problems.invalid(check.message);
    return { flags: {}, triggers: [] };
  }
  if (values.chart === "vitals") {
    const outcome = calculateNews2({
      respirationRate: values.respirationRate,
      spo2: values.spo2,
      supplementalOxygen: values.onOxygen,
      systolicBp: values.systolic,
      pulse: values.pulse,
      consciousness: values.consciousness,
      temperature: values.temperature,
      spo2Scale2Decision: profile?.spo2Scale2 ?? false,
    });
    if (!outcome.ok) throw problems.invalid(outcome.message);
    const r = outcome.result;
    return {
      flags: {
        news2: {
          toolVersion: r.toolVersion,
          score: r.score,
          band: r.band,
          redScore: r.redScore,
          spo2Scale: r.spo2Scale,
          clinicalRisk: r.clinicalRisk,
          response: r.response,
          monitoring: r.monitoring.text,
          workings: r.workings,
        },
      },
      // A score of 0 keeps the routine monitoring the care plan sets; scheduling a repeat after
      // every normal reading would only add noise to the round (hazard HZ-008).
      triggers:
        r.score === 0
          ? r.triggers.filter((t) => t.kind !== "repeat_observations")
          : [...r.triggers],
    };
  }
  return { flags: {}, triggers: [] };
}

function noteItem(row: typeof careNote.$inferSelect, superseded: ReadonlySet<string>) {
  return {
    ...entryOut(row, superseded),
    category: row.category as CareNoteItem["category"],
    body: row.body,
    tags: row.tags,
    attachmentDocumentIds: row.attachmentDocumentIds,
  };
}

function observationItem(row: typeof observation.$inferSelect, superseded: ReadonlySet<string>) {
  return {
    ...entryOut(row, superseded),
    chart: row.chart,
    values: row.values as Record<string, unknown>,
    flags: row.flags as Record<string, unknown>,
  };
}

function markItem(row: typeof bodyMapMark.$inferSelect, superseded: ReadonlySet<string>) {
  const num = (v: string | null) => (v === null ? null : Number(v));
  return {
    ...entryOut(row, superseded),
    view: row.view as "front" | "back",
    region: row.region,
    side: row.side as "left" | "right" | "midline",
    markType: row.markType as BodyMapMarkItem["markType"],
    pressureCategory: row.pressureCategory as BodyMapMarkItem["pressureCategory"],
    lengthMm: num(row.lengthMm),
    widthMm: num(row.widthMm),
    depthMm: num(row.depthMm),
    description: row.description,
    photoDocumentId: row.photoDocumentId,
    status: row.status as "present" | "healed",
    incidentId: row.incidentId,
  };
}

function profileItem(personId: string, row: ProfileRow): PersonCareProfile {
  return {
    personId,
    iddsiFoodLevel: (row?.iddsiFoodLevel ?? null) as PersonCareProfile["iddsiFoodLevel"],
    iddsiDrinkLevel: (row?.iddsiDrinkLevel ?? null) as PersonCareProfile["iddsiDrinkLevel"],
    iddsiAdvisedBy: row?.iddsiAdvisedBy ?? null,
    iddsiChangedAt: row?.iddsiChangedAt ? row.iddsiChangedAt.toISOString() : null,
    fluidTargetMl: row?.fluidTargetMl ?? null,
    spo2Scale2: row?.spo2Scale2 ?? false,
    spo2Scale2Clinician: row?.spo2Scale2Clinician ?? null,
    spo2Scale2RecordedOn: row?.spo2Scale2RecordedOn ?? null,
    skinRisk: (row?.skinRisk ?? "not_at_risk") as PersonCareProfile["skinRisk"],
    version: row?.version ?? 0,
  };
}
