import {
  ApprovePayRuleSet,
  ChangePayRuleSet,
  CreatePayRuleSet,
  CreatePayRun,
  MyPayLines,
  OverridePayException,
  PayLineVerification,
  PayProfileItem,
  PayRuleSetItem,
  PayRuleSetList,
  PayRunDetail,
  PayRunExceptionItem,
  PayRunItem,
  type PayRunLineItem,
  PayRunList,
  PayRunVersion,
  PutPayProfile,
} from "@harbour/contracts";
import {
  payProfile,
  payRuleSet,
  payRun,
  payRunException,
  payRunLine,
  type Transaction,
  tenantUser,
} from "@harbour/db";
import {
  PAY_EXCEPTION_MESSAGES,
  type PayExceptionKind,
  type Permission,
  payLineInputFromJson,
  type RateRow,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Context } from "hono";
import { withAuditedRefusal, writeAudit } from "../http/audit";
import {
  type AppEnv,
  requireAnyPermission,
  requirePermission,
  type TenantAccess,
  withTenant,
} from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { publish } from "../outbox";
import {
  bankHolidaysIn,
  calculateLine,
  figuresOf,
  type LineRow,
  lineHash,
  lineInputs,
  type Nation,
  nationOfTenant,
  payRateRows,
  payRatesOrNull,
  priorOverride,
  type RuleSetRow,
  type RunRow,
  ratesByDay,
  ruleSetFull,
  ruleSetInForce,
} from "../services/pay";
import { payrollExportNotConfigured } from "../services/payroll-export";
import { type StaffLookup, staffNames } from "../services/staff";
import { withSystemRights } from "../services/system-rights";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";
import { audit } from "./people-shared";

/**
 * Pay calculation runs (scheduling.md section 18; SCHED-005, 006, 007; HZ-011). Pay is the
 * employer's: the pay permissions count only organisation-wide (rule 13). Runs are drafted and
 * calculated by a holder of scheduling.pay.manage, checked and locked by a holder of
 * scheduling.pay.approve who neither created nor calculated them; a locked run is corrected only in
 * a later run. Audit events carry ids only, never figures.
 */

const MANAGE: Permission = "scheduling.pay.manage";
const APPROVE: Permission = "scheduling.pay.approve";
const A = {
  ruleSetCreated: "scheduling.pay_rule_set.created",
  ruleSetChanged: "scheduling.pay_rule_set.changed",
  ruleSetApproved: "scheduling.pay_rule_set.approved",
  profileChanged: "scheduling.pay_profile.changed",
  profileViewed: "scheduling.pay_profile.viewed",
  runCreated: "scheduling.pay_run.created",
  runCalculated: "scheduling.pay_run.calculated",
  runViewed: "scheduling.pay_run.viewed",
  runLocked: "scheduling.pay_run.locked",
  overridden: "scheduling.pay_exception.overridden",
} as const;

const IdParam = z.object({ id: z.uuid() });
const iso = (d: Date | null) => (d ? d.toISOString() : null);
const stale = () =>
  new HttpProblem(
    409,
    "version_conflict",
    "This was changed by someone else since you loaded it. Reload it and try again.",
  );

function dbCode(error: unknown): string | undefined {
  return (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
}

/** Rule 13: a pay permission held for the whole organisation, or a refusal. */
async function requirePay(
  c: Context<AppEnv>,
  permissions: readonly [Permission, ...Permission[]],
): Promise<TenantAccess> {
  const access =
    permissions.length === 1
      ? await requirePermission(c, permissions[0])
      : await requireAnyPermission(c, permissions);
  // The database's own test (rule 13): a tenant-wide role or one with no location scope.
  const wide = await withTenant(c, async (tx) => {
    for (const p of permissions) {
      const r = await tx.execute<{ ok: boolean }>(sql`SELECT app.holds_pay_permission(${p}) AS ok`);
      if (r.rows[0]?.ok === true) return true;
    }
    return false;
  });
  if (!wide) {
    await writeAudit(c.get("services").appPool, access, {
      action: "scheduling.pay.refused",
      outcome: "denied",
      resourceType: "pay_run",
      reason: "pay_not_organisation_wide",
      requestId: c.get("requestId"),
    });
    throw new HttpProblem(
      403,
      "pay_not_organisation_wide",
      "Pay is organisation-wide: this needs the pay permission for the whole organisation.",
    );
  }
  return access;
}

/** A write in a transaction, with database refusals audited and said in words. */
async function payChange<T>(
  c: Context<AppEnv>,
  access: TenantAccess,
  what: { action: string; resourceType: string; id: string | null },
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  try {
    return await withAuditedRefusal(c, access, () => withTenant(c, fn));
  } catch (error) {
    const code = dbCode(error);
    if (!code || !["42501", "23000", "23503", "23505", "23514"].includes(code)) throw error;
    await writeAudit(c.get("services").appPool, access, {
      action: what.action,
      outcome: "denied",
      resourceType: what.resourceType,
      ...(what.id ? { resourceId: what.id } : {}),
      reason: code === "42501" ? "refused_by_database" : "invalid_state",
      requestId: c.get("requestId"),
    });
    if (code === "42501") throw problems.forbidden();
    if (code === "23505") {
      throw new HttpProblem(
        409,
        "already_exists",
        "There is already one: a draft rule set, a run for this period, or an open correction.",
      );
    }
    if (code === "23503") throw problems.invalid("A member or run named was not found.");
    throw problems.invalid("That does not fit the pay rules: check the figures and dates.");
  }
}

async function refuse(
  c: Context<AppEnv>,
  access: TenantAccess,
  what: { action: string; resourceType: string; id: string },
  reason: string,
  problem: HttpProblem,
): Promise<never> {
  await writeAudit(c.get("services").appPool, access, {
    action: what.action,
    outcome: "denied",
    resourceType: what.resourceType,
    resourceId: what.id,
    reason,
    requestId: c.get("requestId"),
  });
  throw problem;
}

function ruleSetItem(r: RuleSetRow): z.infer<typeof PayRuleSetItem> {
  return {
    id: r.id,
    version: r.version,
    versionNumber: r.versionNumber,
    name: r.name,
    effectiveFrom: r.effectiveFrom,
    roleRates: r.roleRates as Record<string, number>,
    enhancements: r.enhancements as z.infer<typeof PayRuleSetItem>["enhancements"],
    stackEnhancements: r.stackEnhancements,
    sleepInFlatPence: r.sleepInFlatPence,
    mileagePencePerMile: r.mileagePencePerMile,
    onCallFlatPence: r.onCallFlatPence,
    nightStartMinute: r.nightStartMinute,
    nightEndMinute: r.nightEndMinute,
    extraBankHolidays: r.extraBankHolidays,
    overtimeAfterMinutes: r.overtimeAfterMinutes,
    rolledUpHoliday: r.rolledUpHoliday,
    status: r.status as "draft" | "approved",
    approvedBy: r.approvedBy,
    approvedAt: iso(r.approvedAt),
  };
}

const ruleSetValues = (b: z.infer<typeof CreatePayRuleSet>) => {
  if ((b.nightStartMinute === null) !== (b.nightEndMinute === null)) {
    throw problems.invalid("A night window has a start and an end, or neither.");
  }
  if (b.nightStartMinute !== null && b.nightStartMinute === b.nightEndMinute) {
    throw problems.invalid("A night window starts and ends at different times.");
  }
  return {
    name: b.name,
    effectiveFrom: b.effectiveFrom,
    roleRates: b.roleRates,
    enhancements: b.enhancements,
    stackEnhancements: b.stackEnhancements,
    sleepInFlatPence: b.sleepInFlatPence,
    mileagePencePerMile: b.mileagePencePerMile,
    onCallFlatPence: b.onCallFlatPence,
    nightStartMinute: b.nightStartMinute,
    nightEndMinute: b.nightEndMinute,
    extraBankHolidays: [...new Set(b.extraBankHolidays)].sort(),
    overtimeAfterMinutes: b.overtimeAfterMinutes,
    rolledUpHoliday: b.rolledUpHoliday,
  };
};

function lineItem(l: LineRow, names: StaffLookup = () => null): z.infer<typeof PayRunLineItem> {
  return {
    id: l.id,
    runId: l.runId,
    calculation: l.calculation,
    memberId: l.memberId,
    memberName: names(l.memberId)?.displayName ?? null,
    paidMinutes: l.paidMinutes,
    nmwMinutes: l.nmwMinutes,
    basicPence: l.basicPence,
    premiumPence: l.premiumPence,
    sleepInPence: l.sleepInPence,
    onCallPence: l.onCallPence,
    mileagePence: l.mileagePence,
    nmwTopUpPence: l.nmwTopUpPence,
    rolledUpHolidayPence: l.rolledUpHolidayPence,
    sspPence: l.sspPence,
    totalPence: l.totalPence,
    differencePence: l.differencePence,
    holidayAccruedMinutes: l.holidayAccruedMinutes,
    nmwBand: l.nmwBand,
    aeCategory: l.aeCategory,
    qualifyingEarningsPence: l.qualifyingEarningsPence,
    working: (l.working as { step: string; pence?: number; rateKey?: string }[]).map((w) => ({
      step: w.step,
      pence: w.pence ?? null,
      rateKey: w.rateKey ?? null,
    })),
    inputHash: l.inputHash,
  };
}

function exceptionItem(
  e: typeof payRunException.$inferSelect,
  names: StaffLookup = () => null,
): z.infer<typeof PayRunExceptionItem> {
  return {
    id: e.id,
    version: e.version,
    calculation: e.calculation,
    memberId: e.memberId,
    memberName: names(e.memberId)?.displayName ?? null,
    kind: e.kind as PayExceptionKind,
    ref: e.ref,
    message: PAY_EXCEPTION_MESSAGES[e.kind as PayExceptionKind],
    status: e.status as "open" | "overridden",
    overrideReason: e.overrideReason,
    overriddenBy: e.overriddenBy,
    overriddenAt: iso(e.overriddenAt),
  };
}

async function openExceptions(tx: Transaction, run: RunRow): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(payRunException)
    .where(
      and(
        eq(payRunException.runId, run.id),
        eq(payRunException.calculation, run.calculation),
        eq(payRunException.status, "open"),
      ),
    );
  return row?.n ?? 0;
}

async function runItem(tx: Transaction, r: RunRow): Promise<z.infer<typeof PayRunItem>> {
  return {
    id: r.id,
    version: r.version,
    frequency: r.frequency as "weekly" | "monthly",
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    kind: r.kind as "regular" | "correction",
    correctsRunId: r.correctsRunId,
    ruleSetId: r.ruleSetId,
    nation: r.nation,
    calculation: r.calculation,
    calculatedAt: iso(r.calculatedAt),
    calculatedBy: r.calculatedBy,
    status: r.status as "draft" | "locked",
    lockedBy: r.lockedBy,
    lockedAt: iso(r.lockedAt),
    createdBy: r.createdBy,
    openExceptions: await openExceptions(tx, r),
  };
}

async function loadRun(tx: Transaction, id: string): Promise<RunRow | null> {
  const [r] = await tx
    .select()
    .from(payRun)
    .where(and(eq(payRun.id, id), isNull(payRun.deletedAt)));
  return r ?? null;
}

async function runDetail(tx: Transaction, r: RunRow): Promise<z.infer<typeof PayRunDetail>> {
  const lines = await tx
    .select()
    .from(payRunLine)
    .where(and(eq(payRunLine.runId, r.id), eq(payRunLine.calculation, r.calculation)))
    .orderBy(payRunLine.memberId);
  const exceptions = await tx
    .select()
    .from(payRunException)
    .where(and(eq(payRunException.runId, r.id), eq(payRunException.calculation, r.calculation)))
    .orderBy(payRunException.memberId, payRunException.kind);
  // Pay is organisation-wide: the names of everyone on the run, read with the system's rights.
  const names = await withSystemRights(tx, () =>
    staffNames(tx, [...lines.map((l) => l.memberId), ...exceptions.map((e) => e.memberId)]),
  );
  return {
    run: await runItem(tx, r),
    lines: lines.map((l) => lineItem(l, names)),
    exceptions: exceptions.map((e) => exceptionItem(e, names)),
  };
}

/** A pay period: a week is seven days; a month, a calendar month's length. */
function checkPeriod(b: z.infer<typeof CreatePayRun>) {
  const days = Math.round((Date.parse(b.periodEnd) - Date.parse(b.periodStart)) / 86_400_000) + 1;
  const ok = b.frequency === "weekly" ? days === 7 : days >= 28 && days <= 31;
  if (!ok) {
    throw problems.invalid(
      b.frequency === "weekly"
        ? "A weekly pay period is seven days."
        : "A monthly pay period is a month long (28 to 31 days).",
    );
  }
}

export const payRouter = createRouter()
  // ----------------------------------------------------------------------------------------
  // Rule sets (rule 1)
  // ----------------------------------------------------------------------------------------
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/pay-rule-sets",
      tags: ["scheduling"],
      summary: "Pay rule sets",
      security,
      responses: { 200: jsonBody(PayRuleSetList, "Rule sets"), ...errorResponses },
    }),
    async (c) => {
      await requirePay(c, [MANAGE, APPROVE]);
      const rows = await withTenant(c, (tx) =>
        tx
          .select()
          .from(payRuleSet)
          .where(isNull(payRuleSet.deletedAt))
          .orderBy(desc(payRuleSet.versionNumber)),
      );
      return c.json({ items: rows.map(ruleSetItem) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/pay-rule-sets",
      tags: ["scheduling"],
      summary: "Write a draft pay rule set",
      description:
        "The organisation's own rates (never statutory figures, which come from the rate table). One draft at a time; approved by someone who neither wrote nor changed it.",
      security,
      request: { body: jsonBody(CreatePayRuleSet, "The rule set") },
      responses: {
        201: jsonBody(PayRuleSetItem, "Drafted"),
        ...errorResponses,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePay(c, [MANAGE]);
      const values = ruleSetValues(c.req.valid("json"));
      const row = await payChange(
        c,
        access,
        { action: A.ruleSetCreated, resourceType: "pay_rule_set", id: null },
        async (tx) => {
          const [last] = await withSystemRights(tx, () =>
            tx
              .select({ n: sql<number>`coalesce(max(${payRuleSet.versionNumber}), 0)::int` })
              .from(payRuleSet),
          );
          const [made] = await tx
            .insert(payRuleSet)
            .values({ ...values, versionNumber: (last?.n ?? 0) + 1 })
            .returning();
          if (!made) throw new Error("rule set not stored");
          await audit(c, tx, access, {
            action: A.ruleSetCreated,
            resourceType: "pay_rule_set",
            resourceId: made.id,
          });
          return made;
        },
      );
      return c.json(ruleSetItem(row), 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/v1/pay-rule-sets/{id}",
      tags: ["scheduling"],
      summary: "Change a draft pay rule set",
      security,
      request: { params: IdParam, body: jsonBody(ChangePayRuleSet, "The rule set") },
      responses: {
        200: jsonBody(PayRuleSetItem, "Changed"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePay(c, [MANAGE]);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const values = ruleSetValues(body);
      const row = await payChange(
        c,
        access,
        { action: A.ruleSetChanged, resourceType: "pay_rule_set", id },
        async (tx) => {
          const [current] = await tx.select().from(payRuleSet).where(eq(payRuleSet.id, id));
          if (!current) throw problems.notFound();
          if (current.status !== "draft") {
            throw new HttpProblem(
              409,
              "rule_set_approved",
              "An approved rule set never changes: write a new version.",
            );
          }
          const [saved] = await tx
            .update(payRuleSet)
            .set(values)
            .where(and(eq(payRuleSet.id, id), eq(payRuleSet.version, body.version)))
            .returning();
          if (!saved) throw stale();
          await audit(c, tx, access, {
            action: A.ruleSetChanged,
            resourceType: "pay_rule_set",
            resourceId: id,
          });
          return saved;
        },
      );
      return c.json(ruleSetItem(row), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/pay-rule-sets/{id}/approve",
      tags: ["scheduling"],
      summary: "Approve a pay rule set",
      description: "By a holder of scheduling.pay.approve who neither wrote nor changed it.",
      security,
      request: { params: IdParam, body: jsonBody(ApprovePayRuleSet, "Against version") },
      responses: {
        200: jsonBody(PayRuleSetItem, "Approved"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePay(c, [APPROVE]);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const what = { action: A.ruleSetApproved, resourceType: "pay_rule_set", id };
      const row = await payChange(c, access, what, async (tx) => {
        const [current] = await tx.select().from(payRuleSet).where(eq(payRuleSet.id, id));
        if (!current) throw problems.notFound();
        if (current.contributorIds.includes(access.tenantUserId)) {
          return refuse(
            c,
            access,
            what,
            "separation_of_duties",
            new HttpProblem(
              403,
              "separation_of_duties",
              "Someone who neither wrote nor changed this rule set must approve it.",
            ),
          );
        }
        if (current.status !== "draft") {
          throw new HttpProblem(409, "rule_set_approved", "This rule set is already approved.");
        }
        const [saved] = await tx
          .update(payRuleSet)
          .set({ status: "approved", approvedBy: access.tenantUserId, approvedAt: new Date() })
          .where(and(eq(payRuleSet.id, id), eq(payRuleSet.version, body.version)))
          .returning();
        if (!saved) throw stale();
        await audit(c, tx, access, { ...what, resourceId: id });
        return saved;
      });
      return c.json(ruleSetItem(row), 200);
    },
  )
  // ----------------------------------------------------------------------------------------
  // Pay profiles (rule 2)
  // ----------------------------------------------------------------------------------------
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/members/{id}/pay-profile",
      tags: ["scheduling"],
      summary: "A member's pay profile",
      description: "Pay holders across the organisation, or the member themselves.",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(PayProfileItem, "The profile"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const own = id === c.get("access").tenantUserId;
      const access = own
        ? await requireAnyPermission(c, ["scheduling.timesheet.self", MANAGE, APPROVE])
        : await requirePay(c, [MANAGE, APPROVE]);
      const row = await withTenant(c, async (tx) => {
        const [r] = await tx.select().from(payProfile).where(eq(payProfile.memberId, id));
        await audit(c, tx, access, {
          action: A.profileViewed,
          resourceType: "tenant_user",
          resourceId: id,
        });
        return r ?? null;
      });
      return c.json(
        {
          memberId: id,
          version: row?.version ?? null,
          frequency: (row?.frequency ?? null) as "weekly" | "monthly" | null,
          employment: (row?.employment ?? "staff") as "staff" | "bank" | "agency",
          roleKey: row?.roleKey ?? null,
          apprenticeshipStartedOn: row?.apprenticeshipStartedOn ?? null,
          irregularHours: row?.irregularHours ?? false,
          leaveYearStart: row?.leaveYearStart ?? null,
          qualifyingWeekdays: row?.qualifyingWeekdays ?? [],
          sspAverageWeeklyEarningsPence: row?.sspAverageWeeklyEarningsPence ?? null,
          statePensionAgeOn: row?.statePensionAgeOn ?? null,
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/members/{id}/pay-profile",
      tags: ["scheduling"],
      summary: "Set a member's pay profile",
      description: "Never one's own. Earnings for SSP are in the body, never the address.",
      security,
      request: { params: IdParam, body: jsonBody(PutPayProfile, "The profile") },
      responses: {
        200: jsonBody(PayProfileItem, "Set"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePay(c, [MANAGE]);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const what = { action: A.profileChanged, resourceType: "tenant_user", id };
      if (id === access.tenantUserId) {
        await refuse(
          c,
          access,
          what,
          "own_profile",
          new HttpProblem(
            403,
            "separation_of_duties",
            "Someone else must set your own pay profile.",
          ),
        );
      }
      const values = {
        frequency: body.frequency,
        employment: body.employment,
        roleKey: body.roleKey,
        apprenticeshipStartedOn: body.apprenticeshipStartedOn,
        irregularHours: body.irregularHours,
        leaveYearStart: body.leaveYearStart,
        qualifyingWeekdays: [...new Set(body.qualifyingWeekdays)].sort(),
        sspAverageWeeklyEarningsPence: body.sspAverageWeeklyEarningsPence,
        statePensionAgeOn: body.statePensionAgeOn,
      };
      const row = await payChange(c, access, what, async (tx) => {
        const [member] = await withSystemRights(tx, () =>
          tx.select({ id: tenantUser.id }).from(tenantUser).where(eq(tenantUser.id, id)),
        );
        if (!member) throw problems.notFound();
        const [current] = await tx.select().from(payProfile).where(eq(payProfile.memberId, id));
        let saved: typeof payProfile.$inferSelect | undefined;
        if (!current) {
          if (body.version !== null) throw stale();
          [saved] = await tx
            .insert(payProfile)
            .values({ memberId: id, ...values })
            .returning();
        } else {
          [saved] = await tx
            .update(payProfile)
            .set(values)
            .where(and(eq(payProfile.id, current.id), eq(payProfile.version, body.version ?? -1)))
            .returning();
        }
        if (!saved) throw stale();
        await audit(c, tx, access, { ...what, resourceId: id });
        return saved;
      });
      return c.json(
        {
          memberId: id,
          version: row.version,
          frequency: row.frequency as "weekly" | "monthly",
          employment: row.employment as "staff" | "bank" | "agency",
          roleKey: row.roleKey,
          apprenticeshipStartedOn: row.apprenticeshipStartedOn,
          irregularHours: row.irregularHours,
          leaveYearStart: row.leaveYearStart,
          qualifyingWeekdays: row.qualifyingWeekdays,
          sspAverageWeeklyEarningsPence: row.sspAverageWeeklyEarningsPence,
          statePensionAgeOn: row.statePensionAgeOn,
        },
        200,
      );
    },
  )
  // ----------------------------------------------------------------------------------------
  // Runs (rules 3 to 14)
  // ----------------------------------------------------------------------------------------
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/pay-runs",
      tags: ["scheduling"],
      summary: "Pay runs",
      security,
      responses: { 200: jsonBody(PayRunList, "Runs"), ...errorResponses },
    }),
    async (c) => {
      await requirePay(c, [MANAGE, APPROVE]);
      const items = await withTenant(c, async (tx) => {
        const rows = await tx
          .select()
          .from(payRun)
          .where(isNull(payRun.deletedAt))
          .orderBy(desc(payRun.periodStart), desc(payRun.createdAt));
        return Promise.all(rows.map((r) => runItem(tx, r)));
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/pay-runs",
      tags: ["scheduling"],
      summary: "Draft a pay run for a period",
      description:
        "Uses the approved rule set in force on the period's first day. One regular run a period.",
      security,
      request: { body: jsonBody(CreatePayRun, "The period") },
      responses: {
        201: jsonBody(PayRunItem, "Drafted"),
        ...errorResponses,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePay(c, [MANAGE]);
      const body = c.req.valid("json");
      checkPeriod(body);
      const item = await payChange(
        c,
        access,
        { action: A.runCreated, resourceType: "pay_run", id: null },
        async (tx) => {
          const set = await ruleSetInForce(tx, body.periodStart);
          if (!set) {
            throw new HttpProblem(
              422,
              "no_rule_set",
              "There is no approved pay rule set in force on the period's first day.",
            );
          }
          const [made] = await tx
            .insert(payRun)
            .values({
              frequency: body.frequency,
              periodStart: body.periodStart,
              periodEnd: body.periodEnd,
              ruleSetId: set.id,
              nation: await nationOfTenant(tx),
            })
            .returning();
          if (!made) throw new Error("pay run not stored");
          await audit(c, tx, access, {
            action: A.runCreated,
            resourceType: "pay_run",
            resourceId: made.id,
          });
          return runItem(tx, made);
        },
      );
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/pay-runs/{id}",
      tags: ["scheduling"],
      summary: "A pay run with its lines and exceptions",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(PayRunDetail, "The run"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePay(c, [MANAGE, APPROVE]);
      const { id } = c.req.valid("param");
      const detail = await withTenant(c, async (tx) => {
        const r = await loadRun(tx, id);
        if (!r) throw problems.notFound();
        await audit(c, tx, access, {
          action: A.runViewed,
          resourceType: "pay_run",
          resourceId: id,
        });
        return runDetail(tx, r);
      });
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/pay-runs/{id}/calculate",
      tags: ["scheduling"],
      summary: "Calculate a draft pay run",
      description:
        "From approved timesheets and recorded sickness only, with the slice 6 rules and the rate table's figures for the period (stored with the run). Each line keeps its working and canonical inputs; exceptions block locking.",
      security,
      request: { params: IdParam, body: jsonBody(PayRunVersion, "Against version") },
      responses: {
        200: jsonBody(PayRunDetail, "Calculated"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePay(c, [MANAGE]);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const what = { action: A.runCalculated, resourceType: "pay_run", id };
      const detail = await payChange(c, access, what, async (tx) => {
        const r = await loadRun(tx, id);
        if (!r) throw problems.notFound();
        if (r.status !== "draft") {
          throw new HttpProblem(409, "run_locked", "A locked run never changes: correct it.");
        }
        const setRow = await ruleSetInForce(tx, r.periodStart);
        if (!setRow) {
          throw new HttpProblem(
            422,
            "no_rule_set",
            "There is no approved pay rule set in force on the period's first day.",
          );
        }
        const nation: Nation = await nationOfTenant(tx);
        const rows = await payRateRows(tx);
        const rates = payRatesOrNull(rows, nation, r.periodStart, access.tenantId);
        // A night may run past the period's end: its hours there are paid in this run (rule 3).
        const lastDay = new Date(Date.parse(`${r.periodEnd}T12:00:00Z`) + 2 * 86_400_000)
          .toISOString()
          .slice(0, 10);
        const holidays = await bankHolidaysIn(tx, nation, r.periodStart, lastDay);
        const set = ruleSetFull(setRow, holidays);
        const inputs = await lineInputs(tx, r, set, rows, nation, access.tenantId, rates);
        const [next] = await tx
          .update(payRun)
          .set({
            calculation: r.calculation + 1,
            calculatedBy: access.tenantUserId,
            calculatedAt: new Date(),
            ruleSetId: setRow.id,
            nation,
            rateRows: rows,
          })
          .where(and(eq(payRun.id, id), eq(payRun.version, body.version)))
          .returning();
        if (!next) throw stale();
        for (const input of inputs) {
          const line = calculateLine(input, rates, ratesByDay(rows, nation, access.tenantId));
          const hash = lineHash(line.canonicalInput, rates);
          await tx.insert(payRunLine).values({
            runId: id,
            calculation: next.calculation,
            memberId: line.memberId,
            paidMinutes: line.paidMinutes,
            nmwMinutes: line.nmwMinutes,
            basicPence: line.basicPence,
            premiumPence: line.premiumPence,
            sleepInPence: line.sleepInPence,
            onCallPence: line.onCallPence,
            mileagePence: line.mileagePence,
            nmwTopUpPence: line.nmwTopUpPence,
            rolledUpHolidayPence: line.rolledUpHolidayPence,
            sspPence: line.sspPence,
            totalPence: line.totalPence,
            differencePence: line.differencePence,
            holidayAccruedMinutes: line.holidayAccruedMinutes,
            nmwBand: line.nmwBand,
            aeCategory: line.aeCategory,
            qualifyingEarningsPence: line.qualifyingEarningsPence,
            working: line.working,
            inputs: JSON.parse(line.canonicalInput),
            inputHash: hash,
          });
          for (const e of line.exceptions) {
            const prior = await priorOverride(
              tx,
              id,
              next.calculation,
              line.memberId,
              e.kind,
              e.ref,
              hash,
            );
            await tx.insert(payRunException).values({
              runId: id,
              calculation: next.calculation,
              memberId: line.memberId,
              kind: e.kind,
              ref: e.ref,
              lineInputHash: hash,
              ...(prior
                ? {
                    status: "overridden",
                    overrideReason: prior.overrideReason,
                    overriddenBy: prior.overriddenBy,
                    overriddenAt: prior.overriddenAt,
                  }
                : {}),
            });
          }
        }
        await audit(c, tx, access, { ...what, resourceId: id });
        return runDetail(tx, next);
      });
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/pay-run-exceptions/{id}/override",
      tags: ["scheduling"],
      summary: "Override a pay run exception with a reason",
      description: "By a holder of scheduling.pay.approve, never on their own line.",
      security,
      request: { params: IdParam, body: jsonBody(OverridePayException, "The reason") },
      responses: {
        200: jsonBody(PayRunExceptionItem, "Overridden"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePay(c, [APPROVE]);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const what = { action: A.overridden, resourceType: "pay_run_exception", id };
      const row = await payChange(c, access, what, async (tx) => {
        const [e] = await tx.select().from(payRunException).where(eq(payRunException.id, id));
        if (!e) throw problems.notFound();
        if (e.memberId === access.tenantUserId) {
          return refuse(
            c,
            access,
            what,
            "own_line",
            new HttpProblem(
              403,
              "separation_of_duties",
              "Someone else must override an exception on your own pay.",
            ),
          );
        }
        const r = await loadRun(tx, e.runId);
        if (r?.status !== "draft" || r.calculation !== e.calculation || e.status !== "open") {
          throw new HttpProblem(
            409,
            "exception_closed",
            "Only an open exception of a draft run's latest calculation can be overridden.",
          );
        }
        const [saved] = await tx
          .update(payRunException)
          .set({
            status: "overridden",
            overrideReason: body.reason,
            overriddenBy: access.tenantUserId,
            overriddenAt: new Date(),
          })
          .where(and(eq(payRunException.id, id), eq(payRunException.version, body.version)))
          .returning();
        if (!saved) throw stale();
        await audit(c, tx, access, {
          ...what,
          resourceId: id,
          scopeExtra: { runId: e.runId, kind: e.kind },
        });
        return saved;
      });
      return c.json(exceptionItem(row), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/pay-runs/{id}/lock",
      tags: ["scheduling"],
      summary: "Check and lock a pay run",
      description:
        "By a holder of scheduling.pay.approve who neither created nor calculated it, with no open exception. A locked run never changes; it is offered to the payroll export (slice 76).",
      security,
      request: { params: IdParam, body: jsonBody(PayRunVersion, "Against version") },
      responses: {
        200: jsonBody(PayRunItem, "Locked"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePay(c, [APPROVE]);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const what = { action: A.runLocked, resourceType: "pay_run", id };
      const { item, lineIds, run } = await payChange(c, access, what, async (tx) => {
        const r = await loadRun(tx, id);
        if (!r) throw problems.notFound();
        if (r.createdBy === access.tenantUserId || r.calculatedBy === access.tenantUserId) {
          return refuse(
            c,
            access,
            what,
            "separation_of_duties",
            new HttpProblem(
              403,
              "separation_of_duties",
              "Someone who neither created nor calculated this run must check and lock it.",
            ),
          );
        }
        if (r.status !== "draft") {
          throw new HttpProblem(409, "run_locked", "This run is already locked.");
        }
        if (r.calculation < 1) {
          throw new HttpProblem(409, "not_calculated", "Calculate the run before locking it.");
        }
        if ((await openExceptions(tx, r)) > 0) {
          throw new HttpProblem(
            409,
            "exceptions_open",
            "Put right or override every open exception before locking the run.",
          );
        }
        const [saved] = await tx
          .update(payRun)
          .set({ status: "locked", lockedBy: access.tenantUserId, lockedAt: new Date() })
          .where(and(eq(payRun.id, id), eq(payRun.version, body.version)))
          .returning();
        if (!saved) throw stale();
        const lines = await tx
          .select({ id: payRunLine.id })
          .from(payRunLine)
          .where(and(eq(payRunLine.runId, id), eq(payRunLine.calculation, saved.calculation)));
        await publish(tx, {
          context: "scheduling",
          aggregateType: "pay_run",
          aggregateId: id,
          type: "scheduling.pay_run_locked",
          payload: {
            runId: id,
            frequency: saved.frequency,
            periodStart: saved.periodStart,
            periodEnd: saved.periodEnd,
            kind: saved.kind,
          },
        });
        await audit(c, tx, access, { ...what, resourceId: id });
        return { item: await runItem(tx, saved), lineIds: lines.map((l) => l.id), run: saved };
      });
      await payrollExportNotConfigured.offer({
        id: run.id,
        frequency: run.frequency,
        periodStart: run.periodStart,
        periodEnd: run.periodEnd,
        kind: run.kind,
        lineIds,
      });
      return c.json(item, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/pay-runs/{id}/corrections",
      tags: ["scheduling"],
      summary: "Start a correction of a locked pay run",
      description:
        "A new draft for the same period; each line shows its difference from the locked run it corrects. One open correction at a time.",
      security,
      request: { params: IdParam },
      responses: {
        201: jsonBody(PayRunItem, "Drafted"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePay(c, [MANAGE]);
      const { id } = c.req.valid("param");
      const item = await payChange(
        c,
        access,
        { action: A.runCreated, resourceType: "pay_run", id },
        async (tx) => {
          const r = await loadRun(tx, id);
          if (!r) throw problems.notFound();
          if (r.status !== "locked" || r.kind !== "regular") {
            throw new HttpProblem(
              409,
              "not_correctable",
              "Only a locked regular run is corrected, in a correction run.",
            );
          }
          const set = await ruleSetInForce(tx, r.periodStart);
          const [made] = await tx
            .insert(payRun)
            .values({
              frequency: r.frequency,
              periodStart: r.periodStart,
              periodEnd: r.periodEnd,
              kind: "correction",
              correctsRunId: r.id,
              ruleSetId: set?.id ?? r.ruleSetId,
              nation: r.nation,
            })
            .returning();
          if (!made) throw new Error("pay run not stored");
          await audit(c, tx, access, {
            action: A.runCreated,
            resourceType: "pay_run",
            resourceId: made.id,
            scopeExtra: { correctsRunId: r.id },
          });
          return runItem(tx, made);
        },
      );
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/pay-runs/{id}/lines/{lineId}/verify",
      tags: ["scheduling"],
      summary: "Recalculate a line from its stored inputs",
      description:
        "From the line's canonical inputs and the run's stored rate rows: the same figures and hash, or the figures that differ.",
      security,
      request: { params: z.object({ id: z.uuid(), lineId: z.uuid() }) },
      responses: {
        200: jsonBody(PayLineVerification, "The check"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePay(c, [MANAGE, APPROVE]);
      const { id, lineId } = c.req.valid("param");
      const out = await withTenant(c, async (tx) => {
        const r = await loadRun(tx, id);
        const [l] = await tx
          .select()
          .from(payRunLine)
          .where(and(eq(payRunLine.id, lineId), eq(payRunLine.runId, id)));
        if (!r || !l) throw problems.notFound();
        const rates = payRatesOrNull(
          r.rateRows as RateRow[],
          r.nation as Nation,
          r.periodStart,
          access.tenantId,
        );
        const stored = r.rateRows as RateRow[];
        const again = calculateLine(
          payLineInputFromJson(l.inputs),
          rates,
          ratesByDay(stored, r.nation as Nation, access.tenantId),
        );
        const hash = lineHash(again.canonicalInput, rates);
        const was = figuresOf(l);
        const fresh = figuresOf(again);
        const differences = Object.keys(was).filter((k) => was[k] !== fresh[k]);
        await audit(c, tx, access, {
          action: A.runViewed,
          resourceType: "pay_run",
          resourceId: id,
          scopeExtra: { lineId },
        });
        return {
          lineId,
          reproduced: hash === l.inputHash && differences.length === 0,
          storedHash: l.inputHash,
          recalculatedHash: hash,
          differences,
        };
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/me/pay-lines",
      tags: ["scheduling"],
      summary: "My lines in locked pay runs",
      security,
      responses: { 200: jsonBody(MyPayLines, "Lines"), ...errorResponses },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [
        "workforce.self.read",
        "scheduling.timesheet.self",
      ]);
      const items = await withTenant(c, async (tx) => {
        const rows = await tx
          .select({ l: payRunLine, r: payRun })
          .from(payRunLine)
          .innerJoin(payRun, eq(payRun.id, payRunLine.runId))
          .where(
            and(
              eq(payRunLine.memberId, access.tenantUserId),
              eq(payRun.status, "locked"),
              eq(payRunLine.calculation, payRun.calculation),
            ),
          )
          .orderBy(desc(payRun.periodStart), desc(payRun.lockedAt));
        return rows.map(({ l, r }) => ({
          line: lineItem(l),
          periodStart: r.periodStart,
          periodEnd: r.periodEnd,
          kind: r.kind as "regular" | "correction",
          lockedAt: (r.lockedAt as Date).toISOString(),
        }));
      });
      return c.json({ items }, 200);
    },
  );
