import {
  DataProtectionSettings,
  DpiaOverview,
  DpiaVersion,
  PrepareDpia,
  SaveDpia,
  SignDpia,
} from "@harbour/contracts";
import { dpia, type Transaction, tenant, tenantUser } from "@harbour/db";
import {
  dpiaBasis as basisOf,
  checkDpiaSignOff,
  type DpiaBasis,
  type DpiaDraft,
  type DpiaSectionKey,
  dpiaReviewDueAt,
  dpiaState,
  PLATFORM_RATE_KEYS,
  prefillDpia,
  type RiskLevel,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, inArray, isNull, max, sql } from "drizzle-orm";
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
import { dpiaConfigFor, dpiaVersionItem, dpiaVersionSha256 } from "../services/dpia";
import { rateNumber } from "../services/rates";
import { staffNames } from "../services/staff";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";

/**
 * The DPIA and data protection governance (PLAT-023; platform-completions.md rules 17 to 22;
 * section 5.1). Reading needs a DPIA permission; preparing `platform.dpia.prepare`; signing
 * `platform.dpia.sign` with step-up, by the named data protection lead, who prepared none of the
 * version (`checkDpiaSignOff`); the governance settings `platform.tenant.manage`. Row-level
 * security and the guard (migration 0063) enforce the same. Every write is audited.
 */

type DpiaRow = typeof dpia.$inferSelect;
type Tx = Transaction;

const settingsOf = (t: typeof tenant.$inferSelect) => ({
  leadId: t.dataProtectionLeadId,
  dpoName: t.dpoName,
  dpoEmail: t.dpoEmail,
  sector: t.sector as "independent" | "public",
  privacyNoticeUrl: t.privacyNoticeUrl,
  dpaSignedOn: t.dpaSignedOn,
  usesDataBeyondDirectCare: t.usesDataBeyondDirectCare,
  marketingEnabled: t.marketingEnabled,
  aiFreeTextEnabled: t.aiFreeTextEnabled,
  aiProvider: t.aiProvider as DataProtectionSettings["aiProvider"],
});

/** The prefill for the organisation as it stands now, and what it covers. */
async function currentPrefill(c: Context<AppEnv>, tx: Tx, access: TenantAccess, now: Date) {
  const [t] = await tx.select().from(tenant).where(eq(tenant.id, access.tenantId));
  if (!t) throw problems.notFound();
  const overrides = await tx.execute<{
    flag_key: string;
    location_id: string | null;
    enabled: boolean;
  }>(sql`SELECT flag_key, location_id, enabled FROM feature_flag WHERE deleted_at IS NULL`);
  const flags = await c.get("services").flags.evaluateAll({
    tenantId: access.tenantId,
    locationId: null,
    overrides: overrides.rows.map((r) => ({
      flagKey: r.flag_key,
      locationId: r.location_id,
      enabled: r.enabled,
    })),
  });
  const config = await dpiaConfigFor(tx, t, flags);
  return { tenantRow: t, draft: prefillDpia(config, now), basis: basisOf(config) };
}

async function versions(tx: Tx) {
  const rows = await tx.select().from(dpia).orderBy(desc(dpia.dpiaVersion));
  return {
    open: rows.find((r) => r.status === "draft" || r.status === "prepared") ?? null,
    signed: rows.find((r) => r.status === "signed") ?? null,
  };
}

const IdParam = z.object({ id: z.uuid() });

const stale = () =>
  new HttpProblem(
    409,
    "version_conflict",
    "The DPIA changed since you opened it.",
    "Reload it and try again.",
  );

export const dpiaRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/dpia",
      tags: ["platform"],
      summary:
        "The organisation's DPIA: where it stands, the version being prepared and the one signed",
      description:
        "platform.dpia.read, .prepare or .sign. The state (not started, draft, prepared, signed, review due) with what triggers a review, the governance settings and any missing configuration.",
      security,
      responses: { 200: jsonBody(DpiaOverview, "The DPIA"), ...errorResponses },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [
        "platform.dpia.read",
        "platform.dpia.prepare",
        "platform.dpia.sign",
      ]);
      const now = new Date();
      const body = await withTenant(c, async (tx) => {
        const { tenantRow, draft, basis } = await currentPrefill(c, tx, access, now);
        const { open, signed } = await versions(tx);
        const months = await rateNumber(
          tx,
          access.tenantId,
          PLATFORM_RATE_KEYS.dpiaReviewIntervalMonths,
        );
        const view = (r: DpiaRow | null) =>
          r
            ? {
                status: r.status as "draft",
                signedAt: r.signedAt,
                basis: r.basis as DpiaBasis | null,
              }
            : null;
        const { state, triggers } = dpiaState(view(signed), view(open), basis, now, {
          dpiaReviewIntervalMonths: months,
        });
        const names = await staffNames(
          tx,
          [open, signed].flatMap((r) => (r ? [...r.preparedBy, r.signedBy] : [])),
        );
        return {
          state,
          triggers: triggers.map((tr) =>
            tr.kind === "yearly_review"
              ? { kind: tr.kind, dueAt: tr.dueAt.toISOString() }
              : { kind: tr.kind, items: [...tr.items] },
          ),
          settings: settingsOf(tenantRow),
          missingConfig: [...draft.missingConfig],
          open: open ? dpiaVersionItem(open, names) : null,
          signed: signed ? dpiaVersionItem(signed, names) : null,
          reviewDueAt: signed?.signedAt
            ? dpiaReviewDueAt(signed.signedAt, { dpiaReviewIntervalMonths: months }).toISOString()
            : null,
        };
      });
      return c.json(body, 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/dpia/draft",
      tags: ["platform"],
      summary: "Save the DPIA being prepared (starting a new version if none is)",
      description:
        "platform.dpia.prepare. Refreshes Harbour's prefill and stores the organisation's answers, residual risk ratings and any ICO reference; the saver joins the version's preparers, who may not sign it. Saving a prepared version returns it to draft. Send the open version's `version` (409 when stale). Audited.",
      security,
      request: { body: { content: { "application/json": { schema: SaveDpia } } } },
      responses: { 200: jsonBody(DpiaVersion, "Saved"), ...errorResponses, ...conflictResponse },
    }),
    async (c) => {
      const access = await requirePermission(c, "platform.dpia.prepare");
      const input = c.req.valid("json");
      const now = new Date();
      const row = await withTenant(c, async (tx) => {
        const { draft } = await currentPrefill(c, tx, access, now);
        const { open } = await versions(tx);
        const content = {
          prefill: draft as unknown as Record<string, unknown>,
          answers: input.answers,
          residualRisk: input.residualRisk,
          icoReference: input.icoReference,
        };
        let saved: DpiaRow | undefined;
        if (open) {
          if (input.expectedVersion !== open.version) throw stale();
          [saved] = await tx
            .update(dpia)
            .set({ ...content, status: "draft" })
            .where(and(eq(dpia.id, open.id), eq(dpia.version, open.version)))
            .returning();
          if (!saved) throw stale();
        } else {
          const [last] = await tx.select({ n: max(dpia.dpiaVersion) }).from(dpia);
          [saved] = await tx
            .insert(dpia)
            .values({
              ...content,
              dpiaVersion: (last?.n ?? 0) + 1,
              preparedBy: [access.tenantUserId],
            })
            .returning();
        }
        if (!saved) throw problems.conflict();
        await auditInTx(tx, access, {
          action: "platform.dpia.saved",
          resourceType: "dpia",
          resourceId: saved.id,
          scope: { dpiaVersion: saved.dpiaVersion },
          requestId: c.get("requestId"),
        });
        return dpiaVersionItem(saved, await staffNames(tx, saved.preparedBy));
      });
      return c.json(row, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/dpia/draft/prepare",
      tags: ["platform"],
      summary: "Mark the DPIA ready for sign-off",
      description:
        "platform.dpia.prepare. Refreshes the prefill once more, then freezes the version and records its SHA-256, which the signature binds to. Audited (platform.dpia.prepared).",
      security,
      request: { body: { content: { "application/json": { schema: PrepareDpia } } } },
      responses: {
        200: jsonBody(DpiaVersion, "Prepared"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "platform.dpia.prepare");
      const { expectedVersion } = c.req.valid("json");
      const now = new Date();
      const row = await withTenant(c, async (tx) => {
        const { open } = await versions(tx);
        if (!open) throw problems.notFound();
        if (open.version !== expectedVersion || open.status !== "draft") throw stale();
        const { draft } = await currentPrefill(c, tx, access, now);
        const [refreshed] = await tx
          .update(dpia)
          .set({ prefill: draft as unknown as Record<string, unknown> })
          .where(eq(dpia.id, open.id))
          .returning();
        if (!refreshed) throw stale();
        const [prepared] = await tx
          .update(dpia)
          .set({ status: "prepared", versionSha256: dpiaVersionSha256(refreshed), preparedAt: now })
          .where(eq(dpia.id, open.id))
          .returning();
        if (!prepared) throw stale();
        await auditInTx(tx, access, {
          action: "platform.dpia.prepared",
          resourceType: "dpia",
          resourceId: prepared.id,
          scope: { dpiaVersion: prepared.dpiaVersion, sha256: prepared.versionSha256 },
          requestId: c.get("requestId"),
        });
        return dpiaVersionItem(prepared, await staffNames(tx, prepared.preparedBy));
      });
      return c.json(row, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/dpia/{id}/sign",
      tags: ["platform"],
      summary: "Sign the prepared DPIA",
      description:
        "platform.dpia.sign with step-up, by the member named as data protection officer or lead, who prepared none of this version, with a typed name bound to the version's SHA-256 as read (checkDpiaSignOff: every problem at once, 422 dpia_not_signable). The version signed before is superseded. Audited (platform.dpia.signed), refusals too.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: SignDpia } } },
      },
      responses: {
        200: jsonBody(DpiaVersion, "Signed"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "platform.dpia.sign");
      const { id } = c.req.valid("param");
      const signature = c.req.valid("json");
      const now = new Date();
      const requestId = c.get("requestId");
      const outcome = await withTenant(c, async (tx) => {
        const [row] = await tx.select().from(dpia).where(eq(dpia.id, id));
        if (!row) return { missing: true as const };
        const [t] = await tx.select().from(tenant).where(eq(tenant.id, access.tenantId));
        const answers = row.answers as Record<string, Record<string, string>>;
        const check = checkDpiaSignOff({
          draft: row.prefill as unknown as DpiaDraft,
          status: row.status as "prepared",
          preparedBy: row.preparedBy,
          completedFields: Object.fromEntries(
            Object.entries(answers).map(([section, fields]) => [
              section as DpiaSectionKey,
              Object.entries(fields)
                .filter(([, v]) => v.trim().length > 0)
                .map(([k]) => k),
            ]),
          ),
          residualRisk: row.residualRisk as Record<string, RiskLevel | null>,
          icoConsultationReference: row.icoReference,
          versionSha256: row.versionSha256 ?? "",
          actor: { tenantUserId: access.tenantUserId, access: access.effective },
          stepUpAt: stepUpAtFor(access, now),
          now,
          stepUpWindowSeconds: access.stepUpWindowSeconds,
          designatedLeadIds: t?.dataProtectionLeadId ? [t.dataProtectionLeadId] : [],
          signature,
        });
        if (!check.ok) return { issues: check.issues };
        await tx.update(dpia).set({ status: "superseded" }).where(eq(dpia.status, "signed"));
        const [signed] = await tx
          .update(dpia)
          .set({
            status: "signed",
            signedBy: access.tenantUserId,
            signedAt: now,
            typedName: check.signerName,
            statement: check.statement,
            basis: check.basis as unknown as Record<string, unknown>,
          })
          .where(and(eq(dpia.id, id), eq(dpia.status, "prepared")))
          .returning();
        if (!signed)
          return {
            issues: [
              { problem: "not_prepared", message: "Mark the DPIA as ready for sign-off first." },
            ],
          };
        await auditInTx(tx, access, {
          action: "platform.dpia.signed",
          resourceType: "dpia",
          resourceId: id,
          scope: { dpiaVersion: signed.dpiaVersion, sha256: signed.versionSha256 },
          requestId,
        });
        return {
          signed: dpiaVersionItem(
            signed,
            await staffNames(tx, [...signed.preparedBy, access.tenantUserId]),
          ),
        };
      });
      if ("missing" in outcome) throw problems.notFound();
      if ("issues" in outcome && outcome.issues) {
        const reasons = outcome.issues.map((i) => i.problem);
        await writeAudit(c.get("services").appPool, access, {
          action: "platform.dpia.signed",
          outcome: "denied",
          resourceType: "dpia",
          resourceId: id,
          reason: reasons.join(","),
          requestId,
        });
        throw new HttpProblem(
          422,
          "dpia_not_signable",
          "The DPIA cannot be signed yet.",
          outcome.issues.map((i) => i.message).join(" "),
        );
      }
      if (!("signed" in outcome) || !outcome.signed) throw problems.conflict();
      return c.json(outcome.signed, 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/settings/data-protection",
      tags: ["platform"],
      summary: "The organisation's data protection governance",
      description:
        "platform.tenant.manage. Names the data protection officer or lead (an active member, who signs the DPIA), the sector, privacy notice, DPA date, use of data beyond direct care and the optional processing. Audited with what changed, never the values of names or addresses.",
      security,
      request: { body: { content: { "application/json": { schema: DataProtectionSettings } } } },
      responses: { 200: jsonBody(DataProtectionSettings, "Saved"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, "platform.tenant.manage");
      const input = c.req.valid("json");
      const saved = await withTenant(c, async (tx) => {
        if (input.leadId) {
          const [lead] = await tx
            .select({ id: tenantUser.id })
            .from(tenantUser)
            .where(
              and(
                eq(tenantUser.id, input.leadId),
                isNull(tenantUser.deletedAt),
                inArray(tenantUser.status, ["active"]),
              ),
            );
          if (!lead)
            throw problems.invalid("Name an active member of the organisation as the lead.");
        }
        const [before] = await tx.select().from(tenant).where(eq(tenant.id, access.tenantId));
        const [t] = await tx
          .update(tenant)
          .set({
            dataProtectionLeadId: input.leadId,
            dpoName: input.dpoName,
            dpoEmail: input.dpoEmail?.toLowerCase() ?? null,
            sector: input.sector,
            privacyNoticeUrl: input.privacyNoticeUrl,
            dpaSignedOn: input.dpaSignedOn,
            usesDataBeyondDirectCare: input.usesDataBeyondDirectCare,
            marketingEnabled: input.marketingEnabled,
            aiFreeTextEnabled: input.aiFreeTextEnabled,
            aiProvider: input.aiProvider,
          })
          .where(eq(tenant.id, access.tenantId))
          .returning();
        if (!t || !before) throw problems.notFound();
        const was = settingsOf(before);
        const now = settingsOf(t);
        await auditInTx(tx, access, {
          action: "platform.data_protection.updated",
          resourceType: "tenant",
          resourceId: access.tenantId,
          scope: {
            changed: (Object.keys(now) as (keyof typeof now)[]).filter((k) => was[k] !== now[k]),
          },
          requestId: c.get("requestId"),
        });
        return now;
      });
      return c.json(saved, 200);
    },
  );
