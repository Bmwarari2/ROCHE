import { createHash } from "node:crypto";
import {
  HR_LINK_PORT,
  hrPayPeriod,
  hrPayRate,
  hrPayUnit,
  hrSyncState,
  integrationConnection,
  payRun,
  type Transaction,
} from "@harbour/db";
import {
  type HrPayPeriod,
  type HrRate,
  hrPayUnits,
  inboundPayPeriod,
  inboundRate,
  type MemberUnits,
  matchesHrPayPeriod,
  type PayRoute,
  type PayUnitTotal,
  payrollExportAllowed,
  payUnitsToHrAllowed,
  type ThapsusHrPort,
} from "@harbour/domain";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  type HrConnection,
  type HrLinkSettings,
  hrConnection,
  hrLinkEnabled,
  raiseHrAlert,
  recordSync,
} from "./hr-link";
import { audit, deliver, members } from "./hr-rota";

/**
 * Pay through Thapsus-HR (integrations.md section 11.5 rules 11 and 12; slice 89; ADR-0131;
 * HZ-133, HZ-140). Thapsus-HR's pay periods and hourly rates are read daily; a pay run whose
 * period goes to Thapsus-HR uses its pay period exactly and its rate for the minimum wage check;
 * when it is locked, its units by kind are kept and sent by pay code, replacing that period's
 * items in Thapsus-HR; Harbour's payroll export is never offered that period. Everything else
 * pays through Harbour's export as before.
 */

/** Pay periods and rates are read once a day (section 11.2). */
const PAY_PULL_HOURS = 24;

export type PayPath =
  /** Not linked, the flag off or the link disconnected: Harbour's export, as before. */
  | { readonly route: "harbour_export"; readonly link: null }
  | { readonly route: PayRoute; readonly link: HrConnection }
  /** A route date that is not a real day: nothing is paid out until a person puts it right. */
  | { readonly route: null; readonly link: HrConnection };

/** The route to payroll for a pay period starting on `periodStart` (rule 12). */
export async function payPathFor(tx: Transaction, periodStart: string): Promise<PayPath> {
  const link = await hrConnection(tx);
  if (link?.status !== "connected" || !(await hrLinkEnabled(tx))) {
    return { route: "harbour_export", link: null };
  }
  const input = {
    currentRoute: link.settings.pay.route,
    pendingRoute: link.settings.pay.pendingRoute,
    pendingFrom: link.settings.pay.pendingFrom,
    periodStart,
  };
  if (payUnitsToHrAllowed(input)) return { route: "thapsus_hr", link };
  if (payrollExportAllowed(input)) return { route: "harbour_export", link };
  return { route: null, link };
}

/** Thapsus-HR's pay periods as stored (the sync's copies). */
export async function storedHrPayPeriods(tx: Transaction) {
  return tx
    .select({
      rowId: hrPayPeriod.id,
      id: hrPayPeriod.hrId,
      frequency: hrPayPeriod.frequency,
      startsOn: hrPayPeriod.startsOn,
      endsOn: hrPayPeriod.endsOn,
    })
    .from(hrPayPeriod)
    .where(isNull(hrPayPeriod.deletedAt));
}

/** The stored Thapsus-HR pay period a run's period is, exactly; null when none is. */
export async function hrPayPeriodOf(
  tx: Transaction,
  run: { readonly frequency: string; readonly periodStart: string; readonly periodEnd: string },
): Promise<{ readonly rowId: string; readonly hrId: string } | null> {
  const periods = await storedHrPayPeriods(tx);
  const hit = matchesHrPayPeriod(run, periods as unknown as HrPayPeriod[]);
  const row = hit ? periods.find((p) => p.id === hit.id) : undefined;
  return row ? { rowId: row.rowId, hrId: row.id } : null;
}

/** Each member's Thapsus-HR rates (by tenant user), for the minimum wage check (rule 11). */
export async function hrRatesByMember(tx: Transaction): Promise<Map<string, HrRate[]>> {
  const { linked } = await members(tx);
  const byProfile = new Map([...linked.values()].map((m) => [m.staffProfileId, m.memberId]));
  const rows = await tx
    .select({
      staffProfileId: hrPayRate.staffProfileId,
      hourlyPence: hrPayRate.hourlyPence,
      effectiveFrom: hrPayRate.effectiveFrom,
    })
    .from(hrPayRate)
    .where(isNull(hrPayRate.deletedAt));
  const out = new Map<string, HrRate[]>();
  for (const r of rows) {
    const member = byProfile.get(r.staffProfileId);
    if (!member) continue;
    const list = out.get(member) ?? [];
    list.push({ employeeId: member, hourlyPence: r.hourlyPence, effectiveFrom: r.effectiveFrom });
    out.set(member, list);
  }
  return out;
}

export interface PayPullOutcome {
  readonly periods: number;
  readonly rates: number;
  readonly failed: number;
  readonly error: string | null;
}

/**
 * Pay periods and hourly rates in (rule 11; K5), once a day or when asked: each record checked
 * at the boundary and written by the sync alone; a record that cannot be read is raised and the
 * run is not a good sync. Nothing while Thapsus-HR's pay read is planned.
 */
export async function pullPay(
  tx: Transaction,
  tenantId: string,
  port: ThapsusHrPort,
  now: Date,
  force = false,
): Promise<PayPullOutcome | null> {
  if (port.capabilities().pay_rates_read !== "available") return null;
  if (!force) {
    const [state] = await tx
      .select({ at: hrSyncState.lastAttemptAt })
      .from(hrSyncState)
      .where(eq(hrSyncState.kind, "rates"));
    if (state?.at && now.getTime() - state.at.getTime() < PAY_PULL_HOURS * 3_600_000) return null;
  }
  const out = { periods: 0, rates: 0, failed: 0 };
  const failedIds: string[] = [];
  const periods = await port.payPeriods();
  if (!periods.ok) {
    await recordSync(tx, "rates", now, periods.error);
    return { ...out, error: periods.error };
  }
  for (const raw of periods.value) {
    const p = inboundPayPeriod(raw);
    if (!p) {
      out.failed += 1;
      failedIds.push(typeof raw.id === "string" ? raw.id.slice(0, 64) : "invalid");
      continue;
    }
    try {
      await tx.transaction(async (sp) => {
        const [known] = await sp
          .select({
            id: hrPayPeriod.id,
            frequency: hrPayPeriod.frequency,
            startsOn: hrPayPeriod.startsOn,
            endsOn: hrPayPeriod.endsOn,
          })
          .from(hrPayPeriod)
          .where(and(eq(hrPayPeriod.hrId, p.id), isNull(hrPayPeriod.deletedAt)));
        if (!known) {
          await sp.insert(hrPayPeriod).values({
            hrId: p.id,
            frequency: p.frequency,
            startsOn: p.startsOn,
            endsOn: p.endsOn,
            lastSeenAt: now,
            createdBy: null,
            updatedBy: null,
          });
          out.periods += 1;
          return;
        }
        // A period's dates never move once a run may rely on them: a change is raised.
        if (
          known.frequency !== p.frequency ||
          known.startsOn !== p.startsOn ||
          known.endsOn !== p.endsOn
        ) {
          throw new Error("pay period changed");
        }
        await sp
          .update(hrPayPeriod)
          .set({ lastSeenAt: now, updatedBy: null })
          .where(eq(hrPayPeriod.id, known.id));
      });
    } catch {
      out.failed += 1;
      failedIds.push(p.id);
    }
  }
  const { linked } = await members(tx);
  const employees = [...linked.keys()];
  if (employees.length > 0) {
    const rates = await port.rates(employees);
    if (!rates.ok) {
      await recordSync(tx, "rates", now, rates.error);
      return { ...out, error: rates.error };
    }
    for (const raw of rates.value) {
      const r = inboundRate(raw);
      const member = r ? linked.get(r.employeeId) : undefined;
      if (!r || !member) {
        if (!r) {
          out.failed += 1;
          failedIds.push(
            typeof raw.employeeId === "string" ? raw.employeeId.slice(0, 64) : "invalid",
          );
        }
        continue;
      }
      await tx
        .insert(hrPayRate)
        .values({
          staffProfileId: member.staffProfileId,
          hourlyPence: r.hourlyPence,
          effectiveFrom: r.effectiveFrom,
          lastSeenAt: now,
          createdBy: null,
          updatedBy: null,
        })
        .onConflictDoUpdate({
          target: [hrPayRate.tenantId, hrPayRate.staffProfileId, hrPayRate.effectiveFrom],
          targetWhere: sql`deleted_at IS NULL`,
          set: { hourlyPence: r.hourlyPence, lastSeenAt: now, updatedBy: null },
        });
      out.rates += 1;
    }
  }
  if (out.failed > 0) {
    const [connection] = await tx
      .select({ id: integrationConnection.id })
      .from(integrationConnection)
      .where(eq(integrationConnection.port, HR_LINK_PORT));
    if (connection) {
      await raiseHrAlert(
        tx,
        "pay_record_failed",
        "integration_connection",
        connection.id,
        now,
        failedIds,
      );
    }
    await recordSync(tx, "rates", now, "record_failed");
    return { ...out, error: "record_failed" };
  }
  await audit(
    tx,
    tenantId,
    "integrations.hr_link.pay_read",
    "integration_connection",
    HR_LINK_PORT,
    {
      periods: out.periods,
      rates: out.rates,
    },
  );
  await recordSync(tx, "rates", now, null);
  return { ...out, error: null };
}

/**
 * Units for a pay run about to be locked whose period goes to Thapsus-HR (rule 11): checked
 * before the lock, so nothing is locked that cannot reach payroll whole. Returns the problem, or
 * what to keep once locked.
 */
export async function planLockUnits(
  tx: Transaction,
  link: HrConnection,
  run: { readonly frequency: string; readonly periodStart: string; readonly periodEnd: string },
  units: ReadonlyMap<string, readonly PayUnitTotal[]>,
): Promise<
  | { readonly problem: "no_hr_pay_period" }
  | { readonly problem: "member_not_linked"; readonly count: number }
  | { readonly problem: "pay_codes_unmapped"; readonly kinds: readonly string[] }
  | { readonly problem: null; readonly periodRowId: string }
> {
  const period = await hrPayPeriodOf(tx, run);
  if (!period) return { problem: "no_hr_pay_period" };
  const { linked } = await members(tx);
  const employeeOf = new Map([...linked.entries()].map(([hrId, m]) => [m.memberId, hrId]));
  const withUnits = [...units.entries()].filter(([, u]) => u.length > 0);
  const unlinked = withUnits.filter(([member]) => !employeeOf.has(member)).length;
  if (unlinked > 0) return { problem: "member_not_linked", count: unlinked };
  const plan = hrPayUnits(
    period.hrId,
    withUnits.map(([member, u]) => ({ employeeId: employeeOf.get(member) as string, units: u })),
    link.settings.pay.codes,
  );
  if (plan.unmapped.length > 0) return { problem: "pay_codes_unmapped", kinds: plan.unmapped };
  return { problem: null, periodRowId: period.rowId };
}

/** Keeps a locked run's units (the system writes them; the database checks the run is locked). */
export async function keepLockUnits(
  tx: Transaction,
  runId: string,
  periodRowId: string,
  units: ReadonlyMap<string, readonly PayUnitTotal[]>,
): Promise<number> {
  let n = 0;
  for (const [memberId, list] of units) {
    for (const u of list) {
      await tx.insert(hrPayUnit).values({
        runId,
        hrPayPeriodId: periodRowId,
        memberId,
        unitKind: u.kind,
        quantity: u.quantity.toFixed(2),
        createdBy: null,
      });
      n += 1;
    }
  }
  return n;
}

export interface PayDeliveryOutcome {
  readonly sent: number;
  readonly refused: number;
  readonly failed: number;
  readonly error: string | null;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Units out (rule 11; K4): for each Thapsus-HR pay period with kept units, those of its latest
 * locked run (a correction carries the whole period), by pay code, replacing the period's items.
 * Sent again only when they change; a refusal goes to pay approvers; a pay code removed since the
 * lock stops the period and is raised. Nothing while Thapsus-HR's pay items are planned.
 */
export async function deliverPayUnits(
  tx: Transaction,
  tenantId: string,
  port: ThapsusHrPort,
  settings: HrLinkSettings,
  now: Date,
): Promise<PayDeliveryOutcome | null> {
  if (port.capabilities().partner_pay_items !== "available") return null;
  const out = { sent: 0, refused: 0, failed: 0 };
  const latest = await tx
    .selectDistinctOn([hrPayUnit.hrPayPeriodId], {
      periodRowId: hrPayUnit.hrPayPeriodId,
      runId: hrPayUnit.runId,
    })
    .from(hrPayUnit)
    .innerJoin(payRun, and(eq(payRun.tenantId, hrPayUnit.tenantId), eq(payRun.id, hrPayUnit.runId)))
    .orderBy(hrPayUnit.hrPayPeriodId, desc(payRun.lockedAt));
  if (latest.length === 0) return { ...out, error: null };
  const periods = new Map(
    (
      await tx
        .select({ id: hrPayPeriod.id, hrId: hrPayPeriod.hrId })
        .from(hrPayPeriod)
        .where(
          inArray(
            hrPayPeriod.id,
            latest.map((l) => l.periodRowId),
          ),
        )
    ).map((p) => [p.id, p.hrId]),
  );
  const { linked } = await members(tx);
  const employeeOf = new Map([...linked.entries()].map(([hrId, m]) => [m.memberId, hrId]));
  for (const l of latest) {
    const hrId = periods.get(l.periodRowId);
    if (!hrId) continue;
    const rows = await tx
      .select({
        memberId: hrPayUnit.memberId,
        kind: hrPayUnit.unitKind,
        quantity: hrPayUnit.quantity,
      })
      .from(hrPayUnit)
      .where(and(eq(hrPayUnit.runId, l.runId), eq(hrPayUnit.hrPayPeriodId, l.periodRowId)));
    const byMember = new Map<string, { kind: string; quantity: number }[]>();
    let unlinked = false;
    for (const r of rows) {
      if (!employeeOf.has(r.memberId)) unlinked = true;
      const list = byMember.get(r.memberId) ?? [];
      list.push({ kind: r.kind, quantity: Number(r.quantity) });
      byMember.set(r.memberId, list);
    }
    const plan = hrPayUnits(
      hrId,
      [...byMember.entries()]
        .filter(([m]) => employeeOf.has(m))
        .map(([m, units]): MemberUnits => ({ employeeId: employeeOf.get(m) as string, units })),
      settings.pay.codes,
    );
    if (unlinked || plan.unmapped.length > 0) {
      await raiseHrAlert(
        tx,
        "pay_codes_unmapped",
        "hr_pay_period",
        l.periodRowId,
        now,
        plan.unmapped,
      );
      out.failed += 1;
      continue;
    }
    const digest = sha256(JSON.stringify(plan.units));
    let r: Awaited<ReturnType<typeof deliver>>;
    try {
      r = await tx.transaction((sp) =>
        deliver(
          sp,
          tenantId,
          "pay_units",
          l.periodRowId,
          digest,
          now,
          async (key) => {
            const put = await port.putPayUnits(hrId, plan.units, key);
            return put.ok ? { ok: true, value: { id: hrId } } : put;
          },
          "pay_units_refused",
        ),
      );
    } catch {
      r = "failed";
    }
    if (r === "sent") out.sent += 1;
    else if (r === "refused") out.refused += 1;
    else if (r === "failed") out.failed += 1;
    else if (r === "rate_limited") return { ...out, error: "rate_limited" };
  }
  return { ...out, error: null };
}
