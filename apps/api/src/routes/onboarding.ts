import {
  Dcb0160Recording,
  OnboardingChecklist,
  OnboardingDecisionRecorded,
  RetentionDecision,
  SettingDecision,
  StaffFileOptionChoice,
  StaffFileOptionChosen,
} from "@harbour/contracts";
import {
  dcb0160Record,
  rateTable,
  retentionClass,
  retentionDecision,
  tenant,
  tenantSettingDecision,
} from "@harbour/db";
import {
  checkDcb0160Recording,
  checkRetentionDecision,
  checkSettingDecision,
  type DecisionIssue,
  onboardingChecklist,
  tenantDefaultRateKeys,
} from "@harbour/domain";
import { createRoute } from "@hono/zod-openapi";
import { and, eq, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { auditInTx, writeAudit } from "../http/audit";
import { type AppEnv, requireAnyPermission, requirePermission, withTenant } from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { onboardingStateFor } from "../services/onboarding";
import { conflictResponse, createRouter, errorResponses, jsonBody, security } from "./openapi";

/**
 * The onboarding checklist and the decisions it needs (PLAT-018; platform-completions.md rules 26
 * and 27). Reading needs `platform.onboarding.read` or `.manage`; recording a decision
 * `platform.onboarding.manage`. Decisions are append-only records with who and when (migration
 * 0064), and a later change by Harbour reopens them because the checklist compares times. Every
 * decision is audited, refusals too.
 */

type Recorded = { id: string; decidedAt: string };

/** A decision the rules refuse: audited, then 422 with the plain-English reason. */
async function refuse(
  c: Context<AppEnv>,
  access: Awaited<ReturnType<typeof requirePermission>>,
  action: string,
  issue: DecisionIssue,
): Promise<never> {
  await writeAudit(c.get("services").appPool, access, {
    action,
    outcome: "denied",
    reason: issue.problem,
    requestId: c.get("requestId"),
  });
  throw new HttpProblem(
    422,
    "decision_not_recordable",
    "The decision cannot be recorded.",
    issue.message,
  );
}

const recorded = (r: { id: string; at: Date }): Recorded => ({
  id: r.id,
  decidedAt: r.at.toISOString(),
});

const decisionResponses = {
  201: jsonBody(OnboardingDecisionRecorded, "Recorded"),
  ...errorResponses,
};

export const onboardingRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/onboarding",
      tags: ["platform"],
      summary: "The organisation's onboarding checklist",
      description:
        "platform.onboarding.read or .manage. Every item worked out from the organisation's records (onboardingChecklist), with its reason, what is outstanding and whether it blocks go-live; the safety case the DCB0160 assessment must cover; the staff file option and the organisation record's version.",
      security,
      responses: { 200: jsonBody(OnboardingChecklist, "The checklist"), ...errorResponses },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [
        "platform.onboarding.read",
        "platform.onboarding.manage",
      ]);
      const services = c.get("services");
      const now = new Date();
      const body = await withTenant(c, async (tx) => {
        const [t] = await tx.select().from(tenant).where(eq(tenant.id, access.tenantId));
        if (!t) throw problems.notFound();
        const state = await onboardingStateFor(
          tx,
          {
            flags: services.flags,
            authPool: services.authPool,
            safetyCaseVersion: services.config.SAFETY_CASE_VERSION,
          },
          t,
          now,
        );
        const checklist = onboardingChecklist(state);
        return {
          ...checklist,
          items: checklist.items.map(({ people, outstanding, ...item }) => ({
            ...item,
            outstanding: [...outstanding],
            ...(people
              ? { people: people.map((p) => ({ personId: p.personId, gaps: [...p.gaps] })) }
              : {}),
          })),
          blockers: [...checklist.blockers],
          currentSafetyCaseVersion: state.currentSafetyCaseVersion,
          staffFileOption: t.staffFileOption as OnboardingChecklist["staffFileOption"],
          version: t.version,
        };
      });
      return c.json(body, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/onboarding/setting-decisions",
      tags: ["platform"],
      summary: "Record a decision on a setting Harbour chose",
      description:
        "platform.onboarding.manage. Accepts Harbour's default for a tenant-default setting, or records that the organisation set its own (which needs its own figure in the rate table first; 422 decision_not_recordable otherwise). Append-only; a later change by Harbour reopens it. Audited (platform.setting.decided, with the key and kind), refusals too.",
      security,
      request: { body: { content: { "application/json": { schema: SettingDecision } } } },
      responses: decisionResponses,
    }),
    async (c) => {
      const access = await requirePermission(c, "platform.onboarding.manage");
      const input = c.req.valid("json");
      const action = "platform.setting.decided";
      const outcome = await withTenant(c, async (tx) => {
        const global = await tx
          .select({ key: rateTable.key, source: rateTable.source })
          .from(rateTable)
          .where(and(isNull(rateTable.tenantId), eq(rateTable.key, input.rateKey)));
        const [own] = await tx
          .select({ id: rateTable.id })
          .from(rateTable)
          .where(and(eq(rateTable.tenantId, access.tenantId), eq(rateTable.key, input.rateKey)))
          .limit(1);
        const issue = checkSettingDecision({
          kind: input.kind,
          isTenantDefault: tenantDefaultRateKeys(global).includes(input.rateKey),
          hasOwnSetting: own !== undefined,
        });
        if (issue) return { issue };
        const [row] = await tx
          .insert(tenantSettingDecision)
          .values({ rateKey: input.rateKey, kind: input.kind })
          .returning({ id: tenantSettingDecision.id, at: tenantSettingDecision.decidedAt });
        if (!row) throw problems.conflict();
        await auditInTx(tx, access, {
          action,
          resourceType: "tenant_setting_decision",
          resourceId: row.id,
          scope: { rateKey: input.rateKey, kind: input.kind },
          requestId: c.get("requestId"),
        });
        return { row };
      });
      if (outcome.issue) return refuse(c, access, action, outcome.issue);
      return c.json(recorded(outcome.row), 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/onboarding/retention-decisions",
      tags: ["platform"],
      summary: "Record a decision on how long a kind of record is kept",
      description:
        "platform.onboarding.manage. Accepts or lengthens a class with a default, or sets the period of, or marks not used, a class the organisation's policy sets (checkRetentionDecision: lengthening or setting needs the organisation's own period first, longer than the default when lengthened; 422 decision_not_recordable otherwise). The staff file option is chosen on its own route. Append-only. Audited (platform.retention.decided, with the class and kind), refusals too.",
      security,
      request: { body: { content: { "application/json": { schema: RetentionDecision } } } },
      responses: decisionResponses,
    }),
    async (c) => {
      const access = await requirePermission(c, "platform.onboarding.manage");
      const input = c.req.valid("json");
      const action = "platform.retention.decided";
      const outcome = await withTenant(c, async (tx) => {
        const rows = await tx
          .select({
            tenantId: retentionClass.tenantId,
            trigger: retentionClass.trigger,
            period: retentionClass.period,
            unit: retentionClass.unit,
          })
          .from(retentionClass)
          .where(eq(retentionClass.recordClass, input.recordClass));
        const issue = checkRetentionDecision({
          recordClass: input.recordClass,
          kind: input.kind,
          schedule: rows.find((r) => r.tenantId === null) ?? null,
          own: rows.find((r) => r.tenantId === access.tenantId) ?? null,
        });
        if (issue) return { issue };
        const [row] = await tx
          .insert(retentionDecision)
          .values({ recordClass: input.recordClass, kind: input.kind })
          .returning({ id: retentionDecision.id, at: retentionDecision.decidedAt });
        if (!row) throw problems.conflict();
        await auditInTx(tx, access, {
          action,
          resourceType: "retention_decision",
          resourceId: row.id,
          scope: { recordClass: input.recordClass, kind: input.kind },
          requestId: c.get("requestId"),
        });
        return { row };
      });
      if (outcome.issue) return refuse(c, access, action, outcome.issue);
      return c.json(recorded(outcome.row), 201);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/onboarding/staff-file-option",
      tags: ["platform"],
      summary: "Choose how long staff files are kept",
      description:
        "platform.onboarding.manage. One of the schedule's two staff file options, for all staff files. Send the organisation record's `version` from the checklist (409 when stale). Audited (platform.retention.decided, with the option).",
      security,
      request: { body: { content: { "application/json": { schema: StaffFileOptionChoice } } } },
      responses: {
        200: jsonBody(StaffFileOptionChosen, "Chosen"),
        ...errorResponses,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "platform.onboarding.manage");
      const { option, expectedVersion } = c.req.valid("json");
      const chosen = await withTenant(c, async (tx) => {
        const [offered] = await tx
          .select({ id: retentionClass.id })
          .from(retentionClass)
          .where(and(isNull(retentionClass.tenantId), eq(retentionClass.recordClass, option)));
        if (!offered) throw problems.invalid("That staff file option is not in the schedule.");
        const [t] = await tx
          .update(tenant)
          .set({ staffFileOption: option })
          .where(and(eq(tenant.id, access.tenantId), eq(tenant.version, expectedVersion)))
          .returning({ version: tenant.version });
        if (!t)
          throw new HttpProblem(
            409,
            "version_conflict",
            "The organisation's settings changed since you opened them.",
            "Reload the checklist and try again.",
          );
        await auditInTx(tx, access, {
          action: "platform.retention.decided",
          resourceType: "tenant",
          resourceId: access.tenantId,
          scope: { recordClass: "staff_file", option },
          requestId: c.get("requestId"),
        });
        return { option, version: t.version };
      });
      return c.json(chosen, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/onboarding/dcb0160",
      tags: ["platform"],
      summary: "Record the organisation's DCB0160 assessment",
      description:
        "platform.onboarding.manage. Records that the organisation's CSO or clinical lead has assessed the deployment (DCB0160) against Harbour's safety case for this release; the version sent must be the current one (422 decision_not_recordable otherwise). Append-only. Audited (platform.dcb0160.recorded, with the version), refusals too.",
      security,
      request: { body: { content: { "application/json": { schema: Dcb0160Recording } } } },
      responses: decisionResponses,
    }),
    async (c) => {
      const access = await requirePermission(c, "platform.onboarding.manage");
      const { safetyCaseVersion } = c.req.valid("json");
      const action = "platform.dcb0160.recorded";
      const current = c.get("services").config.SAFETY_CASE_VERSION;
      const issue = checkDcb0160Recording({ safetyCaseVersion, currentSafetyCaseVersion: current });
      if (issue) return refuse(c, access, action, issue);
      const row = await withTenant(c, async (tx) => {
        const [r] = await tx
          .insert(dcb0160Record)
          .values({ safetyCaseVersion })
          .returning({ id: dcb0160Record.id, at: dcb0160Record.recordedAt });
        if (!r) throw problems.conflict();
        await auditInTx(tx, access, {
          action,
          resourceType: "dcb0160_record",
          resourceId: r.id,
          scope: { safetyCaseVersion },
          requestId: c.get("requestId"),
        });
        return r;
      });
      return c.json(recorded(row), 201);
    },
  );
