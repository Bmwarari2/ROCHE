import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  auditEvent,
  featureFlag,
  HR_LINK_PORT,
  hrDelivery,
  hrPersonLink,
  hrSyncState,
  integrationConnection,
  leaverRecord,
  staffProfile,
  type Transaction,
  tenantUser,
} from "@harbour/db";
import {
  connectionRefusal,
  DEFAULT_HR_OWNERS,
  type DriftField,
  effectiveLeavingDate,
  employeeDrift,
  evaluateFlag,
  HR_STALENESS_DEFAULT_MINUTES,
  HR_WEBHOOK_EVENTS,
  type HrDataKind,
  type HrEmployee,
  type HrOwners,
  type HrStarter,
  hrStaleness,
  matchEmployee,
  ownersProblems,
  realDay,
  type StaffCandidate,
  stalenessLimitProblem,
  type ThapsusHrPort,
  ukIsoDate,
  webhookTimestampProblem,
} from "@harbour/domain";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { MemoryThrottle } from "../http/throttle";
import { publish } from "../outbox";
import { retainUntil } from "../routes/induction";
import { endLeaversAccess } from "../services/leavers";
import { MockThapsusHr } from "./thapsus-hr";

/**
 * The Thapsus-HR link's sync (integrations.md section 11; INTG-014; slice 87). Runs in the
 * organisation's own system context (no member), so every write it makes is audited with the actor
 * `integration:thapsus_hr` and opaque identifiers only. Nothing here stores a Thapsus-HR name,
 * email or date of birth: they are read to match and dropped (section 11.8).
 */

export const HR_ACTOR = "integration:thapsus_hr";

/** The link's non-secret settings on its `integration_connection` row. */
export interface HrLinkSettings {
  readonly workspaceSlug: string;
  readonly homeRegion: string;
  /** Where the adapter sends: `https://api.uk.<Thapsus's domain>`; rule 1 checks this. */
  readonly apiBaseUrl: string;
  /** Thapsus's own domain, from this environment's configuration, never from a tenant. */
  readonly thapsusDomain: string;
  readonly owners: HrOwners;
  readonly stalenessMinutes: number;
}

const HR_DATA_KIND_KEYS = Object.keys(DEFAULT_HR_OWNERS) as HrDataKind[];

export const HrOwnersSchema = z
  .object(
    Object.fromEntries(
      HR_DATA_KIND_KEYS.map((k) => [k, z.enum(["harbour", "thapsus_hr"])]),
    ) as Record<HrDataKind, z.ZodEnum<{ harbour: "harbour"; thapsus_hr: "thapsus_hr" }>>,
  )
  .strict();

/** The settings as stored, or null when the row is not a usable link (fail closed). */
export function parseHrSettings(raw: unknown): HrLinkSettings | null {
  const parsed = z
    .object({
      workspaceSlug: z.string().regex(/^[a-z0-9-]{1,63}$/),
      homeRegion: z.string(),
      apiBaseUrl: z.string(),
      thapsusDomain: z.string(),
      owners: HrOwnersSchema,
      stalenessMinutes: z.number(),
    })
    .safeParse(raw);
  if (!parsed.success) return null;
  const s = parsed.data;
  const minutes =
    stalenessLimitProblem(s.stalenessMinutes) === null
      ? s.stalenessMinutes
      : HR_STALENESS_DEFAULT_MINUTES;
  return { ...s, owners: s.owners as HrOwners, stalenessMinutes: minutes };
}

/** Owners the tenant chose, refused where a fixed owner would change (rule 2). */
export function ownersOrProblem(owners: HrOwners): string | null {
  const problems = ownersProblems(owners);
  return problems.length === 0 ? null : problems.map((p) => p.kind).join(", ");
}

export interface HrLinkServices {
  /** Thapsus's domain in this environment (`THAPSUS_HR_DOMAIN`), or null when there is none. */
  readonly domain: string | null;
  /**
   * The adapter for an organisation's link, or null when there is none: no configured domain, a
   * link stored for another domain, or production until Thapsus-HR's partner features ship
   * (H-1343). Development and tests use the pinned mock.
   */
  port(tenantId: string, settings: HrLinkSettings): ThapsusHrPort | null;
  /** The webhook signing secret the connection's Secret Manager reference names, or null. */
  webhookSecret(secretRef: string): Promise<string | null>;
  /** The public webhook's limits, per client address and per organisation, before any query. */
  readonly webhookThrottles: { readonly address: MemoryThrottle; readonly tenant: MemoryThrottle };
  /** Development and tests only: each organisation's mock, and secrets by reference. */
  readonly mocks: Map<string, MockThapsusHr>;
  readonly secrets: Map<string, string>;
}

export function createHrLinkServices(options: {
  production: boolean;
  domain: string | null;
}): HrLinkServices {
  const mocks = new Map<string, MockThapsusHr>();
  const secrets = new Map<string, string>();
  return {
    domain: options.domain,
    mocks,
    secrets,
    webhookThrottles: {
      address: new MemoryThrottle(120, 60_000),
      tenant: new MemoryThrottle(600, 60_000),
    },
    port(tenantId, settings) {
      if (options.production || !options.domain) return null;
      if (
        settings.thapsusDomain !== options.domain ||
        settings.apiBaseUrl !== `https://api.uk.${options.domain}`
      ) {
        return null;
      }
      let mock = mocks.get(tenantId);
      if (!mock || mock.apiBaseUrl !== settings.apiBaseUrl) {
        mock = new MockThapsusHr(
          {
            slug: settings.workspaceSlug,
            homeRegion: settings.homeRegion,
            apiBaseUrl: settings.apiBaseUrl,
          },
          settings.apiBaseUrl,
        );
        mocks.set(tenantId, mock);
      }
      return mock;
    },
    async webhookSecret(secretRef) {
      return options.production ? null : (secrets.get(secretRef) ?? null);
    },
  };
}

export interface HrConnection {
  readonly id: string;
  readonly status: string;
  readonly version: number;
  readonly secretRef: string | null;
  readonly settings: HrLinkSettings;
}

/** The organisation's link, or null when it has none or its settings are not usable. */
export async function hrConnection(tx: Transaction): Promise<HrConnection | null> {
  const [row] = await tx
    .select({
      id: integrationConnection.id,
      status: integrationConnection.status,
      version: integrationConnection.version,
      secretRef: integrationConnection.secretRef,
      settings: integrationConnection.settings,
    })
    .from(integrationConnection)
    .where(
      and(eq(integrationConnection.port, HR_LINK_PORT), isNull(integrationConnection.deletedAt)),
    );
  if (!row) return null;
  const settings = parseHrSettings(row.settings);
  return settings ? { ...row, settings } : null;
}

/** The flag, from the organisation's own rows (it is never set remotely). */
export async function hrLinkEnabled(tx: Transaction): Promise<boolean> {
  const rows = await tx
    .select({
      flagKey: featureFlag.flagKey,
      locationId: featureFlag.locationId,
      enabled: featureFlag.enabled,
    })
    .from(featureFlag)
    .where(isNull(featureFlag.deletedAt));
  return evaluateFlag("integrations.thapsus_hr", rows, null);
}

/** Rule 1, against what the adapter really sends to and what the workspace reports now. */
export async function ukRefusal(
  port: ThapsusHrPort,
  settings: HrLinkSettings,
): Promise<string | null> {
  const workspace = await port.workspace();
  if (!workspace.ok) return workspace.error;
  return connectionRefusal({
    homeRegion: workspace.value.homeRegion,
    apiBaseUrl: port.apiBaseUrl,
    thapsusDomain: settings.thapsusDomain,
  });
}

async function audit(
  tx: Transaction,
  tenantId: string,
  action: string,
  resourceType: string,
  resourceId: string,
  scope: Record<string, unknown> = {},
  outcome: "success" | "denied" | "error" = "success",
) {
  await tx.insert(auditEvent).values({
    tenantId,
    actorAuthUserId: HR_ACTOR,
    actorRoleKeys: ["integration"],
    action,
    outcome,
    resourceType,
    resourceId,
    scope,
  });
}

async function event(
  tx: Transaction,
  type: string,
  aggregateType: string,
  aggregateId: string,
  payload: Record<string, string | number | boolean | null> = {},
) {
  await publish(tx, {
    context: "integrations",
    aggregateType,
    aggregateId,
    type: `integrations.${type}`,
    payload,
  });
}

/** Records a sync's outcome for its kind (rule 9 reads the last good sync from here). */
export async function recordSync(
  tx: Transaction,
  kind: "employees" | "locations",
  now: Date,
  errorCode: string | null,
): Promise<void> {
  await tx
    .insert(hrSyncState)
    .values({
      kind,
      lastAttemptAt: now,
      lastGoodSyncAt: errorCode ? null : now,
      lastErrorCode: errorCode,
      failures: errorCode ? 1 : 0,
      createdBy: null,
      updatedBy: null,
    })
    .onConflictDoUpdate({
      target: [hrSyncState.tenantId, hrSyncState.kind],
      set: errorCode
        ? {
            lastAttemptAt: now,
            lastErrorCode: errorCode,
            failures: sql`${hrSyncState.failures} + 1`,
          }
        : { lastAttemptAt: now, lastGoodSyncAt: now, lastErrorCode: null, failures: 0 },
    });
}

/**
 * Staff files not yet linked, with what matching may use (never a name; rule 3). Members who have
 * left are not candidates, so a returning employee is never joined to an old file without a
 * person deciding.
 */
async function candidates(tx: Transaction, today: string): Promise<StaffCandidate[]> {
  const rows = await tx
    .select({
      memberId: staffProfile.id,
      workEmail: tenantUser.email,
      dateOfBirth: staffProfile.dateOfBirth,
      linkedId: hrPersonLink.id,
      employeeNumber: hrPersonLink.employeeNumber,
    })
    .from(staffProfile)
    .innerJoin(
      tenantUser,
      and(
        eq(tenantUser.tenantId, staffProfile.tenantId),
        eq(tenantUser.id, staffProfile.tenantUserId),
      ),
    )
    .leftJoin(
      hrPersonLink,
      and(
        eq(hrPersonLink.tenantId, staffProfile.tenantId),
        eq(hrPersonLink.staffProfileId, staffProfile.id),
        eq(hrPersonLink.state, "linked"),
        isNull(hrPersonLink.deletedAt),
      ),
    )
    .where(
      and(
        isNull(staffProfile.deletedAt),
        sql`${tenantUser.status} <> 'left'`,
        or(isNull(staffProfile.leftOn), sql`${staffProfile.leftOn} >= ${today}::date`),
      ),
    );
  return rows.map((r) => ({
    memberId: r.memberId,
    employeeNumber: r.employeeNumber,
    workEmail: r.workEmail,
    dateOfBirth: r.dateOfBirth,
    linked: r.linkedId !== null,
  }));
}

export interface ApplyOutcome {
  readonly linked: number;
  readonly review: number;
  readonly leavers: number;
  readonly drift: number;
}

/**
 * The leaving date an employee carries: a real day, or null for none. One that is there but is
 * not a real day fails safe (rule 8): it counts as today, so sign-in ends tonight, and a person is
 * told (`invalid`).
 */
export function leavingOf(
  employee: HrEmployee,
  today: string,
): { readonly date: string | null; readonly invalid: boolean } {
  const raw = employee.leavingDate;
  if (raw === undefined || raw === null) return { date: null, invalid: false };
  if (typeof raw === "string" && realDay(raw)) return { date: raw, invalid: false };
  return { date: today, invalid: true };
}

/**
 * Rule 8: a leaving date Thapsus-HR gives is recorded as the staff file's leaving (with how long
 * the file is kept) and as its left-on date, so the rota stops offering the member after it and
 * the leaver sweep ends sign-in at the end of that day even if every later sync fails. Only ever
 * moved earlier, never later or away (`effectiveLeavingDate`); a withdrawn leaving is put back.
 * Returns whether anything changed.
 */
async function applyLeaving(
  tx: Transaction,
  tenantId: string,
  staffProfileId: string,
  leavingOn: string,
): Promise<boolean> {
  const [profile] = await tx.select().from(staffProfile).where(eq(staffProfile.id, staffProfileId));
  if (!profile) return false;
  const [known] = await tx
    .select({
      id: leaverRecord.id,
      leavingOn: leaverRecord.leavingOn,
      deletedAt: leaverRecord.deletedAt,
      accessRemovedAt: leaverRecord.accessRemovedAt,
    })
    .from(leaverRecord)
    .where(eq(leaverRecord.staffProfileId, staffProfileId));
  let keep: string | null = null;
  try {
    keep = await tx.transaction((sp) => retainUntil(sp, tenantId, profile, leavingOn));
  } catch {
    keep = null;
  }
  let changed = false;
  if (!known) {
    await tx.insert(leaverRecord).values({
      staffProfileId,
      leavingOn,
      reason: "other",
      staffFileRetainUntil: keep,
      createdBy: null,
      updatedBy: null,
    });
    changed = true;
  } else if (known.accessRemovedAt === null) {
    const earlier = effectiveLeavingDate(known.leavingOn, leavingOn) !== known.leavingOn;
    if (known.deletedAt !== null || earlier) {
      await tx
        .update(leaverRecord)
        .set({
          leavingOn: known.deletedAt !== null && !earlier ? known.leavingOn : leavingOn,
          deletedAt: null,
          staffFileRetainUntil: keep,
          updatedBy: null,
        })
        .where(eq(leaverRecord.id, known.id));
      changed = true;
    }
  }
  if (profile.leftOn === null || profile.leftOn > leavingOn) {
    try {
      await tx.transaction((sp) =>
        sp
          .update(staffProfile)
          .set({ leftOn: leavingOn, updatedBy: null })
          .where(eq(staffProfile.id, staffProfileId)),
      );
      changed = true;
    } catch {
      // A leaving before the start date the file holds: the leaving record still ends access.
      await audit(
        tx,
        tenantId,
        "integrations.hr_link.left_on_refused",
        "staff_profile",
        staffProfileId,
        {},
        "error",
      );
    }
  }
  if (changed) {
    await audit(
      tx,
      tenantId,
      "integrations.hr_link.leaving_recorded",
      "staff_profile",
      staffProfileId,
    );
  }
  return changed;
}

/**
 * Rule 2: puts back Thapsus-HR's version of the fields it owns, and records the drift. A start
 * date is put back only when it stays on the same side of today, so nobody drops off or onto the
 * rota or out of induction without a person seeing it; otherwise the drift is recorded for review.
 */
async function reconcile(
  tx: Transaction,
  tenantId: string,
  owners: HrOwners,
  staffProfileId: string,
  employee: HrEmployee,
  today: string,
): Promise<boolean> {
  if (owners.employee_record !== "thapsus_hr") return false;
  const [copy] = await tx
    .select({ jobTitle: staffProfile.jobTitle, startsOn: staffProfile.startsOn })
    .from(staffProfile)
    .where(eq(staffProfile.id, staffProfileId));
  if (!copy) return false;
  const drift = employeeDrift(copy, employee);
  if (drift.length === 0) return false;
  const newStart = employee.startDate as string;
  const startSafe =
    !drift.includes("start_date") ||
    (copy.startsOn !== null && copy.startsOn <= today === newStart <= today);
  const putBack: DriftField[] = drift.filter((f) => f === "job_title" || startSafe);
  let applied = putBack.length > 0;
  if (applied) {
    try {
      await tx.transaction(async (sp) => {
        await sp
          .update(staffProfile)
          .set({
            ...(putBack.includes("job_title")
              ? { jobTitle: String(employee.jobTitle).trim() }
              : {}),
            ...(putBack.includes("start_date") ? { startsOn: newStart } : {}),
            updatedBy: null,
          })
          .where(eq(staffProfile.id, staffProfileId));
      });
    } catch {
      applied = false;
    }
  }
  const held = drift.filter((f) => !applied || !putBack.includes(f));
  await audit(
    tx,
    tenantId,
    "integrations.hr_link.drift_detected",
    "staff_profile",
    staffProfileId,
    {
      fields: drift,
      putBack: applied ? putBack : [],
      forReview: held,
    },
  );
  await event(tx, "hr_link.drift_detected", "staff_profile", staffProfileId, {
    fields: drift.join(","),
    forReview: held.join(","),
  });
  return true;
}

/**
 * One Thapsus-HR employee, from a webhook or a pull: links it (rule 3), records its leaving date
 * (rule 8) and reconciles the fields Thapsus-HR owns (rule 2). An unconfirmed match changes
 * nothing in the staff file; a leaving date on one is kept and shown to the reviewer.
 */
export async function applyEmployee(
  tx: Transaction,
  tenantId: string,
  owners: HrOwners,
  employee: HrEmployee,
  now: Date,
  pool?: StaffCandidate[],
): Promise<ApplyOutcome> {
  const out = { linked: 0, review: 0, leavers: 0, drift: 0 };
  const today = ukIsoDate(now);
  const leaving = leavingOf(employee, today);
  const number =
    typeof employee.employeeNumber === "string" &&
    /^[A-Za-z0-9_/-]{1,40}$/.test(employee.employeeNumber)
      ? employee.employeeNumber
      : null;
  const [link] = await tx
    .select()
    .from(hrPersonLink)
    .where(and(eq(hrPersonLink.hrEmployeeId, employee.id), isNull(hrPersonLink.deletedAt)));
  let linkedTo: string | null = null;
  let id = link?.id ?? "";
  if (link) {
    await tx
      .update(hrPersonLink)
      .set({
        lastSeenAt: now,
        employeeNumber: number ?? link.employeeNumber,
        leavingOn: effectiveLeavingDate(link.leavingOn, leaving.date),
        updatedBy: null,
      })
      .where(eq(hrPersonLink.id, link.id));
    if (link.state === "linked") linkedTo = link.staffProfileId;
    if (link.state === "review") out.review += 1;
  } else {
    const result = matchEmployee(employee, pool ?? (await candidates(tx, today)));
    const matched = result.kind === "matched";
    const [row] = await tx
      .insert(hrPersonLink)
      .values({
        hrEmployeeId: employee.id,
        employeeNumber: number,
        staffProfileId: matched ? result.memberId : null,
        state: matched ? "linked" : "review",
        matchMethod: matched ? result.how : null,
        reviewReason: matched ? null : result.reason,
        leavingOn: leaving.date,
        lastSeenAt: now,
        createdBy: null,
        updatedBy: null,
      })
      .returning({ id: hrPersonLink.id });
    id = row?.id ?? "";
    if (matched) {
      linkedTo = result.memberId;
      out.linked += 1;
      const hit = pool?.find((c) => c.memberId === result.memberId);
      if (hit) (hit as { linked: boolean }).linked = true;
      await audit(tx, tenantId, "integrations.hr_link.person_linked", "hr_person_link", id, {
        how: result.how,
      });
      await event(tx, "hr_link.person_linked", "hr_person_link", id, { how: result.how });
    } else {
      out.review += 1;
      await audit(tx, tenantId, "integrations.hr_link.match_review", "hr_person_link", id, {
        reason: result.reason,
      });
    }
  }
  if (leaving.invalid) {
    await audit(tx, tenantId, "integrations.hr_link.leaving_date_invalid", "hr_person_link", id);
    await event(tx, "hr_link.leaving_date_invalid", "hr_person_link", id);
  }
  if (linkedTo) {
    const keptLeaving = effectiveLeavingDate(link?.leavingOn ?? null, leaving.date);
    if (keptLeaving && owners.leavers === "thapsus_hr") {
      if (await applyLeaving(tx, tenantId, linkedTo, keptLeaving)) out.leavers += 1;
    }
    if (await reconcile(tx, tenantId, owners, linkedTo, employee, today)) out.drift += 1;
  }
  return out;
}

const MAX_PAGES = 1_000;

export type PullOutcome = ApplyOutcome & {
  readonly failed: number;
  readonly error: string | null;
};

/**
 * The employee pull, on connecting and every 10 minutes (rule 3 for matching, rule 8 for leavers,
 * rule 2 for drift): checks rule 1 first and sends nothing if it fails; reads every page, stopping
 * on a rate limit (rule 6) to try again on the next run, and counting a page cap or a repeated
 * cursor as incomplete; applies each employee in its own savepoint, so one bad record never holds
 * back the rest; flags linked employees Thapsus-HR no longer lists; records the outcome; then ends
 * any leaver whose day is over at once rather than waiting for the hourly sweep.
 */
export async function pullEmployees(
  tx: Transaction,
  tenantId: string,
  port: ThapsusHrPort,
  settings: HrLinkSettings,
  now: Date,
): Promise<PullOutcome> {
  const total = { linked: 0, review: 0, leavers: 0, drift: 0, failed: 0 };
  const fail = async (code: string, outcome: "denied" | "error") => {
    await recordSync(tx, "employees", now, code);
    await audit(
      tx,
      tenantId,
      "integrations.hr_link.sync_failed",
      "integration_connection",
      HR_LINK_PORT,
      { code },
      outcome,
    );
    await event(tx, "hr_link.sync_failed", "integration_connection", HR_LINK_PORT, { code });
    await endLeaversAccess(tx, tenantId, now);
    return { ...total, error: code };
  };
  const refusal = await ukRefusal(port, settings);
  if (refusal) return fail(refusal, "denied");
  const pool = await candidates(tx, ukIsoDate(now));
  let cursor: string | null = null;
  const seen = new Set<string>();
  let complete = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await port.employees(cursor);
    if (!result.ok) return fail(result.error, "error");
    for (const employee of result.value.items) {
      try {
        const out = await tx.transaction((sp) =>
          applyEmployee(sp, tenantId, settings.owners, employee, now, pool),
        );
        total.linked += out.linked;
        total.review += out.review;
        total.leavers += out.leavers;
        total.drift += out.drift;
      } catch {
        total.failed += 1;
        await audit(
          tx,
          tenantId,
          "integrations.hr_link.record_failed",
          "hr_person_link",
          /^[A-Za-z0-9_-]{1,64}$/.test(employee.id) ? employee.id : "invalid",
          {},
          "error",
        );
      }
    }
    cursor = result.value.nextCursor;
    if (cursor === null) {
      complete = true;
      break;
    }
    if (seen.has(cursor)) break;
    seen.add(cursor);
  }
  if (!complete) return fail("incomplete", "error");
  // Linked employees Thapsus-HR no longer lists: told, never acted on without a person.
  const missing = await tx
    .select({ id: hrPersonLink.id })
    .from(hrPersonLink)
    .where(
      and(
        eq(hrPersonLink.state, "linked"),
        isNull(hrPersonLink.deletedAt),
        or(isNull(hrPersonLink.lastSeenAt), lt(hrPersonLink.lastSeenAt, now)),
      ),
    );
  for (const m of missing) {
    await audit(tx, tenantId, "integrations.hr_link.employee_missing", "hr_person_link", m.id);
    await event(tx, "hr_link.employee_missing", "hr_person_link", m.id);
  }
  if (total.failed > 0) {
    await event(tx, "hr_link.sync_failed", "integration_connection", HR_LINK_PORT, {
      code: "record_failed",
      count: total.failed,
    });
  }
  await recordSync(tx, "employees", now, null);
  if (total.failed > 0) {
    // The data is current, but some employees were not applied: the status says so (rule 9).
    await tx
      .update(hrSyncState)
      .set({ lastErrorCode: "record_failed" })
      .where(eq(hrSyncState.kind, "employees"));
  }
  await endLeaversAccess(tx, tenantId, now);
  return { ...total, error: null };
}

/**
 * The pull in a savepoint: anything unexpected is recorded as a failed sync (so the status and
 * the rota say why the data is old; rule 9) instead of rolling the record back with it.
 */
export async function pullSafely(
  tx: Transaction,
  tenantId: string,
  port: ThapsusHrPort,
  settings: HrLinkSettings,
  now: Date,
): Promise<PullOutcome> {
  try {
    return await tx.transaction((sp) => pullEmployees(sp, tenantId, port, settings, now));
  } catch {
    await recordSync(tx, "employees", now, "internal");
    await audit(
      tx,
      tenantId,
      "integrations.hr_link.sync_failed",
      "integration_connection",
      HR_LINK_PORT,
      { code: "internal" },
      "error",
    );
    await event(tx, "hr_link.sync_failed", "integration_connection", HR_LINK_PORT, {
      code: "internal",
    });
    return { linked: 0, review: 0, leavers: 0, drift: 0, failed: 0, error: "internal" };
  }
}

/** Rule 9: whether the link's data is out of date, for the status route and the rota. */
export async function hrLinkStaleness(tx: Transaction, settings: HrLinkSettings, now: Date) {
  const [state] = await tx
    .select({
      lastGoodSyncAt: hrSyncState.lastGoodSyncAt,
      lastErrorCode: hrSyncState.lastErrorCode,
      failures: hrSyncState.failures,
    })
    .from(hrSyncState)
    .where(eq(hrSyncState.kind, "employees"));
  return {
    ...hrStaleness(state?.lastGoodSyncAt ?? null, now, settings.stalenessMinutes),
    lastGoodSyncAt: state?.lastGoodSyncAt?.toISOString() ?? null,
    lastErrorCode: state?.lastErrorCode ?? null,
    failures: state?.failures ?? 0,
  };
}

/** Leavers whose day is over but whose access could not be ended automatically (told on status). */
export async function leaversNotEnded(tx: Transaction, now: Date): Promise<number> {
  const rows = await tx
    .select({ id: leaverRecord.id })
    .from(leaverRecord)
    .where(
      and(
        isNull(leaverRecord.accessRemovedAt),
        isNull(leaverRecord.deletedAt),
        lt(leaverRecord.leavingOn, ukIsoDate(now)),
      ),
    );
  return rows.length;
}

export type HrManagedField = "job_title" | "start_date" | "leaving_date";

/**
 * Rule 2 at the staff file: the fields Thapsus-HR owns for this file while the link is connected,
 * which a person here may not change ("Managed in Thapsus-HR").
 */
export async function hrManagedFields(
  tx: Transaction,
  staffProfileId: string,
): Promise<ReadonlySet<HrManagedField>> {
  const fields = new Set<HrManagedField>();
  if (!(await hrLinkEnabled(tx))) return fields;
  const link = await hrConnection(tx);
  if (link?.status !== "connected") return fields;
  const [linked] = await tx
    .select({ id: hrPersonLink.id })
    .from(hrPersonLink)
    .where(
      and(
        eq(hrPersonLink.staffProfileId, staffProfileId),
        eq(hrPersonLink.state, "linked"),
        isNull(hrPersonLink.deletedAt),
      ),
    );
  if (!linked) return fields;
  if (link.settings.owners.employee_record === "thapsus_hr") {
    fields.add("job_title");
    fields.add("start_date");
  }
  if (link.settings.owners.leavers === "thapsus_hr") fields.add("leaving_date");
  return fields;
}

/**
 * A starter hired here (an offer accepted with a start date; WORK-001) created in Thapsus-HR, once:
 * the delivery row's key is the idempotency key, so a retry within 24 hours returns the same
 * employee, and a delivery already sent is never sent again (rule 5). Only the starter's listed
 * fields cross (rule 4). Links the staff file to the employee Thapsus-HR returns.
 */
export async function deliverStarter(
  tx: Transaction,
  tenantId: string,
  port: ThapsusHrPort,
  settings: HrLinkSettings,
  staffProfileId: string,
  starter: HrStarter,
  idempotencyKey: string,
  now: Date,
): Promise<{
  readonly state: string;
  readonly hrId: string | null;
  readonly error: string | null;
}> {
  await tx
    .insert(hrDelivery)
    .values({
      kind: "starter",
      harbourRef: staffProfileId,
      idempotencyKey,
      createdBy: null,
      updatedBy: null,
    })
    .onConflictDoNothing({ target: [hrDelivery.tenantId, hrDelivery.kind, hrDelivery.harbourRef] });
  const [delivery] = await tx
    .select()
    .from(hrDelivery)
    .where(and(eq(hrDelivery.kind, "starter"), eq(hrDelivery.harbourRef, staffProfileId)));
  if (!delivery) return { state: "failed", hrId: null, error: "unavailable" };
  if (delivery.state === "sent" || delivery.state === "refused") {
    return { state: delivery.state, hrId: delivery.hrId, error: delivery.lastErrorCode };
  }
  const refusal = await ukRefusal(port, settings);
  const result = refusal
    ? ({ ok: false, error: refusal } as const)
    : await port.createEmployee(starter, delivery.idempotencyKey);
  if (!result.ok) {
    const final = result.error === "refused" || refusal !== null;
    await tx
      .update(hrDelivery)
      .set({
        state: final ? "refused" : "failed",
        attempts: delivery.attempts + 1,
        lastErrorCode: result.error,
        nextAttemptAt: final
          ? null
          : new Date(
              now.getTime() +
                ("retryAfterSeconds" in result && result.retryAfterSeconds
                  ? result.retryAfterSeconds * 1000
                  : 5 * 60_000),
            ),
        updatedBy: null,
      })
      .where(eq(hrDelivery.id, delivery.id));
    await audit(
      tx,
      tenantId,
      "integrations.hr_link.delivery",
      "hr_delivery",
      delivery.id,
      { kind: "starter", code: result.error },
      "error",
    );
    return { state: final ? "refused" : "failed", hrId: null, error: result.error };
  }
  const hrId = result.value.id;
  await tx
    .update(hrDelivery)
    .set({
      state: "sent",
      hrId,
      sentAt: now,
      attempts: delivery.attempts + 1,
      lastErrorCode: null,
      nextAttemptAt: null,
      updatedBy: null,
    })
    .where(eq(hrDelivery.id, delivery.id));
  const linkedRows = await tx
    .insert(hrPersonLink)
    .values({
      hrEmployeeId: hrId,
      staffProfileId,
      state: "linked",
      matchMethod: "starter",
      lastSeenAt: now,
      createdBy: null,
      updatedBy: null,
    })
    .onConflictDoNothing()
    .returning({ id: hrPersonLink.id });
  if (linkedRows.length === 0) {
    // Thapsus-HR's employee is already known here (a pull got there first): a person decides.
    await audit(
      tx,
      tenantId,
      "integrations.hr_link.starter_unlinked",
      "hr_delivery",
      delivery.id,
      {},
      "error",
    );
  }
  await audit(tx, tenantId, "integrations.hr_link.delivery", "hr_delivery", delivery.id, {
    kind: "starter",
  });
  return { state: "sent", hrId, error: null };
}

/** The starter's fields, from the staff file and the member (rule 4: nothing else). */
export async function starterFor(
  tx: Transaction,
  staffProfileId: string,
  names: { readonly givenName: string; readonly familyName: string },
  hrLocationId: string | null,
): Promise<HrStarter | null> {
  const [row] = await tx
    .select({
      email: tenantUser.email,
      dateOfBirth: staffProfile.dateOfBirth,
      jobTitle: staffProfile.jobTitle,
      startsOn: staffProfile.startsOn,
    })
    .from(staffProfile)
    .innerJoin(
      tenantUser,
      and(
        eq(tenantUser.tenantId, staffProfile.tenantId),
        eq(tenantUser.id, staffProfile.tenantUserId),
      ),
    )
    .where(eq(staffProfile.id, staffProfileId));
  if (!row?.startsOn) return null;
  return {
    givenName: names.givenName,
    familyName: names.familyName,
    workEmail: row.email,
    dateOfBirth: row.dateOfBirth,
    jobTitle: row.jobTitle,
    locationId: hrLocationId,
    contractedHours: null,
    startDate: row.startsOn,
  } satisfies HrStarter;
}

/** The webhook body: identifiers only (section 11.6). */
export const HrWebhookSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    type: z.enum(HR_WEBHOOK_EVENTS),
    employeeId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

/** A secret no one holds, so a refusal costs the same HMAC as an acceptance (no timing hint). */
export const DECOY_SECRET = randomBytes(32).toString("hex");

/**
 * The `Thapsus-Signature` header (`t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">`), checked
 * in constant time and within the replay window. Returns the refusal, or null when it is good.
 */
export function signatureRefusal(
  header: string | undefined,
  body: string,
  secret: string,
  now: Date,
): "missing" | "invalid" | "too_old" | "in_future" | "mismatch" | null {
  if (!header) return "missing";
  const parts = new Map(
    header.split(",").map((p) => {
      const at = p.indexOf("=");
      return [p.slice(0, at).trim(), p.slice(at + 1).trim()] as const;
    }),
  );
  const t = parts.get("t") ?? "";
  const v1 = parts.get("v1") ?? "";
  if (!/^\d{1,12}$/.test(t) || !/^[0-9a-f]{64}$/.test(v1)) return "invalid";
  const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest();
  const given = Buffer.from(v1, "hex");
  const matches = given.length === expected.length && timingSafeEqual(given, expected);
  const when = webhookTimestampProblem(Number(t), now);
  if (when) return when;
  return matches ? null : "mismatch";
}
