import {
  AcknowledgeSubProcessor,
  ObjectToNotice,
  SubProcessorOverview,
  SubProcessorResponseRecorded,
} from "@harbour/contracts";
import { subProcessorNotice, subProcessorResponse, type Transaction, tenant } from "@harbour/db";
import {
  can,
  checkNoticeResponse,
  type NoticeResponse,
  noticeResponseFrom,
  noticeStateFor,
  objectionWindowEndsAt,
  PLATFORM_RATE_KEYS,
  type RateNation,
  type StoredNoticeResponse,
  SUB_PROCESSORS,
  type SubProcessorConfig,
  type SubProcessorKey,
  type SubProcessorNotice,
  type SubProcessorUse,
  subProcessorAcknowledgementsFrom,
  subProcessorsInUse,
  ukIsoDate,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { desc, eq } from "drizzle-orm";
import type { Context } from "hono";
import { auditInTx, writeAudit } from "../http/audit";
import {
  type AppEnv,
  requireAnyPermission,
  requirePermission,
  stepUpAtFor,
  type TenantAccess,
  withTenant,
} from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { dpiaConfigFor, tenantFlags } from "../services/dpia";
import { rateNumber } from "../services/rates";
import { createRouter, errorResponses, jsonBody, notFoundResponse, security } from "./openapi";

/**
 * Sub-processors and change notices for the organisation (UK GDPR Art 28; DPA clause 6;
 * platform-completions.md rules 23 to 25). Reading needs a DPIA or onboarding permission;
 * answering, `platform.dpia.sign` with step-up, by the named data protection lead
 * (`checkNoticeResponse`), as row-level security does again (migration 0065). Responses are
 * append-only; every one is audited, refusals too, with ids and keys only (never the grounds).
 */

type Tx = Transaction;
type NoticeRow = typeof subProcessorNotice.$inferSelect;

const READERS = [
  "platform.dpia.read",
  "platform.dpia.prepare",
  "platform.dpia.sign",
  "platform.onboarding.read",
  "platform.onboarding.manage",
] as const;

const asNotice = (row: NoticeRow): SubProcessorNotice => ({
  id: row.id,
  subProcessorKey: row.subProcessorKey,
  kind: row.kind as SubProcessorNotice["kind"],
  use: row.use as SubProcessorUse,
  announcedAt: row.announcedAt,
  effectiveFrom: row.effectiveFrom,
});

/** The organisation's configuration, notice period, responses and lead, read once. */
async function contextOf(c: Context<AppEnv>, tx: Tx, access: TenantAccess) {
  const [t] = await tx.select().from(tenant).where(eq(tenant.id, access.tenantId));
  if (!t) throw problems.notFound();
  const config = await dpiaConfigFor(tx, t, await tenantFlags(c.get("services").flags, tx, t.id));
  const subConfig: SubProcessorConfig = {
    features: config.features,
    capabilities: config.capabilities,
    aiProvider: config.aiProvider,
  };
  const nation = t.nation as Exclude<RateNation, "uk" | "all">;
  /** The organisation's notice period in force on the UK date a notice was announced. */
  const ratesAt = async (announcedAt: Date) => ({
    subProcessorNoticeDays: await rateNumber(
      tx,
      t.id,
      PLATFORM_RATE_KEYS.subProcessorNoticeDays,
      nation,
      ukIsoDate(announcedAt),
    ),
  });
  const responses: StoredNoticeResponse[] = (
    await tx.select().from(subProcessorResponse).orderBy(subProcessorResponse.respondedAt)
  ).map((r) => ({
    subProcessorKey: r.subProcessorKey,
    noticeId: r.noticeId,
    kind: r.kind as StoredNoticeResponse["kind"],
    grounds: r.grounds,
    resolution: r.resolution as StoredNoticeResponse["resolution"],
    respondedAt: r.respondedAt,
  }));
  return { leadId: t.dataProtectionLeadId, subConfig, ratesAt, responses };
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** A notice about this sub-processor the organisation has objected to, still unresolved. */
function openObjection(
  key: string,
  responses: readonly StoredNoticeResponse[],
): NoticeResponse | null {
  const noticeIds = new Set(
    responses.flatMap((r) => (r.subProcessorKey === key && r.noticeId ? [r.noticeId] : [])),
  );
  for (const id of noticeIds) {
    const response = noticeResponseFrom(id, responses);
    if (response.objection && response.objection.resolvedAt === null) return response;
  }
  return null;
}

/** A refused answer: audited, then 422 with the rule's words (or the step-up refusal). */
async function refuse(
  c: Context<AppEnv>,
  access: TenantAccess,
  action: string,
  problem: string,
  message: string,
): Promise<never> {
  await writeAudit(c.get("services").appPool, access, {
    action,
    outcome: "denied",
    reason: problem,
    requestId: c.get("requestId"),
  });
  throw new HttpProblem(422, "notice_response_refused", "The answer cannot be recorded.", message);
}

const Key = z.object({ key: z.string().min(1).max(100) });
const Id = z.object({ id: z.uuid() });
const recorded = {
  201: jsonBody(SubProcessorResponseRecorded, "Recorded"),
  ...errorResponses,
  ...notFoundResponse,
};

export const subProcessorsRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/sub-processors",
      tags: ["platform"],
      summary: "The sub-processors the organisation uses, and the notices about them",
      description:
        "A DPIA or onboarding permission. The sub-processors its configuration uses, each acknowledged or not since its entry last changed, and every notice with where it stands for the organisation (noticeStateFor) and when its objection window ends (the organisation's sub_processor.notice_days).",
      security,
      responses: { 200: jsonBody(SubProcessorOverview, "Sub-processors"), ...errorResponses },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [...READERS]);
      const now = new Date();
      const body = await withTenant(c, async (tx) => {
        const { leadId, subConfig, ratesAt, responses } = await contextOf(c, tx, access);
        const rates = await ratesAt(now);
        // The grounds of an objection are the controller's reasoning: DPIA permission holders only.
        const seesGrounds = (
          ["platform.dpia.read", "platform.dpia.prepare", "platform.dpia.sign"] as const
        ).some((p) => can(access.effective, p));
        const notices = (
          await tx.select().from(subProcessorNotice).orderBy(desc(subProcessorNotice.announcedAt))
        ).map(asNotice);
        const acknowledged = subProcessorAcknowledgementsFrom(responses);
        const changedAt = (key: string) =>
          notices.find((n) => n.subProcessorKey === key)?.announcedAt ?? null;
        return {
          noticeDays: rates.subProcessorNoticeDays,
          mayRespond: can(access.effective, "platform.dpia.sign") && leadId === access.tenantUserId,
          inUse: subProcessorsInUse(subConfig).map((key) => {
            const entry = SUB_PROCESSORS[key];
            const at = acknowledged.find((a) => a.key === key)?.acknowledgedAt ?? null;
            const changed = changedAt(key);
            return {
              key,
              name: entry.name,
              service: entry.service,
              purpose: entry.purpose,
              location: entry.location,
              outsideUk: entry.outsideUk,
              acknowledgedAt: iso(at),
              changedAt: iso(changed),
              acknowledged: at !== null && (changed === null || at >= changed),
            };
          }),
          notices: await Promise.all(
            notices.map(async (notice) => {
              const response: NoticeResponse = noticeResponseFrom(notice.id, responses);
              const noticeRates = await ratesAt(notice.announcedAt);
              return {
                id: notice.id,
                subProcessorKey: notice.subProcessorKey,
                kind: notice.kind,
                announcedAt: notice.announcedAt.toISOString(),
                effectiveFrom: notice.effectiveFrom.toISOString(),
                windowEndsAt: objectionWindowEndsAt(notice, noticeRates).toISOString(),
                state: noticeStateFor(notice, response, subConfig, now, noticeRates),
                acknowledgedAt: iso(response.acknowledgedAt),
                objection: response.objection
                  ? {
                      at: response.objection.at.toISOString(),
                      grounds: seesGrounds ? response.objection.grounds : null,
                      resolvedAt: iso(response.objection.resolvedAt),
                      resolution: response.objection.resolution,
                    }
                  : null,
              };
            }),
          ),
        };
      });
      return c.json(body, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/sub-processors/{key}/acknowledge",
      tags: ["platform"],
      summary: "Acknowledge a sub-processor the organisation uses",
      description:
        "platform.dpia.sign with step-up, by the named data protection lead (checkNoticeResponse; 422 notice_response_refused otherwise): its register entry at onboarding, or a notice about it (`noticeId`). Append-only. Audited (platform.sub_processor.acknowledged), refusals too.",
      security,
      request: {
        params: Key,
        body: { content: { "application/json": { schema: AcknowledgeSubProcessor } } },
      },
      responses: recorded,
    }),
    async (c) => {
      const access = await requirePermission(c, "platform.dpia.sign");
      const { key } = c.req.valid("param");
      const { noticeId } = c.req.valid("json");
      const action = "platform.sub_processor.acknowledged";
      const now = new Date();
      const outcome = await withTenant(c, async (tx) => {
        const [row] = noticeId
          ? await tx.select().from(subProcessorNotice).where(eq(subProcessorNotice.id, noticeId))
          : [];
        if (noticeId && (!row || row.subProcessorKey !== key)) throw problems.notFound();
        const entry = Object.hasOwn(SUB_PROCESSORS, key)
          ? SUB_PROCESSORS[key as SubProcessorKey]
          : undefined;
        let notice: SubProcessorNotice;
        if (row) notice = asNotice(row);
        else if (entry) {
          notice = {
            id: key,
            subProcessorKey: key,
            kind: "new",
            use: entry.use,
            announcedAt: now,
            effectiveFrom: now,
          };
        } else throw problems.notFound();
        const { leadId, subConfig, ratesAt, responses } = await contextOf(c, tx, access);
        const rates = await ratesAt(row?.announcedAt ?? now);
        const check = checkNoticeResponse({
          kind: "acknowledge",
          notice,
          // The register entry is not acknowledged while any notice about it is objected to.
          response: row
            ? noticeResponseFrom(row.id, responses)
            : (openObjection(key, responses) ?? { acknowledgedAt: null, objection: null }),
          config: subConfig,
          access: access.effective,
          actorTenantUserId: access.tenantUserId,
          designatedLeadIds: leadId ? [leadId] : [],
          stepUpAt: stepUpAtFor(access, now),
          stepUpWindowSeconds: access.stepUpWindowSeconds,
          now,
          rates,
        });
        if (!check.ok) return { issue: check };
        const [saved] = await tx
          .insert(subProcessorResponse)
          .values({ subProcessorKey: key, noticeId: row?.id ?? null, kind: "acknowledged" })
          .returning({ id: subProcessorResponse.id, at: subProcessorResponse.respondedAt });
        if (!saved) throw problems.conflict();
        await auditInTx(tx, access, {
          action,
          resourceType: "sub_processor_response",
          resourceId: saved.id,
          scope: { subProcessorKey: key, noticeId: row?.id ?? null },
          requestId: c.get("requestId"),
        });
        return { saved };
      });
      if (outcome.issue)
        return refuse(c, access, action, outcome.issue.problem, outcome.issue.message);
      return c.json({ id: outcome.saved.id, respondedAt: outcome.saved.at.toISOString() }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/sub-processor-notices/{id}/object",
      tags: ["platform"],
      summary: "Object to a sub-processor notice, within its window",
      description:
        "platform.dpia.sign with step-up, by the named data protection lead, while the organisation's objection window is open, with data protection grounds of 20 characters or more (checkNoticeResponse; 422 notice_response_refused otherwise). While the objection is open the sub-processor does not process the organisation's data (mayProcessTenantData). Append-only. Audited (platform.sub_processor.objected) with the notice id, never the grounds; refusals too.",
      security,
      request: {
        params: Id,
        body: { content: { "application/json": { schema: ObjectToNotice } } },
      },
      responses: recorded,
    }),
    async (c) => {
      const access = await requirePermission(c, "platform.dpia.sign");
      const { id } = c.req.valid("param");
      const { grounds } = c.req.valid("json");
      const action = "platform.sub_processor.objected";
      const now = new Date();
      const outcome = await withTenant(c, async (tx) => {
        const [row] = await tx
          .select()
          .from(subProcessorNotice)
          .where(eq(subProcessorNotice.id, id));
        if (!row) throw problems.notFound();
        const { leadId, subConfig, ratesAt, responses } = await contextOf(c, tx, access);
        const rates = await ratesAt(row.announcedAt);
        const check = checkNoticeResponse({
          kind: "object",
          notice: asNotice(row),
          response: noticeResponseFrom(row.id, responses),
          config: subConfig,
          access: access.effective,
          actorTenantUserId: access.tenantUserId,
          designatedLeadIds: leadId ? [leadId] : [],
          stepUpAt: stepUpAtFor(access, now),
          stepUpWindowSeconds: access.stepUpWindowSeconds,
          grounds,
          now,
          rates,
        });
        if (!check.ok) return { issue: check };
        const [saved] = await tx
          .insert(subProcessorResponse)
          .values({
            subProcessorKey: row.subProcessorKey,
            noticeId: row.id,
            kind: "objected",
            grounds: grounds.trim(),
          })
          .returning({ id: subProcessorResponse.id, at: subProcessorResponse.respondedAt });
        if (!saved) throw problems.conflict();
        await auditInTx(tx, access, {
          action,
          resourceType: "sub_processor_response",
          resourceId: saved.id,
          scope: { subProcessorKey: row.subProcessorKey, noticeId: row.id },
          requestId: c.get("requestId"),
        });
        return { saved };
      });
      if (outcome.issue)
        return refuse(c, access, action, outcome.issue.problem, outcome.issue.message);
      return c.json({ id: outcome.saved.id, respondedAt: outcome.saved.at.toISOString() }, 201);
    },
  );
