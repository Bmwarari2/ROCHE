import { createHash } from "node:crypto";
import {
  deviceBinding,
  dpia,
  integrationConnection,
  location,
  person,
  retentionClass,
  service,
  type Transaction,
  type tenant,
  tenantUser,
} from "@harbour/db";
import {
  type AiProvider,
  DPIA_MONITORING_FLAGS,
  type DpiaBasis,
  type DpiaConfig,
  type DpiaMonitoringFlag,
  dpiaBasis,
  dpiaState,
  type FlagKey,
  monitoringCovered,
  PLATFORM_RATE_KEYS,
} from "@harbour/domain";
import { and, count, desc, eq, inArray, isNotNull, isNull, max, sql } from "drizzle-orm";
import type { FlagService } from "../flags/provider";
import { OFFLINE_WINDOW_RATE_KEY } from "./handover";
import { rateNumber } from "./rates";
import type { StaffLookup } from "./staff";

/**
 * The DPIA's inputs and outputs (PLAT-023; platform-completions.md rules 17 to 22): the
 * configuration the prefill reads, gathered from the organisation's own records, and the version's
 * SHA-256, which the signature binds to.
 */

type DpiaRow = typeof dpia.$inferSelect;
type TenantRow = typeof tenant.$inferSelect;

/** The organisation's feature flags in force, with its own rows (organisation-wide). */
export async function tenantFlags(
  flags: FlagService,
  tx: Transaction,
  tenantId: string,
): Promise<Record<FlagKey, boolean>> {
  return flags.evaluateAll({ tenantId, locationId: null, overrides: await flagRows(tx) });
}

/** The organisation's feature flag rows, for evaluating a flag at a location. */
async function flagRows(tx: Transaction) {
  const rows = await tx.execute<{
    flag_key: string;
    location_id: string | null;
    enabled: boolean;
  }>(sql`SELECT flag_key, location_id, enabled FROM feature_flag WHERE deleted_at IS NULL`);
  return rows.rows.map((r) => ({
    flagKey: r.flag_key,
    locationId: r.location_id,
    enabled: r.enabled,
  }));
}

/**
 * Whether the organisation's signed DPIA covers an employee-monitoring flag (H-1555), read in the
 * request's transaction. The DPIA's row-level security shows it only to holders of a DPIA
 * permission, and this is asked for whoever clocks in or checks in, so it is answered by
 * `app.signed_dpia_features()` (migration 0153): the signed version's id and the features its
 * basis lists, nothing else. `dpiaId` is the signed version relied on, or null when it does not
 * cover the flag.
 */
export async function signedDpiaCovers(
  tx: Transaction,
  flag: DpiaMonitoringFlag,
): Promise<{ readonly covered: boolean; readonly dpiaId: string | null }> {
  const found = await tx.execute<{ dpia_id: string; features: string[] | null }>(
    sql`SELECT dpia_id, features FROM app.signed_dpia_features()`,
  );
  const row = found.rows[0];
  const covered = row ? monitoringCovered(flag, { features: row.features ?? [] }) : false;
  return { covered, dpiaId: covered && row ? row.dpia_id : null };
}

/**
 * An employee-monitoring flag in use at a location (H-527, H-1033, H-1555): switched on there (its
 * location row, else the organisation's) AND covered by the organisation's signed DPIA. Rows in
 * `feature_flag` are set directly, so this is checked wherever the monitoring is used, not only
 * where it is set. `flagOn` is the flag alone; `dpiaId` the signed version relied on.
 */
export async function monitoringInUse(
  flags: FlagService,
  tx: Transaction,
  tenantId: string,
  locationId: string | null,
  flag: DpiaMonitoringFlag,
): Promise<{ readonly on: boolean; readonly flagOn: boolean; readonly dpiaId: string | null }> {
  const evaluated = await flags.evaluateAll({
    tenantId,
    locationId,
    overrides: await flagRows(tx),
  });
  const flagOn = evaluated[flag] === true;
  if (!flagOn) return { on: false, flagOn, dpiaId: null };
  const { covered, dpiaId } = await signedDpiaCovers(tx, flag);
  return { on: covered, flagOn, dpiaId };
}

/** The DPIA's open and signed versions. */
export async function dpiaVersions(tx: Transaction) {
  const rows = await tx.select().from(dpia).orderBy(desc(dpia.dpiaVersion));
  return {
    open: rows.find((r) => r.status === "draft" || r.status === "prepared") ?? null,
    signed: rows.find((r) => r.status === "signed") ?? null,
  };
}

/** Where the DPIA stands for this configuration now, and the review interval in months. */
export async function dpiaStateFor(
  tx: Transaction,
  tenantId: string,
  config: DpiaConfig,
  now: Date,
) {
  const { open, signed } = await dpiaVersions(tx);
  const months = await rateNumber(tx, tenantId, PLATFORM_RATE_KEYS.dpiaReviewIntervalMonths);
  const view = (r: DpiaRow | null) =>
    r
      ? { status: r.status as "draft", signedAt: r.signedAt, basis: r.basis as DpiaBasis | null }
      : null;
  return {
    open,
    signed,
    months,
    ...dpiaState(view(signed), view(open), dpiaBasis(config), now, {
      dpiaReviewIntervalMonths: months,
    }),
  };
}

/** JSON with its object keys sorted, so the same content always hashes the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** SHA-256 of what is signed: the prefill, the answers, the ratings and the ICO reference. */
export function dpiaVersionSha256(
  row: Pick<DpiaRow, "prefill" | "answers" | "residualRisk" | "icoReference">,
): string {
  return createHash("sha256")
    .update(
      canonical({
        prefill: row.prefill,
        answers: row.answers,
        residualRisk: row.residualRisk,
        icoReference: row.icoReference,
      }),
    )
    .digest("hex");
}

/**
 * The organisation's configuration as the prefill reads it. Modules come from the flags in force,
 * with the employee-monitoring flags on for the organisation or at any location; an AI provider
 * chosen counts the AI module as planned, so its addendum is signed before the module is switched
 * on (rule 22).
 */
export async function dpiaConfigFor(
  tx: Transaction,
  t: TenantRow,
  flags: Readonly<Record<string, boolean>>,
): Promise<DpiaConfig> {
  const locations = await tx
    .select({
      name: location.name,
      regulator: location.regulator,
      regulatorLocationId: location.regulatorLocationId,
    })
    .from(location)
    .where(isNull(location.deletedAt));
  const services = await tx
    .selectDistinct({ type: service.serviceType })
    .from(service)
    .where(isNull(service.deletedAt));
  const features = Object.entries(flags)
    .filter(([key, on]) => on && key.startsWith("module."))
    .map(([key]) => key as FlagKey);
  // Employee monitoring (H-1555): on for the organisation, or switched on at any location, counts
  // as a feature, so the prefill lists it and signing covers it; switching one on after signing
  // flags the signed DPIA for review.
  const locationRows = await flagRows(tx);
  for (const flag of DPIA_MONITORING_FLAGS) {
    const atALocation = locationRows.some(
      (r) => r.flagKey === flag && r.locationId !== null && r.enabled,
    );
    if (flags[flag] === true || atALocation) features.push(flag);
  }
  if (t.aiProvider && !features.includes("module.ai" as FlagKey)) {
    features.push("module.ai" as FlagKey);
  }
  const [devices] = await tx.select({ n: count() }).from(deviceBinding);
  const [people] = await tx
    .select({ n: count() })
    .from(person)
    .where(
      and(isNull(person.deletedAt), inArray(person.status, ["active", "on_leave", "in_hospital"])),
    );
  const [staff] = await tx
    .select({ n: count() })
    .from(tenantUser)
    .where(and(isNull(tenantUser.deletedAt), eq(tenantUser.status, "active")));
  const [schedule] = await tx
    .select({ at: max(retentionClass.createdAt) })
    .from(retentionClass)
    .where(isNull(retentionClass.tenantId));
  const overrides = await tx
    .select({ recordClass: retentionClass.recordClass })
    .from(retentionClass)
    .where(isNotNull(retentionClass.tenantId));
  return {
    tenant: {
      legalName: t.legalName,
      // CQC-regulated when any location is (its provider ID is then needed); otherwise another.
      regulator: locations.some((l) => l.regulator === "cqc") ? "cqc" : "other",
      cqcProviderId: t.cqcProviderId,
      sector: t.sector as DpiaConfig["tenant"]["sector"],
      dpo: t.dpoName && t.dpoEmail ? { name: t.dpoName, email: t.dpoEmail } : null,
      caldicottGuardian: t.caldicottGuardian,
      siro: t.siro,
      dpaSignedOn: t.dpaSignedOn,
      privacyNoticeUrl: t.privacyNoticeUrl,
    },
    locations: locations.map((l) => ({ name: l.name, regulatorLocationId: l.regulatorLocationId })),
    serviceTypes: services.map((s) => s.type).sort(),
    features,
    optional: { marketing: t.marketingEnabled, ai_free_text: t.aiFreeTextEnabled },
    // Push to staff phones always; SMS when the organisation has connected an SMS provider.
    capabilities: { mobilePush: true, sms: await hasPort(tx, "comms.sms") },
    aiProvider: (t.aiProvider as AiProvider | null) ?? null,
    deviceModes: (devices?.n ?? 0) > 0 ? ["personal", "shared"] : ["personal"],
    offlineWindowDays: await rateNumber(tx, t.id, OFFLINE_WINDOW_RATE_KEY),
    retention: {
      scheduleVersion: schedule?.at ? schedule.at.toISOString().slice(0, 10) : "not seeded",
      overrides: overrides.map((o) => o.recordClass).sort(),
    },
    stats: { activePeople: people?.n ?? 0, activeStaff: staff?.n ?? 0 },
  };
}

async function hasPort(tx: Transaction, port: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: integrationConnection.id })
    .from(integrationConnection)
    .where(eq(integrationConnection.port, port))
    .limit(1);
  return row !== undefined;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** A DPIA version as the API returns it. */
export function dpiaVersionItem(row: DpiaRow, names: StaffLookup) {
  return {
    id: row.id,
    dpiaVersion: row.dpiaVersion,
    status: row.status as "draft" | "prepared" | "signed" | "superseded",
    prefill: row.prefill as Record<string, unknown>,
    answers: row.answers as Record<string, Record<string, string>>,
    residualRisk: row.residualRisk as Record<string, "low" | "medium" | "high" | null>,
    icoReference: row.icoReference,
    preparedBy: row.preparedBy.flatMap((id) => {
      const name = names(id);
      return name ? [name] : [];
    }),
    versionSha256: row.versionSha256,
    preparedAt: iso(row.preparedAt),
    signedBy: names(row.signedBy),
    signedAt: iso(row.signedAt),
    typedName: row.typedName,
    statement: row.statement,
    version: row.version,
  };
}
