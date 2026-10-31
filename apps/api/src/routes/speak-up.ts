import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  AnonymousSpeakUpRaised,
  AnonymousSpeakUpReply,
  PostSpeakUpMessage,
  ProblemDetails,
  RaiseAnonymousSpeakUp,
  RaiseSpeakUp,
  SetSpeakUpMembers,
  type SpeakUpCase,
  SpeakUpCaseDetail,
  SpeakUpCaseList,
  type SpeakUpMessage,
  SpeakUpStep,
  type SpeakUpThread,
  SpeakUpThreadList,
  SpeakUpThread as SpeakUpThreadSchema,
  SpeakUpTokenRequest,
} from "@harbour/contracts";
import {
  auditEvent,
  speakUpCaseMember,
  speakUpConcern,
  speakUpMessage,
  speakUpReporter,
  type Transaction,
  tenant,
  tenantUser,
  withRequestContext,
} from "@harbour/db";
import {
  can,
  checkWorkflowTransition,
  SPEAK_UP_WORKFLOW,
  type SpeakUpIdentity,
  type SpeakUpState,
  speakUpCloseProblems,
  ukIsoDate,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Context } from "hono";
import { auditInTx } from "../http/audit";
import {
  type AppEnv,
  mfaRefusal,
  requirePermission,
  type TenantAccess,
  withTenant,
} from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { throttleAddress } from "../http/throttle";
import { type StaffLookup, staffNames } from "../services/staff";
import { createRouter, errorResponses, jsonBody, notFoundResponse, security } from "./openapi";

/**
 * Whistleblowing and speaking up (Phase 2 slice 24; safety.md Phase 2 rule 3; SAFE-012; ADR-0089).
 * The silo: row-level security (migration 0086) opens a concern to the Freedom to Speak Up lead
 * (`safety.speak_up.manage`, which no wider role holds), the members the lead names on the case,
 * and whoever raised a named or confidential concern; these routes check the same again.
 *
 * Nothing here records who raised a concern: the concern's creator columns stay empty, its audit
 * names no actor, IP address or device (`siloAudit`), and no outbox event is published for it. An
 * anonymous concern arrives on a public route with no session; its reporter may take a reply token
 * (256 random bits, shown once, stored only as its SHA-256, sent only in request bodies). Public
 * requests are throttled in memory by a hash of the address, never stored.
 */

const LEAD = "safety.speak_up.manage" as const;
const IdParam = z.object({ id: z.uuid() });
const TenantParam = z.object({ tenantId: z.uuid() });
type ConcernRow = typeof speakUpConcern.$inferSelect;

const iso = (d: Date | null) => d?.toISOString() ?? null;
const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * An audit event that names no one: no actor, IP address, device, request id or scope beyond the
 * kind of actor, so it can never point at whoever raised or replied to a concern (ADR-0089).
 */
async function siloAudit(
  tx: Transaction,
  tenantId: string,
  input: { action: string; concernId: string; actor: "anonymous" | "reporter" },
): Promise<void> {
  await tx.insert(auditEvent).values({
    tenantId,
    actorTenantUserId: null,
    actorAuthUserId: null,
    actorRoleKeys: null,
    action: input.action,
    outcome: "success",
    resourceType: "speak_up_concern",
    resourceId: input.concernId,
    scope: { actor: input.actor },
    ip: null,
    deviceId: null,
    requestId: null,
    reason: null,
    beforeHash: null,
    afterHash: null,
  });
}

/** A lead's or member's action: audited as theirs, as any other staff action is. */
function staffAudit(
  c: Context<AppEnv>,
  tx: Transaction,
  access: TenantAccess,
  action: string,
  concernId: string,
) {
  return auditInTx(tx, access, {
    action,
    resourceType: "speak_up_concern",
    resourceId: concernId,
    requestId: c.get("requestId"),
  });
}

function identityOf(row: ConcernRow): SpeakUpIdentity {
  return row.identity === "anonymous"
    ? { kind: "anonymous", replyTokenHash: row.replyTokenHash }
    : // Who it is is never needed here: canReply and the close rule read the kind only.
      { kind: row.identity as "named" | "confidential", tenantUserId: "" };
}

const canReplyTo = (row: ConcernRow) => row.identity !== "anonymous" || row.replyTokenHash !== null;

async function messagesOf(
  tx: Transaction,
  concernId: string,
  forReporter: boolean,
): Promise<SpeakUpMessage[]> {
  const rows = await tx
    .select()
    .from(speakUpMessage)
    .where(eq(speakUpMessage.concernId, concernId))
    .orderBy(asc(speakUpMessage.createdAt), asc(speakUpMessage.id));
  const staff = forReporter
    ? null
    : await staffNames(
        tx,
        rows.map((r) => r.authorTenantUserId),
      );
  return rows.map((r) => ({
    id: r.id,
    fromReporter: r.fromReporter,
    // Whoever raised it is told what the lead or the case says, never which member said it.
    author: staff ? staff(r.authorTenantUserId) : null,
    body: r.body,
    createdAt: r.createdAt.toISOString(),
  }));
}

async function threadOf(tx: Transaction, row: ConcernRow): Promise<SpeakUpThread> {
  return {
    id: row.id,
    identity: row.identity as SpeakUpThread["identity"],
    category: row.category as SpeakUpThread["category"],
    summary: row.summary,
    receivedOn: row.receivedOn,
    state: row.state as SpeakUpThread["state"],
    outcome: row.outcomeSharedAt ? row.outcome : null,
    messages: await messagesOf(tx, row.id, true),
  };
}

/** Concerns the reader sees as the lead or as a member named on the case (not as its reporter). */
const caseVisible = sql`(app.speak_up_lead() OR app.speak_up_member(${speakUpConcern.id}))`;

function movesFor(access: TenantAccess, row: ConcernRow): SpeakUpState[] {
  if (!can(access.effective, LEAD)) return [];
  const state = row.state as SpeakUpState;
  if (SPEAK_UP_WORKFLOW.terminal.includes(state)) return [];
  return SPEAK_UP_WORKFLOW.transitions
    .filter((t) => (Array.isArray(t.from) ? t.from : [t.from]).includes(state))
    .map((t) => t.to)
    .filter((to) => to !== "outcome_shared" || canReplyTo(row));
}

async function casesOut(
  tx: Transaction,
  access: TenantAccess,
  rows: readonly ConcernRow[],
): Promise<SpeakUpCase[]> {
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return [];
  // Row-level security decides whose identity the reader sees: the lead's, and members' when named.
  const reporters = await tx
    .select({ concernId: speakUpReporter.concernId, id: speakUpReporter.tenantUserId })
    .from(speakUpReporter)
    .where(inArray(speakUpReporter.concernId, ids));
  const members = await tx
    .select({ concernId: speakUpCaseMember.concernId, id: speakUpCaseMember.tenantUserId })
    .from(speakUpCaseMember)
    .where(and(inArray(speakUpCaseMember.concernId, ids), isNull(speakUpCaseMember.removedAt)));
  const staff: StaffLookup = await staffNames(tx, [
    ...reporters.map((r) => r.id),
    ...members.map((m) => m.id),
  ]);
  return rows.map((row) => ({
    id: row.id,
    identity: row.identity as SpeakUpCase["identity"],
    category: row.category as SpeakUpCase["category"],
    summary: row.summary,
    receivedOn: row.receivedOn,
    state: row.state as SpeakUpCase["state"],
    acknowledgedAt: iso(row.acknowledgedAt),
    outcome: row.outcome,
    outcomeSharedAt: iso(row.outcomeSharedAt),
    closedReason: row.closedReason,
    closedAt: iso(row.closedAt),
    canReply: canReplyTo(row),
    reporter: staff(reporters.find((r) => r.concernId === row.id)?.id),
    members: members.flatMap((m) => {
      const name = m.concernId === row.id ? staff(m.id) : null;
      return name ? [name] : [];
    }),
    moves: movesFor(access, row),
    version: row.version,
  }));
}

/**
 * The lead or a case member reading the silo: the lead's permission requires its MFA as usual, and
 * a member reading a case needs MFA too (the case may be about care).
 */
async function caseReader(c: Context<AppEnv>): Promise<TenantAccess> {
  const access = c.get("access");
  if (can(access.effective, LEAD)) return requirePermission(c, LEAD);
  if (!access.mfaSatisfied) throw mfaRefusal(access);
  return access;
}

async function loadCase(tx: Transaction, id: string, version?: number): Promise<ConcernRow> {
  const [row] = await tx
    .select()
    .from(speakUpConcern)
    .where(and(eq(speakUpConcern.id, id), isNull(speakUpConcern.deletedAt), caseVisible));
  if (!row) throw problems.notFound();
  if (version !== undefined && row.version !== version) throw problems.conflict();
  return row;
}

async function loadMine(tx: Transaction, access: TenantAccess, id?: string): Promise<ConcernRow[]> {
  const rows = await tx
    .select({ concern: speakUpConcern })
    .from(speakUpConcern)
    .innerJoin(speakUpReporter, eq(speakUpReporter.concernId, speakUpConcern.id))
    .where(
      and(
        eq(speakUpReporter.tenantUserId, access.tenantUserId),
        isNull(speakUpConcern.deletedAt),
        id ? eq(speakUpConcern.id, id) : undefined,
      ),
    )
    .orderBy(desc(speakUpConcern.receivedOn), desc(speakUpConcern.createdAt))
    .limit(200);
  return rows.map((r) => r.concern);
}

// ---- Public routes (no session) ---------------------------------------------------------------

const problem = (description: string) => ({
  content: { "application/problem+json": { schema: ProblemDetails } },
  description,
});
const publicErrors = {
  404: problem("No such organisation, or no concern for that reply token"),
  409: problem("The concern is closed"),
  422: problem("The request did not validate"),
  429: problem("Too many requests; wait as Retry-After says"),
} as const;

/** Throttled by a hash of the client address, in this instance's memory only (never stored). */
function throttlePublic(c: Context<AppEnv>): void {
  const services = c.get("services");
  const address = throttleAddress(c.req.header("x-forwarded-for"), services.config.trustedProxies);
  const wait = services.speakUpThrottle.take(hashOf(`speak-up:${address ?? "unknown"}`));
  if (wait === null) return;
  const limited = new HttpProblem(
    429,
    "rate_limited",
    "Too many attempts. Wait a moment and try again.",
  );
  limited.retryAfterSeconds = wait;
  throw limited;
}

/** A public request in the organisation, as a reply token's holder or as no one. */
function asPublic<T>(
  c: Context<AppEnv>,
  tenantId: string,
  replyTokenHash: string | null,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return withRequestContext(
    c.get("services").db,
    { tenantId, userId: null, scope: "none", locationIds: [], speakUp: { replyTokenHash } },
    fn,
  );
}

async function concernByToken(tx: Transaction, hash: string): Promise<ConcernRow> {
  const [row] = await tx
    .select()
    .from(speakUpConcern)
    .where(and(eq(speakUpConcern.replyTokenHash, hash), isNull(speakUpConcern.deletedAt)));
  if (!row) throw problems.notFound();
  return row;
}

const closedProblem = () =>
  new HttpProblem(409, "speak_up_closed", "This concern is closed, so it takes no more messages.");

export const speakUpRouter = createRouter()
  .openapi(
    createRoute({
      method: "post",
      path: "/p/speak-up/{tenantId}",
      tags: ["safety"],
      summary: "Raise a concern anonymously (no sign-in)",
      description:
        "No session, so no device, session or member is recorded. Stores no identity, creator or IP address; the audit names no actor; no event is published. With wantsReplies the response holds a reply token once: keep it to read replies and reply. Throttled per client address in memory.",
      request: {
        params: TenantParam,
        body: { content: { "application/json": { schema: RaiseAnonymousSpeakUp } } },
      },
      responses: { 201: jsonBody(AnonymousSpeakUpRaised, "Raised"), ...publicErrors },
    }),
    async (c) => {
      throttlePublic(c);
      const { tenantId } = c.req.valid("param");
      const body = c.req.valid("json");
      const replyToken = body.wantsReplies ? randomBytes(32).toString("base64url") : null;
      const replyTokenHash = replyToken ? hashOf(replyToken) : null;
      const id = randomUUID();
      const receivedOn = ukIsoDate(new Date());
      await asPublic(c, tenantId, null, async (tx) => {
        // Only an organisation that exists and is live takes concerns (the table has no tenant key).
        const [live] = await tx
          .select({ id: tenant.id })
          .from(tenant)
          .where(and(eq(tenant.id, tenantId), eq(tenant.status, "active")));
        if (!live) throw problems.notFound();
        // A client id, never RETURNING: the request may not read the concern back (migration 0086).
        await tx.insert(speakUpConcern).values({
          id,
          identity: "anonymous",
          category: body.category,
          summary: body.summary,
          receivedOn,
          replyTokenHash,
          createdBy: null,
          updatedBy: null,
        });
        await siloAudit(tx, tenantId, {
          action: "safety.speak_up.raise",
          concernId: id,
          actor: "anonymous",
        });
      });
      return c.json({ receivedOn, replyToken }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/p/speak-up/{tenantId}/thread",
      tags: ["safety"],
      summary: "Read an anonymous concern and its replies with its reply token",
      description: "No sign-in. The token goes in the body, never a URL. Throttled.",
      request: {
        params: TenantParam,
        body: { content: { "application/json": { schema: SpeakUpTokenRequest } } },
      },
      responses: { 200: jsonBody(SpeakUpThreadSchema, "The concern"), ...publicErrors },
    }),
    async (c) => {
      throttlePublic(c);
      const { tenantId } = c.req.valid("param");
      const hash = hashOf(c.req.valid("json").replyToken);
      const thread = await asPublic(c, tenantId, hash, async (tx) => {
        const row = await concernByToken(tx, hash);
        await siloAudit(tx, tenantId, {
          action: "safety.speak_up.thread_view",
          concernId: row.id,
          actor: "anonymous",
        });
        return threadOf(tx, row);
      });
      return c.json(thread, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/p/speak-up/{tenantId}/messages",
      tags: ["safety"],
      summary: "Reply on an anonymous concern with its reply token",
      description: "No sign-in. The token goes in the body. Audited with no actor. Throttled.",
      request: {
        params: TenantParam,
        body: { content: { "application/json": { schema: AnonymousSpeakUpReply } } },
      },
      responses: { 200: jsonBody(SpeakUpThreadSchema, "The concern"), ...publicErrors },
    }),
    async (c) => {
      throttlePublic(c);
      const { tenantId } = c.req.valid("param");
      const body = c.req.valid("json");
      const hash = hashOf(body.replyToken);
      const thread = await asPublic(c, tenantId, hash, async (tx) => {
        const row = await concernByToken(tx, hash);
        if (row.state === "closed") throw closedProblem();
        await tx.insert(speakUpMessage).values({
          concernId: row.id,
          fromReporter: true,
          authorTenantUserId: null,
          body: body.body,
        });
        await siloAudit(tx, tenantId, {
          action: "safety.speak_up.reporter_message",
          concernId: row.id,
          actor: "anonymous",
        });
        return threadOf(tx, row);
      });
      return c.json(thread, 200);
    },
  )
  // ---- A member raising and following their own concern ------------------------------------
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/speak-up",
      tags: ["safety"],
      summary: "Raise a named or confidential concern",
      description:
        "Any member. Named: the lead and the members named on the case know who raised it. Confidential: only the lead knows. The concern stores no creator; who raised it is kept only where those people can read it; the audit names no actor, IP address or device; no event is published.",
      security,
      request: { body: { content: { "application/json": { schema: RaiseSpeakUp } } } },
      responses: { 201: jsonBody(SpeakUpThreadSchema, "Raised"), ...errorResponses },
    }),
    async (c) => {
      const access = c.get("access");
      const body = c.req.valid("json");
      const id = body.id ?? randomUUID();
      const thread = await withTenant(c, async (tx) => {
        const inserted = await tx
          .insert(speakUpConcern)
          .values({
            id,
            identity: body.identity,
            category: body.category,
            summary: body.summary,
            receivedOn: ukIsoDate(new Date()),
            createdBy: null,
            updatedBy: null,
          })
          .onConflictDoNothing();
        if ((inserted.rowCount ?? 0) === 0) throw problems.conflict();
        // In the same transaction: the database lets a member claim only a concern made in it.
        await tx
          .insert(speakUpReporter)
          .values({ concernId: id, tenantUserId: access.tenantUserId });
        await siloAudit(tx, access.tenantId, {
          action: "safety.speak_up.raise",
          concernId: id,
          actor: "reporter",
        });
        const [row] = await loadMine(tx, access, id);
        if (!row) throw problems.notFound();
        return threadOf(tx, row);
      });
      return c.json(thread, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/speak-up/mine",
      tags: ["safety"],
      summary: "The concerns you raised with your name known, and their replies",
      security,
      responses: { 200: jsonBody(SpeakUpThreadList, "Your concerns"), ...errorResponses },
    }),
    async (c) => {
      const access = c.get("access");
      const items = await withTenant(c, async (tx) => {
        const rows = await loadMine(tx, access);
        const out: SpeakUpThread[] = [];
        for (const row of rows) out.push(await threadOf(tx, row));
        return out;
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/speak-up/mine/{id}/messages",
      tags: ["safety"],
      summary: "Reply on a concern you raised",
      description: "Audited with no actor, IP address or device.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: PostSpeakUpMessage } } },
      },
      responses: {
        200: jsonBody(SpeakUpThreadSchema, "The concern"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = c.get("access");
      const { id } = c.req.valid("param");
      const { body } = c.req.valid("json");
      const thread = await withTenant(c, async (tx) => {
        const [row] = await loadMine(tx, access, id);
        if (!row) throw problems.notFound();
        if (row.state === "closed") throw closedProblem();
        await tx
          .insert(speakUpMessage)
          .values({ concernId: id, fromReporter: true, authorTenantUserId: null, body });
        await siloAudit(tx, access.tenantId, {
          action: "safety.speak_up.reporter_message",
          concernId: id,
          actor: "reporter",
        });
        return threadOf(tx, row);
      });
      return c.json(thread, 200);
    },
  )
  // ---- The lead and the case's members ------------------------------------------------------
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/speak-up/cases",
      tags: ["safety"],
      summary: "Concerns you hold as the Freedom to Speak Up lead or as a member of the case",
      security,
      responses: { 200: jsonBody(SpeakUpCaseList, "Cases"), ...errorResponses },
    }),
    async (c) => {
      const access = await caseReader(c);
      const items = await withTenant(c, async (tx) => {
        const rows = await tx
          .select()
          .from(speakUpConcern)
          .where(and(isNull(speakUpConcern.deletedAt), caseVisible))
          .orderBy(desc(speakUpConcern.receivedOn), desc(speakUpConcern.createdAt))
          .limit(500);
        await auditInTx(tx, access, {
          action: "safety.speak_up.list",
          scope: { count: rows.length },
          requestId: c.get("requestId"),
        });
        return casesOut(tx, access, rows);
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/speak-up/cases/{id}",
      tags: ["safety"],
      summary: "A case with its messages",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(SpeakUpCaseDetail, "The case"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await caseReader(c);
      const { id } = c.req.valid("param");
      const detail = await withTenant(c, async (tx) => {
        const row = await loadCase(tx, id);
        await staffAudit(c, tx, access, "safety.speak_up.view", id);
        const [item] = await casesOut(tx, access, [row]);
        return { ...(item as SpeakUpCase), messages: await messagesOf(tx, id, false) };
      });
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/speak-up/cases/{id}/messages",
      tags: ["safety"],
      summary: "Write to whoever raised the concern, on the case",
      description:
        "The lead or a member of the case. An anonymous reporter reads it with their token.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: PostSpeakUpMessage } } },
      },
      responses: {
        200: jsonBody(SpeakUpCaseDetail, "The case"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await caseReader(c);
      const { id } = c.req.valid("param");
      const { body } = c.req.valid("json");
      const detail = await withTenant(c, async (tx) => {
        const row = await loadCase(tx, id);
        if (row.state === "closed") throw closedProblem();
        if (!canReplyTo(row)) {
          throw problems.invalid(
            "Nobody can read this: the concern was raised anonymously with no way to reply.",
          );
        }
        await tx.insert(speakUpMessage).values({
          concernId: id,
          fromReporter: false,
          authorTenantUserId: access.tenantUserId,
          body,
        });
        await staffAudit(c, tx, access, "safety.speak_up.message", id);
        const [item] = await casesOut(tx, access, [row]);
        return { ...(item as SpeakUpCase), messages: await messagesOf(tx, id, false) };
      });
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/speak-up/cases/{id}/step",
      tags: ["safety"],
      summary: "Move a concern on: acknowledge, review, share the outcome, close",
      description:
        "The Freedom to Speak Up lead only. Sharing the outcome needs it in words; closing needs a reason and, when whoever raised it can be told, the outcome shared first.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: SpeakUpStep } } },
      },
      responses: {
        200: jsonBody(SpeakUpCaseDetail, "Moved"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, LEAD);
      const { id } = c.req.valid("param");
      const step = c.req.valid("json");
      const detail = await withTenant(c, async (tx) => {
        const row = await loadCase(tx, id, step.version);
        const check = checkWorkflowTransition(
          SPEAK_UP_WORKFLOW,
          // No creator is stored, so no separation of duties applies (none is defined).
          { state: row.state as SpeakUpState, createdBy: "" },
          {
            to: step.to,
            actorId: access.tenantUserId,
            permissions: access.effective.permissions,
            reason: step.reason ?? null,
            stepUpFresh: access.stepUpFresh,
          },
        );
        if (!check.ok) throw problems.invalid(check.message);
        const now = new Date();
        const changes: Partial<ConcernRow> = { state: step.to };
        if (step.to === "acknowledged") changes.acknowledgedAt = now;
        if (step.to === "outcome_shared") {
          if (!canReplyTo(row)) {
            throw problems.invalid(
              "Nobody can be told: the concern was raised anonymously with no way to reply. Close it with a reason.",
            );
          }
          if (!step.outcome) throw problems.invalid("Say what happened, for whoever raised it.");
          changes.outcome = step.outcome;
          changes.outcomeSharedAt = now;
        }
        if (step.to === "closed") {
          const blocking = speakUpCloseProblems(identityOf(row), row.outcomeSharedAt);
          if (blocking.length > 0) throw problems.invalid(blocking.join(" "));
          changes.closedReason = step.reason?.trim() ?? null;
          changes.closedAt = now;
        }
        const [updated] = await tx
          .update(speakUpConcern)
          .set(changes)
          .where(and(eq(speakUpConcern.id, id), eq(speakUpConcern.version, step.version)))
          .returning();
        if (!updated) throw problems.conflict();
        await auditInTx(tx, access, {
          action: `safety.speak_up.${step.to}`,
          resourceType: "speak_up_concern",
          resourceId: id,
          requestId: c.get("requestId"),
        });
        const [item] = await casesOut(tx, access, [updated]);
        return { ...(item as SpeakUpCase), messages: await messagesOf(tx, id, false) };
      });
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/speak-up/cases/{id}/members",
      tags: ["safety"],
      summary: "Name the members who work on the case",
      description:
        "The Freedom to Speak Up lead only. Members see the case and its messages, and who raised it only when it is named. Removing a member keeps who was named and when.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: SetSpeakUpMembers } } },
      },
      responses: {
        200: jsonBody(SpeakUpCaseDetail, "The case"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, LEAD);
      const { id } = c.req.valid("param");
      const wanted = [...new Set(c.req.valid("json").memberIds)];
      const detail = await withTenant(c, async (tx) => {
        const row = await loadCase(tx, id);
        if (wanted.length > 0) {
          const active = await tx
            .select({ id: tenantUser.id })
            .from(tenantUser)
            .where(and(inArray(tenantUser.id, wanted), eq(tenantUser.status, "active")));
          if (active.length !== wanted.length) {
            throw problems.invalid("Name only active members of the organisation.");
          }
        }
        const current = await tx
          .select({ rowId: speakUpCaseMember.id, id: speakUpCaseMember.tenantUserId })
          .from(speakUpCaseMember)
          .where(and(eq(speakUpCaseMember.concernId, id), isNull(speakUpCaseMember.removedAt)));
        const removed = current.filter((m) => !wanted.includes(m.id));
        const added = wanted.filter((w) => !current.some((m) => m.id === w));
        if (removed.length > 0) {
          await tx
            .update(speakUpCaseMember)
            .set({ removedAt: new Date(), removedBy: access.tenantUserId })
            .where(
              inArray(
                speakUpCaseMember.id,
                removed.map((m) => m.rowId),
              ),
            );
        }
        for (const memberId of added) {
          await tx
            .insert(speakUpCaseMember)
            .values({ concernId: id, tenantUserId: memberId, addedBy: access.tenantUserId });
        }
        await auditInTx(tx, access, {
          action: "safety.speak_up.members",
          resourceType: "speak_up_concern",
          resourceId: id,
          scope: { added: added.length, removed: removed.length },
          requestId: c.get("requestId"),
        });
        const [item] = await casesOut(tx, access, [row]);
        return { ...(item as SpeakUpCase), messages: await messagesOf(tx, id, false) };
      });
      return c.json(detail, 200);
    },
  );
