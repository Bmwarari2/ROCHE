import {
  CheckInItem,
  CheckInList,
  CheckInListQuery,
  EditPulseSurvey,
  MovePulseSurvey,
  NewCheckIn,
  NewPulseSurvey,
  NewRecognition,
  PulseResponse,
  PulseSurveyItem,
  PulseSurveyList,
  PulseSurveyListQuery,
  PulseSurveyResults,
  RecognitionItem,
  RecognitionList,
  RecognitionListQuery,
  ShareCheckIn,
} from "@harbour/contracts";
import {
  pulseSurvey,
  pulseSurveyParticipation,
  recognition,
  type Transaction,
  wellbeingCheckIn,
} from "@harbour/db";
import {
  can,
  checkCheckIn,
  checkRecognition,
  checkResponse,
  checkSurveyDefinition,
  checkSurveyMove,
  type Permission,
  type SurveyQuestion,
  type SurveyState,
  scopeFor,
  ukIsoDate,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Context } from "hono";
import { writeAudit } from "../http/audit";
import { type AppEnv, requirePermission, type TenantAccess, withTenant } from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";
import { audit, dbCode } from "./people-shared";

/**
 * Staff wellbeing and voice (scheduling.md section 16; SCHED-011). Covers pulse surveys, anonymous
 * responses, results above the minimum group size, recognition and wellbeing check-ins. The
 * database holds the same rules again (migration 0115). Responses are reached only through its
 * two definer functions. Audit events carry ids only, never an answer, a message, a mood or a
 * note. A response is audited with an anonymous actor and names the survey only.
 */

const MANAGE = "scheduling.wellbeing.manage" as const;
const SELF = "scheduling.wellbeing.self" as const;
const A = {
  created: "scheduling.pulse_survey.created",
  edited: "scheduling.pulse_survey.edited",
  opened: "scheduling.pulse_survey.opened",
  closed: "scheduling.pulse_survey.closed",
  results: "scheduling.pulse_survey.results_viewed",
  recognised: "scheduling.recognition.given",
  recognitionViewed: "scheduling.recognition.viewed",
  checkIn: "scheduling.wellbeing_check_in.recorded",
  shared: "scheduling.wellbeing_check_in.shared",
  unshared: "scheduling.wellbeing_check_in.unshared",
  checkInsViewed: "scheduling.wellbeing_check_in.viewed",
} as const;

/** Where to find support (H-1084: the organisation's own wording is a later setting). */
export const WELLBEING_SUPPORT =
  "If you need support, talk to your manager, someone you trust or your organisation's employee assistance service. If you or someone else is in danger, call 999.";

type SurveyRow = typeof pulseSurvey.$inferSelect;

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const stateConflict = (detail: string) => new HttpProblem(409, "invalid_state", detail);

/** Whether a permission reaches a home, or the whole organisation for `null`. */
function holdsAt(access: TenantAccess, permission: Permission, locationId: string | null): boolean {
  if (!can(access.effective, permission)) return false;
  const reach = scopeFor(access.effective, permission);
  if (reach.scope === "tenant") return true;
  return (
    locationId !== null && reach.scope === "locations" && reach.locationIds.includes(locationId)
  );
}

function surveyItem(row: SurveyRow, answered: boolean | null): z.infer<typeof PulseSurveyItem> {
  return {
    id: row.id,
    locationId: row.locationId,
    title: row.title,
    questions: row.questions as SurveyQuestion[],
    opensOn: row.opensOn,
    closesOn: row.closesOn,
    state: row.state as SurveyState,
    openedAt: iso(row.openedAt),
    closedAt: iso(row.closedAt),
    answered,
    version: row.version,
  };
}

const checkInItem = (r: typeof wellbeingCheckIn.$inferSelect): z.infer<typeof CheckInItem> => ({
  id: r.id,
  memberId: r.memberId,
  locationId: r.locationId,
  mood: r.mood,
  note: r.note,
  sharedAt: iso(r.sharedAt),
  createdAt: r.createdAt.toISOString(),
});

const recognitionItem = (r: typeof recognition.$inferSelect): z.infer<typeof RecognitionItem> => ({
  id: r.id,
  fromMemberId: r.fromMemberId,
  toMemberId: r.toMemberId,
  locationId: r.locationId,
  message: r.message,
  createdAt: r.createdAt.toISOString(),
});

const SURVEY_PROBLEMS: Readonly<Record<string, string>> = {
  no_questions: "Add at least one question.",
  too_many_questions: "A survey has 20 questions or fewer.",
  duplicate_question: "Each question needs its own id.",
  question_text_required: "Every question needs words.",
  question_text_too_long: "Keep each question to 300 characters or fewer.",
  closes_before_opens: "The survey must close on or after the day it opens.",
};

const RESPONSE_PROBLEMS: Readonly<Record<string, string>> = {
  nothing_answered: "Answer at least one question.",
  unknown_question: "An answer is for a question this survey does not have.",
  scale_out_of_range: "Choose a whole number from 1 to 5.",
  free_text_empty: "A written answer cannot be blank.",
  free_text_too_long: "Keep a written answer to 2,000 characters or fewer.",
  wrong_kind: "An answer does not match its question.",
};

/** Runs a change; a refusal by the database is audited (ids only) and answered plainly. */
async function change<T>(
  c: Context<AppEnv>,
  access: TenantAccess,
  what: { action: string; resourceType: string; id: string | null },
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  try {
    return await withTenant(c, fn);
  } catch (error) {
    const code = dbCode(error);
    if (!code || !["42501", "23503", "23505", "23514"].includes(code)) throw error;
    await writeAudit(c.get("services").appPool, access, {
      action: what.action,
      outcome: "denied",
      resourceType: what.resourceType,
      ...(what.id ? { resourceId: what.id } : {}),
      reason: code === "42501" ? "refused_by_database" : "invalid_state",
      requestId: c.get("requestId"),
    });
    if (code === "42501") throw problems.forbidden();
    if (code === "23503") throw problems.invalid("A home or member named was not found.");
    throw stateConflict("This cannot be changed like that now. Reload it and try again.");
  }
}

async function findSurvey(tx: Transaction, id: string): Promise<SurveyRow | undefined> {
  const [row] = await tx
    .select()
    .from(pulseSurvey)
    .where(and(eq(pulseSurvey.id, id), isNull(pulseSurvey.deletedAt)));
  return row;
}

const idParam = z.object({ id: z.uuid() });

async function moveSurvey(
  c: Context<AppEnv>,
  id: string,
  version: number,
  to: "open" | "closed",
): Promise<z.infer<typeof PulseSurveyItem>> {
  const access = await requirePermission(c, MANAGE);
  const action = to === "open" ? A.opened : A.closed;
  return change(c, access, { action, resourceType: "pulse_survey", id }, async (tx) => {
    const row = await findSurvey(tx, id);
    if (!row || !holdsAt(access, MANAGE, row.locationId)) throw problems.notFound();
    if (row.version !== version) throw problems.conflict();
    if (checkSurveyMove(row.state as SurveyState, to)) {
      throw stateConflict(
        to === "open" ? "Only a draft can be opened." : "Only an open survey can be closed.",
      );
    }
    const [updated] = await tx
      .update(pulseSurvey)
      .set({ state: to })
      .where(and(eq(pulseSurvey.id, id), eq(pulseSurvey.version, version)))
      .returning();
    if (!updated) throw problems.conflict();
    await audit(c, tx, access, { action, resourceType: "pulse_survey", resourceId: id });
    return surveyItem(updated, null);
  });
}

export const wellbeingRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/pulse-surveys",
      tags: ["scheduling"],
      summary: "Staff pulse surveys",
      description:
        "`view=answer` (default, scheduling.wellbeing.self): the open surveys the member may answer, with whether they already have. `view=manage` (scheduling.wellbeing.manage): every survey at the homes the reader manages.",
      security,
      request: { query: PulseSurveyListQuery },
      responses: { 200: jsonBody(PulseSurveyList, "Surveys"), ...errorResponses },
    }),
    async (c) => {
      const { view } = c.req.valid("query");
      if (view === "manage") {
        const access = await requirePermission(c, MANAGE);
        const items = await withTenant(c, async (tx) => {
          const rows = await tx
            .select()
            .from(pulseSurvey)
            .where(isNull(pulseSurvey.deletedAt))
            .orderBy(desc(pulseSurvey.createdAt));
          return rows
            .filter((r) => holdsAt(access, MANAGE, r.locationId))
            .map((r) => surveyItem(r, null));
        });
        return c.json({ items }, 200);
      }
      const access = await requirePermission(c, SELF);
      const today = ukIsoDate(new Date());
      const items = await withTenant(c, async (tx) => {
        const rows = await tx
          .select()
          .from(pulseSurvey)
          .where(
            and(
              isNull(pulseSurvey.deletedAt),
              eq(pulseSurvey.state, "open"),
              sql`${pulseSurvey.opensOn} <= ${today}::date AND ${pulseSurvey.closesOn} >= ${today}::date`,
              // The surveys a member may answer: the organisation's, or their home's.
              sql`(${pulseSurvey.locationId} IS NULL OR app.works_at(app.current_user_id(), ${pulseSurvey.locationId}))`,
            ),
          )
          .orderBy(pulseSurvey.closesOn);
        const ids = rows.map((r) => r.id);
        const taken =
          ids.length === 0
            ? []
            : await tx
                .select({ surveyId: pulseSurveyParticipation.surveyId })
                .from(pulseSurveyParticipation)
                .where(
                  and(
                    inArray(pulseSurveyParticipation.surveyId, ids),
                    eq(pulseSurveyParticipation.memberId, access.tenantUserId),
                  ),
                );
        const done = new Set(taken.map((t) => t.surveyId));
        return rows.map((r) => surveyItem(r, done.has(r.id)));
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/pulse-surveys",
      tags: ["scheduling"],
      summary: "Write a pulse survey (a draft)",
      description:
        "scheduling.wellbeing.manage at the home, or across the organisation for an organisation survey (locationId null). Audited.",
      security,
      request: { body: { content: { "application/json": { schema: NewPulseSurvey } } } },
      responses: { 201: jsonBody(PulseSurveyItem, "Written"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const body = c.req.valid("json");
      if (!holdsAt(access, MANAGE, body.locationId)) throw problems.forbidden();
      const problem = checkSurveyDefinition(body);
      if (problem) throw problems.invalid(SURVEY_PROBLEMS[problem] ?? problem);
      const item = await change(
        c,
        access,
        { action: A.created, resourceType: "pulse_survey", id: null },
        async (tx) => {
          const [row] = await tx
            .insert(pulseSurvey)
            .values({
              locationId: body.locationId,
              title: body.title,
              questions: body.questions,
              opensOn: body.opensOn,
              closesOn: body.closesOn,
            })
            .returning();
          if (!row) throw new Error("survey not stored");
          await audit(c, tx, access, {
            action: A.created,
            resourceType: "pulse_survey",
            resourceId: row.id,
            scope: { locationId: row.locationId },
          });
          return surveyItem(row, null);
        },
      );
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/v1/pulse-surveys/{id}",
      tags: ["scheduling"],
      summary: "Change a draft survey",
      description:
        "scheduling.wellbeing.manage where it applies, against `version`. A survey is fixed once it opens. Audited.",
      security,
      request: {
        params: idParam,
        body: { content: { "application/json": { schema: EditPulseSurvey } } },
      },
      responses: {
        200: jsonBody(PulseSurveyItem, "Changed"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const problem = checkSurveyDefinition(body);
      if (problem) throw problems.invalid(SURVEY_PROBLEMS[problem] ?? problem);
      const item = await change(
        c,
        access,
        { action: A.edited, resourceType: "pulse_survey", id },
        async (tx) => {
          const row = await findSurvey(tx, id);
          if (!row || !holdsAt(access, MANAGE, row.locationId)) throw problems.notFound();
          if (row.version !== body.version) throw problems.conflict();
          if (row.state !== "draft") throw stateConflict("A survey is fixed once it opens.");
          const [updated] = await tx
            .update(pulseSurvey)
            .set({
              title: body.title,
              questions: body.questions,
              opensOn: body.opensOn,
              closesOn: body.closesOn,
            })
            .where(and(eq(pulseSurvey.id, id), eq(pulseSurvey.version, body.version)))
            .returning();
          if (!updated) throw problems.conflict();
          await audit(c, tx, access, {
            action: A.edited,
            resourceType: "pulse_survey",
            resourceId: id,
          });
          return surveyItem(updated, null);
        },
      );
      return c.json(item, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/pulse-surveys/{id}/open",
      tags: ["scheduling"],
      summary: "Open a draft survey",
      description: "scheduling.wellbeing.manage where it applies, against `version`. Audited.",
      security,
      request: {
        params: idParam,
        body: { content: { "application/json": { schema: MovePulseSurvey } } },
      },
      responses: {
        200: jsonBody(PulseSurveyItem, "Opened"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) =>
      c.json(
        await moveSurvey(c, c.req.valid("param").id, c.req.valid("json").version, "open"),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/pulse-surveys/{id}/close",
      tags: ["scheduling"],
      summary: "Close an open survey",
      description:
        "scheduling.wellbeing.manage where it applies, against `version`. Results show only once it has closed. Audited.",
      security,
      request: {
        params: idParam,
        body: { content: { "application/json": { schema: MovePulseSurvey } } },
      },
      responses: {
        200: jsonBody(PulseSurveyItem, "Closed"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) =>
      c.json(
        await moveSurvey(c, c.req.valid("param").id, c.req.valid("json").version, "closed"),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/pulse-surveys/{id}/responses",
      tags: ["scheduling"],
      summary: "Answer a survey, anonymously",
      description:
        "scheduling.wellbeing.self, once, while the survey is open, for a member on a staff file at its home from before it opened, never its writer or its home's survey managers. The response keeps no member and no time but the UK week, waits apart until the survey closes and nothing comes back. Each response is audited when the survey closes, with an anonymous actor, naming the survey only.",
      security,
      request: {
        params: idParam,
        body: { content: { "application/json": { schema: PulseResponse } } },
      },
      responses: {
        204: { description: "Answered" },
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      await requirePermission(c, SELF);
      const { id } = c.req.valid("param");
      const { answers } = c.req.valid("json");
      await withTenant(c, async (tx) => {
        const row = await findSurvey(tx, id);
        if (!row || row.state === "draft") throw problems.notFound();
        const problem = checkResponse(row.questions as SurveyQuestion[], answers);
        if (problem) throw problems.invalid(RESPONSE_PROBLEMS[problem] ?? problem);
        try {
          await tx.execute(
            sql`SELECT app.submit_pulse_response(${id}::uuid, ${JSON.stringify(answers)}::jsonb)`,
          );
        } catch (error) {
          const message = (error as { cause?: { message?: string }; message?: string }).cause
            ?.message;
          if (message === "pulse_survey_not_found") throw problems.notFound();
          if (message === "pulse_already_answered") {
            throw stateConflict("You have already answered this survey.");
          }
          if (message === "pulse_survey_not_open") {
            throw stateConflict("This survey is not taking answers now.");
          }
          if (message === "pulse_response_invalid") throw problems.invalid("Check your answers.");
          if (message === "pulse_response_not_allowed") throw problems.forbidden();
          if (message === "pulse_response_not_eligible") {
            throw new HttpProblem(
              403,
              "pulse_not_eligible",
              "This survey is for the staff on its home's staff files when it opened, not for the people who run it.",
            );
          }
          throw error;
        }
        // No audit event here: one anonymous event per response is written when the survey
        // closes, so the audit never shows answers arriving (rule 3; migration 0115).
      });
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/pulse-surveys/{id}/results",
      tags: ["scheduling"],
      summary: "A survey's results, above the minimum group size",
      description:
        "scheduling.wellbeing.manage where it applies. Only once closed and only when at least the minimum group size (`wellbeing.survey_min_group_size`) answered; each question only when that many answered it. Never a count below the size, never a single response. Audited.",
      security,
      request: { params: idParam },
      responses: {
        200: jsonBody(PulseSurveyResults, "Results"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const result = await withTenant(c, async (tx) => {
        let raw: Omit<z.infer<typeof PulseSurveyResults>, "message">;
        try {
          const { rows } = await tx.execute<{ r: typeof raw }>(
            sql`SELECT app.pulse_survey_results(${id}::uuid) AS r`,
          );
          raw = rows[0]?.r as typeof raw;
        } catch (error) {
          if (
            (error as { cause?: { message?: string } }).cause?.message === "pulse_survey_not_found"
          ) {
            throw problems.notFound();
          }
          throw error;
        }
        await audit(c, tx, access, {
          action: A.results,
          resourceType: "pulse_survey",
          resourceId: id,
          scope: { visible: raw.visible },
        });
        const size = raw.minGroupSize === null ? null : Number(raw.minGroupSize);
        const message = raw.visible
          ? "These are everyone's answers together. Nobody's own answers are shown."
          : raw.reason === "still_open"
            ? "Results show once the survey has closed."
            : raw.reason === "no_size"
              ? "Results cannot show: no minimum group size is set."
              : `Fewer than ${size} people answered, so the results are not shown.`;
        return { ...raw, minGroupSize: size, message };
      });
      return c.json(result, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/recognition",
      tags: ["scheduling"],
      summary: "Thanks between colleagues",
      description:
        "`mine=received` or `mine=sent` (scheduling.wellbeing.self): the member's own. `locationId` (scheduling.wellbeing.manage there): the thanks to members at that home. Audited for a manager's view.",
      security,
      request: { query: RecognitionListQuery },
      responses: { 200: jsonBody(RecognitionList, "Thanks"), ...errorResponses },
    }),
    async (c) => {
      const q = c.req.valid("query");
      if (q.locationId) {
        const locationId = q.locationId;
        const access = await requirePermission(c, MANAGE);
        if (!holdsAt(access, MANAGE, locationId)) throw problems.forbidden();
        const items = await withTenant(c, async (tx) => {
          const rows = await tx
            .select()
            .from(recognition)
            .where(eq(recognition.locationId, locationId))
            .orderBy(desc(recognition.createdAt))
            .limit(500);
          await audit(c, tx, access, {
            action: A.recognitionViewed,
            resourceType: "recognition",
            scope: { locationId, count: rows.length },
          });
          return rows.map(recognitionItem);
        });
        return c.json({ items }, 200);
      }
      const access = await requirePermission(c, SELF);
      const items = await withTenant(c, async (tx) => {
        const rows = await tx
          .select()
          .from(recognition)
          .where(
            q.mine === "sent"
              ? eq(recognition.fromMemberId, access.tenantUserId)
              : eq(recognition.toMemberId, access.tenantUserId),
          )
          .orderBy(desc(recognition.createdAt))
          .limit(500);
        return rows.map(recognitionItem);
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/recognition",
      tags: ["scheduling"],
      summary: "Thank a colleague",
      description:
        "scheduling.wellbeing.self. Never oneself; the colleague must work at the home named. Audited with ids only.",
      security,
      request: { body: { content: { "application/json": { schema: NewRecognition } } } },
      responses: { 201: jsonBody(RecognitionItem, "Given"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, SELF);
      const body = c.req.valid("json");
      const problem = checkRecognition({ fromMemberId: access.tenantUserId, ...body });
      if (problem === "to_self") throw problems.invalid("Thank a colleague, not yourself.");
      if (problem) throw problems.invalid("Write a message of 500 characters or fewer.");
      const item = await withTenant(c, async (tx) => {
        const [works] = (
          await tx.execute<{ ok: boolean }>(
            sql`SELECT app.works_at(${body.toMemberId}::uuid, ${body.locationId}::uuid) AS ok`,
          )
        ).rows;
        // The same words whatever the reason, so the route never says where someone works.
        if (!works?.ok)
          throw problems.invalid("We could not send that. Check the colleague and the home.");
        const [row] = await tx
          .insert(recognition)
          .values({
            fromMemberId: access.tenantUserId,
            toMemberId: body.toMemberId,
            locationId: body.locationId,
            message: body.message,
          })
          .returning();
        if (!row) throw new Error("recognition not stored");
        await audit(c, tx, access, {
          action: A.recognised,
          resourceType: "recognition",
          resourceId: row.id,
          scope: { toMemberId: row.toMemberId, locationId: row.locationId },
        });
        return recognitionItem(row);
      });
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/wellbeing-check-ins",
      tags: ["scheduling"],
      summary: "Wellbeing check-ins",
      description:
        "Without `locationId` (scheduling.wellbeing.self): the member's own. With it (scheduling.wellbeing.manage there): only the check-ins members at that home share, the view audited with their ids.",
      security,
      request: { query: CheckInListQuery },
      responses: { 200: jsonBody(CheckInList, "Check-ins"), ...errorResponses },
    }),
    async (c) => {
      const { locationId } = c.req.valid("query");
      if (locationId) {
        const access = await requirePermission(c, MANAGE);
        if (!holdsAt(access, MANAGE, locationId)) throw problems.forbidden();
        const items = await withTenant(c, async (tx) => {
          const rows = await tx
            .select()
            .from(wellbeingCheckIn)
            .where(
              and(
                eq(wellbeingCheckIn.locationId, locationId),
                isNotNull(wellbeingCheckIn.sharedAt),
                sql`${wellbeingCheckIn.memberId} <> ${access.tenantUserId}`,
              ),
            )
            .orderBy(desc(wellbeingCheckIn.createdAt))
            .limit(500);
          await audit(c, tx, access, {
            action: A.checkInsViewed,
            resourceType: "wellbeing_check_in",
            scope: { locationId, ids: rows.map((r) => r.id) },
          });
          return rows.map(checkInItem);
        });
        return c.json({ items, support: WELLBEING_SUPPORT }, 200);
      }
      const access = await requirePermission(c, SELF);
      const items = await withTenant(c, async (tx) =>
        (
          await tx
            .select()
            .from(wellbeingCheckIn)
            .where(eq(wellbeingCheckIn.memberId, access.tenantUserId))
            .orderBy(desc(wellbeingCheckIn.createdAt))
            .limit(500)
        ).map(checkInItem),
      );
      return c.json({ items, support: WELLBEING_SUPPORT }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/wellbeing-check-ins",
      tags: ["scheduling"],
      summary: "Record your own check-in",
      description:
        "scheduling.wellbeing.self, at a home where the member works. Private unless `share` is true. Audited with ids only.",
      security,
      request: { body: { content: { "application/json": { schema: NewCheckIn } } } },
      responses: { 201: jsonBody(CheckInItem, "Recorded"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, SELF);
      const body = c.req.valid("json");
      if (checkCheckIn({ mood: body.mood, note: body.note })) {
        throw problems.invalid(
          "Choose how you are from 1 to 5, with a note of 1,000 characters or fewer.",
        );
      }
      const item = await change(
        c,
        access,
        { action: A.checkIn, resourceType: "wellbeing_check_in", id: null },
        async (tx) => {
          const [row] = await tx
            .insert(wellbeingCheckIn)
            .values({
              memberId: access.tenantUserId,
              locationId: body.locationId,
              mood: body.mood,
              note: body.note,
              sharedAt: body.share ? new Date() : null,
            })
            .returning();
          if (!row) throw new Error("check-in not stored");
          await audit(c, tx, access, {
            action: A.checkIn,
            resourceType: "wellbeing_check_in",
            resourceId: row.id,
            scope: { shared: row.sharedAt !== null },
          });
          return checkInItem(row);
        },
      );
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/wellbeing-check-ins/{id}/sharing",
      tags: ["scheduling"],
      summary: "Share a check-in with your manager, or stop sharing it",
      description:
        "scheduling.wellbeing.self, the member's own check-in only. Stopping hides it from managers again. Audited.",
      security,
      request: {
        params: idParam,
        body: { content: { "application/json": { schema: ShareCheckIn } } },
      },
      responses: { 200: jsonBody(CheckInItem, "Changed"), ...errorResponses, ...notFoundResponse },
    }),
    async (c) => {
      const access = await requirePermission(c, SELF);
      const { id } = c.req.valid("param");
      const { shared } = c.req.valid("json");
      const item = await withTenant(c, async (tx) => {
        const [row] = await tx
          .update(wellbeingCheckIn)
          .set({ sharedAt: shared ? new Date() : null })
          .where(
            and(eq(wellbeingCheckIn.id, id), eq(wellbeingCheckIn.memberId, access.tenantUserId)),
          )
          .returning();
        if (!row) throw problems.notFound();
        await audit(c, tx, access, {
          action: shared ? A.shared : A.unshared,
          resourceType: "wellbeing_check_in",
          resourceId: id,
        });
        return checkInItem(row);
      });
      return c.json(item, 200);
    },
  );
