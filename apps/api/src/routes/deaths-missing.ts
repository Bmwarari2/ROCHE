import {
  CloseDeath,
  CloseMissingEpisode,
  DeathJudgement,
  DeathList,
  DeathRecordStatus,
  DeathReview,
  DeathView,
  HerbertProfileView,
  MissingEpisodeList,
  MissingEpisodeStatus,
  MissingEpisodeView,
  MissingTimelineEntry,
  OpenDeath,
  OpenMissingEpisode,
  RecordDeathStep,
  SaveHerbertProfile,
} from "@harbour/contracts";
import {
  classifierAnswer,
  deathRecord,
  deathStep,
  document,
  herbertProfile,
  incident,
  incidentPerson,
  missingEpisode,
  missingEvent,
  type Transaction,
} from "@harbour/db";
import {
  type DeathStep as DeathStepKey,
  deathRecordPlan,
  deathReviewProblems,
  deathStepProblems,
  herbertProfileProblems,
  herbertReviewDueOn,
  LIVE_PERSON_STATUSES,
  type MissingTimelineKind,
  type PersonStatus,
  timelineEntryProblems,
  ukIsoDate,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { auditInTx } from "../http/audit";
import { type AppEnv, requirePermission, type TenantAccess, withTenant } from "../http/context";
import { problems } from "../http/problem";
import {
  deathItem,
  episodeItem,
  finishHerbertReviewTasks,
  herbertPrefillFor,
  openDeathRecord,
  phase2Rates,
  readDeath,
  readEpisode,
  syncPoliceCallTask,
} from "../services/deaths-missing";
import { loadPerson } from "../services/people";
import { classifyAndStore, subjectToDolsAt } from "../services/safety";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";

/**
 * Deaths and missing persons (Phase 2 slice 37; SAFE-014, SAFE-015; safety.md slice 37; hazards
 * HZ-013 and HZ-127). Reads need `safety.incident.read`; the death record, the episode's welfare
 * check, debrief and closing, and the Herbert Protocol profile need `safety.incident.manage`;
 * anyone who reports incidents may open an episode and add to its timeline. Each permission counts
 * only where it reaches the person (row-level security in its scope; ADR-0071). Reads and writes
 * are audited by record id, never content. Steps and timeline entries carry the client's id, so a
 * resend is a no-op.
 */

const IdParam = z.object({ id: z.uuid() });
const MANAGE = "safety.incident.manage";
const READ = "safety.incident.read";
const REPORT = "safety.incident.report";
/** Missing person and absconding incidents (the classifier's `MISSING`). */
const MISSING_TYPES = ["missing_person", "absconding"];
/** A device's clock may run a little ahead: a time up to a minute later than now is taken. */
const FUTURE_TOLERANCE_MS = 60_000;
const LIST_LIMIT = 200;

function audit(
  c: Context<AppEnv>,
  tx: Transaction,
  access: TenantAccess,
  input: Parameters<typeof auditInTx>[2],
) {
  return auditInTx(tx, access, { ...input, requestId: c.get("requestId") });
}

function dbCode(error: unknown): string | undefined {
  return (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
}

async function loadDeath(tx: Transaction, id: string, forUpdate = false) {
  const query = tx
    .select()
    .from(deathRecord)
    .where(and(eq(deathRecord.id, id), isNull(deathRecord.deletedAt)));
  const [row] = forUpdate ? await query.for("update") : await query;
  if (!row) throw problems.notFound();
  return row;
}

async function loadEpisode(tx: Transaction, id: string, forUpdate = false) {
  const query = tx
    .select()
    .from(missingEpisode)
    .where(and(eq(missingEpisode.id, id), isNull(missingEpisode.deletedAt)));
  const [row] = forUpdate ? await query.for("update") : await query;
  if (!row) throw problems.notFound();
  return row;
}

function requireOpenDeath(row: { readonly status: string }) {
  if (row.status !== "open") {
    throw problems.invalid("This death record is closed or withdrawn and cannot change.");
  }
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export const deathsMissingRouter = createRouter()
  // ----------------------------------------------------------------------------------------------
  // Deaths
  // ----------------------------------------------------------------------------------------------
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/deaths",
      tags: ["safety"],
      summary: "Death records in scope, open first (SAFE-014)",
      security,
      request: {
        query: z.object({ status: DeathRecordStatus.optional() }),
      },
      responses: { 200: jsonBody(DeathList, "Death records"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, READ);
      const { status } = c.req.valid("query");
      const now = new Date();
      const list = await withTenant(c, async (tx) => {
        const rows = await tx
          .select()
          .from(deathRecord)
          .where(
            and(isNull(deathRecord.deletedAt), status ? eq(deathRecord.status, status) : undefined),
          )
          .orderBy(desc(deathRecord.diedAt))
          .limit(LIST_LIMIT + 1);
        const shown = rows.slice(0, LIST_LIMIT);
        const items = [];
        for (const row of shown) {
          const read = await readDeath(tx, access.tenantId, row, now);
          items.push({
            id: row.id,
            personId: row.personId,
            locationId: row.locationId,
            diedAt: row.diedAt.toISOString(),
            status: row.status as "open" | "closed" | "withdrawn",
            reviewDueAt: row.reviewDueAt.toISOString(),
            reviewOverdue: !row.reviewedAt && now > row.reviewDueAt,
            outstanding: row.status === "open" ? read.view.closeProblems.length : 0,
            version: row.version,
          });
        }
        items.sort((a, b) => Number(b.status === "open") - Number(a.status === "open"));
        await audit(c, tx, access, {
          action: "safety.death.list",
          resourceType: "death_record",
          scope: { count: items.length },
        });
        return { items, truncated: rows.length > LIST_LIMIT };
      });
      return c.json(list, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/deaths",
      tags: ["safety"],
      summary: "Open the death record for a death recorded on an exit (once; the worker also does)",
      security,
      request: { body: { content: { "application/json": { schema: OpenDeath } } } },
      responses: {
        200: jsonBody(DeathView, "The death record"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { exitRecordId } = c.req.valid("json");
      const now = new Date();
      const view = await withTenant(c, async (tx) => {
        const id = await openDeathRecord(tx, access.tenantId, exitRecordId);
        if (!id) throw problems.notFound();
        const row = await loadDeath(tx, id);
        await audit(c, tx, access, {
          action: "safety.death.open",
          resourceType: "death_record",
          resourceId: id,
          scope: { exitRecordId },
        });
        return deathItem(row, await readDeath(tx, access.tenantId, row, now), now);
      });
      return c.json(view, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/deaths/{id}",
      tags: ["safety"],
      summary: "A death record: the judgement, each step and the mortality review",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(DeathView, "The death record"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, READ);
      const { id } = c.req.valid("param");
      const now = new Date();
      const view = await withTenant(c, async (tx) => {
        const row = await loadDeath(tx, id);
        await audit(c, tx, access, {
          action: "safety.death.view",
          resourceType: "death_record",
          resourceId: id,
        });
        return deathItem(row, await readDeath(tx, access.tenantId, row, now), now);
      });
      return c.json(view, 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/deaths/{id}",
      tags: ["safety"],
      summary:
        "Record the clinician's judgement: expected or not, and whether the cause may be unnatural",
      description:
        "Harbour never decides either: the record says whose judgement it is. Until both are recorded the steps assume an unexpected death whose cause may be unnatural, so the police steps are never missed.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: DeathJudgement } } },
      },
      responses: {
        200: jsonBody(DeathView, "Recorded"),
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
      const view = await withTenant(c, async (tx) => {
        const row = await loadDeath(tx, id, true);
        requireOpenDeath(row);
        if (row.version !== body.version) throw problems.conflict();
        const [saved] = await tx
          .update(deathRecord)
          .set({
            expected: body.expected,
            possiblyUnnatural: body.possiblyUnnatural,
            judgedBy: body.judgedBy,
          })
          .where(and(eq(deathRecord.id, id), eq(deathRecord.version, body.version)))
          .returning();
        if (!saved) throw problems.conflict();
        await audit(c, tx, access, {
          action: "safety.death.judgement",
          resourceType: "death_record",
          resourceId: id,
          scope: { expected: body.expected, possiblyUnnatural: body.possiblyUnnatural },
        });
        return deathItem(saved, await readDeath(tx, access.tenantId, saved, now), now);
      });
      return c.json(view, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/deaths/{id}/steps",
      tags: ["safety"],
      summary: "Record a step of the death as done, or not needed with the reason",
      description:
        "Append-only: the latest for a step counts. A notification step is done only in the notification centre; here it can only be recorded as not needed, with a reason of at least 20 characters. The mortality review is recorded on its own.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: RecordDeathStep } } },
      },
      responses: {
        200: jsonBody(DeathView, "Recorded"),
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
      const view = await withTenant(c, async (tx) => {
        const row = await loadDeath(tx, id, true);
        const [again] = await tx.select().from(deathStep).where(eq(deathStep.id, body.id));
        if (again) {
          const same =
            again.deathRecordId === id &&
            again.step === body.step &&
            again.outcome === body.outcome &&
            again.at.getTime() === new Date(body.at).getTime();
          if (!same) throw problems.alreadySavedDifferently();
          return deathItem(row, await readDeath(tx, access.tenantId, row, now), now);
        }
        requireOpenDeath(row);
        const rates = await phase2Rates(tx, access.tenantId, ukIsoDate(row.diedAt));
        const plan = deathRecordPlan(
          {
            diedAt: row.diedAt,
            expected: row.expected,
            possiblyUnnatural: row.possiblyUnnatural,
            learningDisabilityOrAutism: row.learningDisabilityOrAutism,
          },
          rates,
        );
        const stepProblems = deathStepProblems(
          plan,
          row.diedAt,
          {
            step: body.step as DeathStepKey,
            outcome: body.outcome,
            at: new Date(body.at),
            note: body.note ?? null,
          },
          new Date(now.getTime() + FUTURE_TOLERANCE_MS),
        );
        if (stepProblems.length > 0) throw problems.invalid(stepProblems.join(" "));
        await tx.insert(deathStep).values({
          id: body.id,
          deathRecordId: id,
          personId: row.personId,
          step: body.step,
          outcome: body.outcome,
          at: new Date(body.at),
          note: body.note ?? null,
          reference: body.reference ?? null,
        });
        await audit(c, tx, access, {
          action: "safety.death.step",
          resourceType: "death_record",
          resourceId: id,
          scope: { stepId: body.id, step: body.step, outcome: body.outcome },
        });
        return deathItem(row, await readDeath(tx, access.tenantId, row, now), now);
      });
      return c.json(view, 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/deaths/{id}/review",
      tags: ["safety"],
      summary: "Record the mortality review: its findings and lessons",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: DeathReview } } },
      },
      responses: {
        200: jsonBody(DeathView, "Recorded"),
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
      const view = await withTenant(c, async (tx) => {
        const row = await loadDeath(tx, id, true);
        requireOpenDeath(row);
        if (row.version !== body.version) throw problems.conflict();
        const reviewProblems = deathReviewProblems(body);
        if (reviewProblems.length > 0) throw problems.invalid(reviewProblems.join(" "));
        const [saved] = await tx
          .update(deathRecord)
          .set({
            reviewFindings: body.findings,
            reviewLessons: body.lessons,
            reviewedAt: now,
            reviewedBy: access.tenantUserId,
          })
          .where(and(eq(deathRecord.id, id), eq(deathRecord.version, body.version)))
          .returning();
        if (!saved) throw problems.conflict();
        await audit(c, tx, access, {
          action: "safety.death.review",
          resourceType: "death_record",
          resourceId: id,
        });
        return deathItem(saved, await readDeath(tx, access.tenantId, saved, now), now);
      });
      return c.json(view, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/deaths/{id}/close",
      tags: ["safety"],
      summary:
        "Close the death record once every step is done or not needed and the review recorded",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: CloseDeath } } },
      },
      responses: {
        200: jsonBody(DeathView, "Closed"),
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
      const view = await withTenant(c, async (tx) => {
        const row = await loadDeath(tx, id, true);
        requireOpenDeath(row);
        if (row.version !== body.version) throw problems.conflict();
        const read = await readDeath(tx, access.tenantId, row, now);
        if (read.view.closeProblems.length > 0) {
          throw problems.invalid(read.view.closeProblems.join(" "));
        }
        const [saved] = await tx
          .update(deathRecord)
          .set({ status: "closed", closedAt: now, closedBy: access.tenantUserId })
          .where(and(eq(deathRecord.id, id), eq(deathRecord.version, body.version)))
          .returning();
        if (!saved) throw problems.conflict();
        await audit(c, tx, access, {
          action: "safety.death.close",
          resourceType: "death_record",
          resourceId: id,
        });
        return deathItem(saved, await readDeath(tx, access.tenantId, saved, now), now);
      });
      return c.json(view, 200);
    },
  )
  // ----------------------------------------------------------------------------------------------
  // Missing persons
  // ----------------------------------------------------------------------------------------------
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/missing-episodes",
      tags: ["safety"],
      summary: "Missing person episodes in scope, still missing first (SAFE-015)",
      security,
      request: { query: z.object({ status: MissingEpisodeStatus.optional() }) },
      responses: { 200: jsonBody(MissingEpisodeList, "Episodes"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, READ);
      const { status } = c.req.valid("query");
      const now = new Date();
      const list = await withTenant(c, async (tx) => {
        const rows = await tx
          .select()
          .from(missingEpisode)
          .where(
            and(
              isNull(missingEpisode.deletedAt),
              status ? eq(missingEpisode.status, status) : undefined,
            ),
          )
          .orderBy(desc(missingEpisode.createdAt))
          .limit(LIST_LIMIT + 1);
        const items = [];
        for (const row of rows.slice(0, LIST_LIMIT)) {
          const { view } = await readEpisode(tx, access.tenantId, row, now);
          items.push({
            id: row.id,
            personId: row.personId,
            locationId: row.locationId,
            incidentId: row.incidentId,
            status: row.status as "open" | "found" | "closed",
            noticedMissingAt: iso(
              view.timeline.find((e) => e.kind === "noticed_missing")?.at ?? null,
            ),
            policeCallDueAt: iso(view.policeCallDueAt),
            policeCallLate: view.policeCallLate,
            version: row.version,
          });
        }
        const order = { open: 0, found: 1, closed: 2 } as const;
        items.sort((a, b) => order[a.status] - order[b.status]);
        await audit(c, tx, access, {
          action: "safety.missing.list",
          resourceType: "missing_episode",
          scope: { count: items.length },
        });
        return { items, truncated: rows.length > LIST_LIMIT };
      });
      return c.json(list, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/missing-episodes",
      tags: ["safety"],
      summary: "Open a missing person episode on its missing person (or absconding) incident",
      description:
        "Records when the person was noticed missing (and last seen), whether the risk assessment says call the police at once, and whether the person is under DoLS or the Mental Health Act; raises the police call task due at the target (HZ-127). One open episode per person. The client's id makes a resend a no-op.",
      security,
      request: { body: { content: { "application/json": { schema: OpenMissingEpisode } } } },
      responses: {
        201: jsonBody(MissingEpisodeView, "Opened"),
        200: jsonBody(MissingEpisodeView, "Already opened with this id"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, REPORT);
      const body = c.req.valid("json");
      const now = new Date();
      const result = await withTenant(c, async (tx) => {
        const [again] = await tx
          .select()
          .from(missingEpisode)
          .where(eq(missingEpisode.id, body.id));
        if (again) {
          if (again.personId !== body.personId || again.incidentId !== body.incidentId) {
            throw problems.alreadySavedDifferently();
          }
          return {
            created: false,
            item: episodeItem(again, await readEpisode(tx, access.tenantId, again, now)),
          };
        }
        const person = await loadPerson(tx, body.personId);
        if (!LIVE_PERSON_STATUSES.includes(person.status as PersonStatus)) {
          throw problems.invalid("A missing person episode is for someone who lives here now.");
        }
        const [found] = await tx
          .select()
          .from(incident)
          .where(and(eq(incident.id, body.incidentId), isNull(incident.deletedAt)));
        if (!found) throw problems.notFound();
        if (!MISSING_TYPES.includes(found.type) || found.status === "closed") {
          throw problems.invalid(
            "Open the episode on an open missing person or absconding incident.",
          );
        }
        const [onIncident] = await tx
          .select({ mha: incidentPerson.subjectToMentalHealthAct })
          .from(incidentPerson)
          .where(
            and(
              eq(incidentPerson.incidentId, body.incidentId),
              eq(incidentPerson.personId, body.personId),
              eq(incidentPerson.kind, "service_user"),
              eq(incidentPerson.role, "affected"),
              isNull(incidentPerson.deletedAt),
            ),
          );
        if (!onIncident) {
          throw problems.invalid("The person must be on the incident as the person affected.");
        }
        const noticedAt = new Date(body.noticedMissingAt);
        const lastSeenAt = body.lastSeenAt ? new Date(body.lastSeenAt) : null;
        const latest = new Date(now.getTime() + FUTURE_TOLERANCE_MS);
        if (noticedAt > latest || (lastSeenAt && lastSeenAt > latest)) {
          throw problems.invalid("The time cannot be in the future.");
        }
        if (lastSeenAt && lastSeenAt > noticedAt) {
          throw problems.invalid("The person cannot be last seen after they were noticed missing.");
        }
        const underDols = await subjectToDolsAt(tx, access.tenantId, [body.personId], noticedAt);
        const [profile] = await tx
          .select({ version: herbertProfile.version })
          .from(herbertProfile)
          .where(and(eq(herbertProfile.personId, body.personId), isNull(herbertProfile.deletedAt)));
        let row: typeof missingEpisode.$inferSelect | undefined;
        try {
          [row] = await tx
            .insert(missingEpisode)
            .values({
              id: body.id,
              personId: body.personId,
              locationId: person.locationId,
              incidentId: body.incidentId,
              immediateRisk: body.immediateRisk,
              underDolsOrMha: underDols.has(body.personId) || onIncident.mha === true,
              herbertProfileVersion: profile?.version ?? null,
            })
            .returning();
        } catch (error) {
          if (dbCode(error) === "23505") {
            throw problems.conflict("This person already has an open missing person episode.");
          }
          throw error;
        }
        if (!row) throw problems.conflict();
        if (lastSeenAt) {
          await tx.insert(missingEvent).values({
            episodeId: row.id,
            personId: row.personId,
            kind: "last_seen",
            at: lastSeenAt,
          });
        }
        await tx.insert(missingEvent).values({
          episodeId: row.id,
          personId: row.personId,
          kind: "noticed_missing",
          at: noticedAt,
        });
        const read = await readEpisode(tx, access.tenantId, row, now);
        await syncPoliceCallTask(tx, row, read.view.policeCallDueAt, now);
        await audit(c, tx, access, {
          action: "safety.missing.open",
          resourceType: "missing_episode",
          resourceId: row.id,
          scope: { incidentId: body.incidentId, immediateRisk: body.immediateRisk },
        });
        return { created: true, item: episodeItem(row, read) };
      });
      return c.json(result.item, result.created ? 201 : 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/missing-episodes/{id}",
      tags: ["safety"],
      summary: "A missing person episode: its timeline, the police call, and what closing needs",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(MissingEpisodeView, "The episode"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, READ);
      const { id } = c.req.valid("param");
      const now = new Date();
      const view = await withTenant(c, async (tx) => {
        const row = await loadEpisode(tx, id);
        await audit(c, tx, access, {
          action: "safety.missing.view",
          resourceType: "missing_episode",
          resourceId: id,
        });
        return episodeItem(row, await readEpisode(tx, access.tenantId, row, now));
      });
      return c.json(view, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/missing-episodes/{id}/events",
      tags: ["safety"],
      summary: "Add to the episode's timeline or search log",
      description:
        "Append-only. The police called need their reference, and tell the incident's classifier that the police are involved, so the CQC notification is drafted in the notification centre (regulation 18(2)(f); HZ-013). Found ends the police call task. The welfare check and the debrief need safety.incident.manage.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: MissingTimelineEntry } } },
      },
      responses: {
        200: jsonBody(MissingEpisodeView, "Recorded"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const access =
        body.kind === "welfare_check" || body.kind === "debrief"
          ? await requirePermission(c, MANAGE)
          : await requirePermission(c, REPORT);
      const { id } = c.req.valid("param");
      const now = new Date();
      const view = await withTenant(c, async (tx) => {
        let row = await loadEpisode(tx, id, true);
        const [again] = await tx.select().from(missingEvent).where(eq(missingEvent.id, body.id));
        if (again) {
          const same =
            again.episodeId === id &&
            again.kind === body.kind &&
            again.at.getTime() === new Date(body.at).getTime();
          if (!same) throw problems.alreadySavedDifferently();
          return episodeItem(row, await readEpisode(tx, access.tenantId, row, now));
        }
        const before = await readEpisode(tx, access.tenantId, row, now);
        const entry = {
          kind: body.kind as MissingTimelineKind,
          at: new Date(body.at),
          reference: body.reference ?? null,
          area: body.area ?? null,
          note: body.note ?? null,
        };
        const entryProblems = timelineEntryProblems(
          row.status as "open" | "found" | "closed",
          before.view.timeline,
          entry,
          new Date(now.getTime() + FUTURE_TOLERANCE_MS),
          before.rates,
        );
        if (entryProblems.length > 0) throw problems.invalid(entryProblems.join(" "));
        await tx.insert(missingEvent).values({
          id: body.id,
          episodeId: id,
          personId: row.personId,
          kind: body.kind,
          at: entry.at,
          reference: entry.reference,
          area: entry.area,
          note: entry.note,
        });
        if (body.kind === "found") {
          const [moved] = await tx
            .update(missingEpisode)
            .set({ status: "found" })
            .where(eq(missingEpisode.id, id))
            .returning();
          if (moved) row = moved;
        }
        if (body.kind === "police_called") {
          // The incident's classifier hears that the police are involved: the CQC notification is
          // drafted, with its clock, in the notification centre (regulation 18(2)(f); HZ-013).
          const [open] = await tx
            .select({ status: incident.status })
            .from(incident)
            .where(eq(incident.id, row.incidentId));
          if (open && open.status !== "closed") {
            await tx.insert(classifierAnswer).values({
              incidentId: row.incidentId,
              questionKey: "police.involved",
              value: "yes",
              answeredAt: now,
              answeredBy: access.tenantUserId,
              deviceId: access.deviceId,
            });
            await classifyAndStore(tx, {
              tenantId: access.tenantId,
              incidentId: row.incidentId,
              actorTenantUserId: access.tenantUserId,
              now,
            });
          }
        }
        const read = await readEpisode(tx, access.tenantId, row, now);
        await syncPoliceCallTask(tx, row, read.view.policeCallDueAt, now);
        await audit(c, tx, access, {
          action: "safety.missing.event",
          resourceType: "missing_episode",
          resourceId: id,
          scope: { eventId: body.id, kind: body.kind },
        });
        return episodeItem(row, read);
      });
      return c.json(view, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/missing-episodes/{id}/close",
      tags: ["safety"],
      summary:
        "Close the episode once the person is found, their welfare checked and the debrief held",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: CloseMissingEpisode } } },
      },
      responses: {
        200: jsonBody(MissingEpisodeView, "Closed"),
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
      const view = await withTenant(c, async (tx) => {
        const row = await loadEpisode(tx, id, true);
        if (row.status === "closed") throw problems.invalid("This episode is already closed.");
        if (row.version !== body.version) throw problems.conflict();
        const read = await readEpisode(tx, access.tenantId, row, now);
        if (!read.view.canClose) throw problems.invalid(read.view.closeProblems.join(" "));
        const [saved] = await tx
          .update(missingEpisode)
          .set({ status: "closed", closedAt: now, closedBy: access.tenantUserId })
          .where(and(eq(missingEpisode.id, id), eq(missingEpisode.version, body.version)))
          .returning();
        if (!saved) throw problems.conflict();
        await syncPoliceCallTask(tx, saved, null, now);
        await audit(c, tx, access, {
          action: "safety.missing.close",
          resourceType: "missing_episode",
          resourceId: id,
        });
        return episodeItem(saved, await readEpisode(tx, access.tenantId, saved, now));
      });
      return c.json(view, 200);
    },
  )
  // ----------------------------------------------------------------------------------------------
  // The Herbert Protocol profile
  // ----------------------------------------------------------------------------------------------
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/herbert-profile",
      tags: ["safety"],
      summary: "The person's Herbert Protocol profile, whether it is out of date, and a prefill",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(HerbertProfileView, "The profile"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, READ);
      const { id } = c.req.valid("param");
      const now = new Date();
      const view = await withTenant(c, async (tx) => {
        await loadPerson(tx, id);
        const result = await herbertView(tx, access.tenantId, id, now);
        await audit(c, tx, access, {
          action: "safety.herbert.view",
          resourceType: "person",
          resourceId: id,
        });
        return result;
      });
      return c.json(view, 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/people/{id}/herbert-profile",
      tags: ["safety"],
      summary:
        "Save the person's Herbert Protocol profile as reviewed on a date (version 0 starts it)",
      description:
        "What the person looks like and where they may go are required; the photograph is one of the person's documents; the review date is never later than today. Saving finishes the profile's review task.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: SaveHerbertProfile } } },
      },
      responses: {
        200: jsonBody(HerbertProfileView, "Saved"),
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
      const view = await withTenant(c, async (tx) => {
        const person = await loadPerson(tx, id);
        if (!LIVE_PERSON_STATUSES.includes(person.status as PersonStatus)) {
          throw problems.invalid("A Herbert Protocol profile is for someone who lives here now.");
        }
        const profileProblems = herbertProfileProblems(body, ukIsoDate(now));
        if (profileProblems.length > 0) throw problems.invalid(profileProblems.join(" "));
        if (body.photoDocumentId) {
          const [photo] = await tx
            .select({ id: document.id })
            .from(document)
            .where(
              and(
                eq(document.id, body.photoDocumentId),
                eq(document.personId, id),
                isNull(document.deletedAt),
              ),
            );
          if (!photo)
            throw problems.invalid("The photograph must be one of the person's documents.");
        }
        const values = {
          photoDocumentId: body.photoDocumentId,
          physicalDescription: body.physicalDescription,
          distinguishingFeatures: body.distinguishingFeatures,
          usualClothing: body.usualClothing,
          medicalNeeds: body.medicalNeeds,
          mobility: body.mobility,
          communication: body.communication,
          placesLikely: body.placesLikely,
          peopleLikely: body.peopleLikely,
          routines: body.routines,
          phoneOrTracker: body.phoneOrTracker,
          previousEpisodes: body.previousEpisodes,
          approach: body.approach,
          reviewedWith: body.reviewedWith,
          reviewedOn: body.reviewedOn,
          reviewedBy: access.tenantUserId,
        };
        const [current] = await tx
          .select()
          .from(herbertProfile)
          .where(and(eq(herbertProfile.personId, id), isNull(herbertProfile.deletedAt)))
          .for("update");
        if ((current?.version ?? 0) !== body.version) throw problems.conflict();
        const [saved] = current
          ? await tx
              .update(herbertProfile)
              .set(values)
              .where(
                and(eq(herbertProfile.id, current.id), eq(herbertProfile.version, body.version)),
              )
              .returning()
          : await tx
              .insert(herbertProfile)
              .values({ ...values, personId: id })
              .onConflictDoNothing({ target: [herbertProfile.tenantId, herbertProfile.personId] })
              .returning();
        if (!saved) throw problems.conflict();
        await finishHerbertReviewTasks(tx, saved.id, now);
        await audit(c, tx, access, {
          action: "safety.herbert.save",
          resourceType: "herbert_profile",
          resourceId: saved.id,
          scope: { personId: id },
        });
        return herbertView(tx, access.tenantId, id, now);
      });
      return c.json(view, 200);
    },
  );

async function herbertView(tx: Transaction, tenantId: string, personId: string, now: Date) {
  const [profile] = await tx
    .select()
    .from(herbertProfile)
    .where(and(eq(herbertProfile.personId, personId), isNull(herbertProfile.deletedAt)));
  const rates = await phase2Rates(tx, tenantId, ukIsoDate(now));
  const dueOn = profile
    ? herbertReviewDueOn(profile.reviewedOn, rates.herbertProtocolReviewMonths)
    : null;
  const prefill = await herbertPrefillFor(tx, personId);
  return {
    personId,
    profile: profile
      ? {
          id: profile.id,
          photoDocumentId: profile.photoDocumentId,
          physicalDescription: profile.physicalDescription,
          distinguishingFeatures: profile.distinguishingFeatures,
          usualClothing: profile.usualClothing,
          medicalNeeds: profile.medicalNeeds,
          mobility: profile.mobility,
          communication: profile.communication,
          placesLikely: profile.placesLikely,
          peopleLikely: profile.peopleLikely,
          routines: profile.routines,
          phoneOrTracker: profile.phoneOrTracker,
          previousEpisodes: profile.previousEpisodes,
          approach: profile.approach,
          reviewedWith: profile.reviewedWith,
          reviewedOn: profile.reviewedOn,
          reviewedBy: profile.reviewedBy,
          version: profile.version,
        }
      : null,
    // As the slice 7 rule reads it: out of date once the due day has begun.
    state: !dueOn
      ? ("none" as const)
      : dueOn <= ukIsoDate(now)
        ? ("out_of_date" as const)
        : ("current" as const),
    reviewDueOn: dueOn,
    prefill: { ...prefill, photoDocumentId: null, reviewedWith: null },
  };
}
