import {
  advanceCareRecord,
  dcb0160Record,
  escalationChain,
  location,
  person,
  personCareProfile,
  rateTable,
  retentionClass,
  retentionDecision,
  role,
  roleAssignment,
  type Transaction,
  type tenant,
  tenantSettingDecision,
  tenantUser,
} from "@harbour/db";
import {
  ESCALATION_POLICY_TOOLS,
  type EscalationStep,
  type FlagKey,
  type OnboardingState,
  type Permission,
  type PersonStatus,
  type RetentionDecisionKind,
  subProcessorsInUse,
  tenantDefaultRateKeys,
  touchesCareRecords,
  validatedToolsWithLinks,
} from "@harbour/domain";
import { and, desc, eq, inArray, isNull, max, sql } from "drizzle-orm";
import type pg from "pg";
import type { FlagService } from "../flags/provider";
import { dpiaConfigFor, dpiaStateFor, tenantFlags } from "./dpia";
import { escalationLinks } from "./escalation-policies";
import { roleHolders, roleInForce } from "./role-holders";

/**
 * The organisation's state as the onboarding checklist reads it (platform-completions.md rules
 * 26 and 27; `onboardingChecklist`). Everything comes from records, never a box ticked. Where the
 * schema does not hold a fact yet, the state says so plainly rather than guessing done:
 * sub-processor acknowledgements arrive with the notices (rules 24 and 25), device modes and
 * device management with the kiosk work, the sample flag with sample data mode (rules 29 to 32)
 * (both unknown until then, so their go-live items stay open),
 * and the opt-out check date with the people module, so until then every current person counts as
 * not checked, and a recorded "no decision in place" resuscitation statement counts only once the
 * care module stores one.
 */

type TenantRow = typeof tenant.$inferSelect;

const PERSON_STATUSES_READ: readonly PersonStatus[] = ["active", "on_leave", "in_hospital"];

/** Whether each member has a second factor: an authenticator app or a passkey. */
async function mfaEnrolled(authPool: pg.Pool, authUserIds: readonly string[]) {
  if (authUserIds.length === 0) return new Set<string>();
  const { rows } = await authPool.query<{ id: string }>(
    `SELECT u.id FROM auth."user" u
      WHERE u.id = ANY($1::text[])
        AND (u.two_factor_enabled OR EXISTS (SELECT 1 FROM auth.passkey p WHERE p.user_id = u.id))`,
    [[...authUserIds]],
  );
  return new Set(rows.map((r) => r.id));
}

export async function onboardingStateFor(
  tx: Transaction,
  deps: {
    readonly flags: FlagService;
    readonly authPool: pg.Pool;
    readonly safetyCaseVersion: string;
  },
  t: TenantRow,
  now: Date,
): Promise<OnboardingState> {
  const flags = await tenantFlags(deps.flags, tx, t.id);
  const config = await dpiaConfigFor(tx, t, flags);
  const dpia = await dpiaStateFor(tx, t.id, config, now);

  const locations = await tx
    .select({
      id: location.id,
      regulator: location.regulator,
      regulatorLocationId: location.regulatorLocationId,
      odsCode: location.odsCode,
      status: location.status,
    })
    .from(location)
    .where(isNull(location.deletedAt));
  const activeLocationIds = locations.filter((l) => l.status === "active").map((l) => l.id);
  const managed = new Set<string>();
  for (const id of activeLocationIds) {
    if ((await roleHolders(tx, ["registered_manager"], [id], now)).length > 0) managed.add(id);
  }

  const members = await tx
    .select({ id: tenantUser.id, status: tenantUser.status, authUserId: tenantUser.authUserId })
    .from(tenantUser)
    .where(isNull(tenantUser.deletedAt));
  const roles = await tx
    .select({
      tenantUserId: roleAssignment.tenantUserId,
      key: role.key,
      permissions: role.permissions,
    })
    .from(roleAssignment)
    .innerJoin(role, eq(role.id, roleAssignment.roleId))
    .innerJoin(tenantUser, eq(tenantUser.id, roleAssignment.tenantUserId))
    .where(roleInForce(now));
  const enrolled = await mfaEnrolled(
    deps.authPool,
    members.flatMap((m) => (m.status === "active" && m.authUserId ? [m.authUserId] : [])),
  );

  // Settings Harbour chose: the latest global row's time is when Harbour last changed it.
  const globalRates = await tx
    .select({ key: rateTable.key, source: rateTable.source, createdAt: rateTable.createdAt })
    .from(rateTable)
    .where(isNull(rateTable.tenantId));
  const defaultKeys = new Set(tenantDefaultRateKeys(globalRates));
  const changed = new Map<string, Date>();
  for (const r of globalRates) {
    if (!defaultKeys.has(r.key)) continue;
    const at = changed.get(r.key);
    if (!at || r.createdAt > at) changed.set(r.key, r.createdAt);
  }

  const schedule = await tx
    .select({
      recordClass: retentionClass.recordClass,
      trigger: retentionClass.trigger,
      changedAt: retentionClass.createdAt,
    })
    .from(retentionClass)
    .where(isNull(retentionClass.tenantId));

  const chains = await tx
    .select({ key: escalationChain.key, steps: escalationChain.steps })
    .from(escalationChain)
    .where(isNull(escalationChain.deletedAt));

  // A tool switched on at any one location counts as in use (HZ-014): the go-live check must not
  // pass because the organisation-wide setting is off.
  const onSomewhere = new Set(
    (
      await tx.execute<{ flag_key: string }>(
        sql`SELECT DISTINCT flag_key FROM feature_flag
             WHERE deleted_at IS NULL AND enabled AND location_id IS NOT NULL`,
      )
    ).rows.map((r) => r.flag_key),
  );
  const tools = ESCALATION_POLICY_TOOLS.map((key) => {
    const flag = `care.tool.${key}`;
    return {
      key,
      enabled:
        ((flags as Record<string, boolean>)[flag as FlagKey] ?? true) || onSomewhere.has(flag),
    };
  });

  const people = await tx
    .select({
      id: person.id,
      status: person.status,
      photoDocumentId: person.photoDocumentId,
      allergyStatus: person.allergyStatus,
      communicationNeedsStatus: person.communicationNeedsStatus,
      iddsiFoodLevel: personCareProfile.iddsiFoodLevel,
      iddsiDrinkLevel: personCareProfile.iddsiDrinkLevel,
    })
    .from(person)
    .leftJoin(
      personCareProfile,
      and(
        eq(personCareProfile.tenantId, person.tenantId),
        eq(personCareProfile.personId, person.id),
        isNull(personCareProfile.deletedAt),
      ),
    )
    .where(and(isNull(person.deletedAt), inArray(person.status, [...PERSON_STATUSES_READ])));
  const resuscitation = new Set(
    (
      await tx
        .selectDistinct({ personId: advanceCareRecord.personId })
        .from(advanceCareRecord)
        .where(
          and(
            inArray(advanceCareRecord.kind, ["respect", "dnacpr"]),
            eq(advanceCareRecord.status, "active"),
            isNull(advanceCareRecord.deletedAt),
          ),
        )
    ).map((r) => r.personId),
  );

  const [dcb] = await tx
    .select({
      recordedAt: dcb0160Record.recordedAt,
      safetyCaseVersion: dcb0160Record.safetyCaseVersion,
    })
    .from(dcb0160Record)
    .orderBy(desc(dcb0160Record.recordedAt))
    .limit(1);

  return {
    locations: locations.map((l) => ({
      id: l.id,
      regulator: l.regulator,
      regulatorLocationId: l.regulatorLocationId,
      odsCode: l.odsCode,
      active: l.status === "active",
      registeredManagerAssigned: managed.has(l.id),
    })),
    users: members.map((m) => {
      const held = roles.filter((r) => r.tenantUserId === m.id);
      return {
        id: m.id,
        status: m.status as OnboardingState["users"][number]["status"],
        owner: held.some((r) => r.key === "owner"),
        readsCareRecords: held.some((r) =>
          r.permissions.some((p) => touchesCareRecords(p as Permission)),
        ),
        mfaEnrolled: m.authUserId !== null && enrolled.has(m.authUserId),
      };
    }),
    tenantDefaults: [...changed].map(([key, changedAt]) => ({ key, changedAt })),
    rateDecisions: (
      await tx
        .select({
          key: tenantSettingDecision.rateKey,
          decidedAt: max(tenantSettingDecision.decidedAt),
        })
        .from(tenantSettingDecision)
        .groupBy(tenantSettingDecision.rateKey)
    ).flatMap((r) => (r.decidedAt ? [{ key: r.key, decidedAt: r.decidedAt }] : [])),
    retentionClasses: schedule,
    retentionDecisions: (
      await tx
        .select({
          recordClass: retentionDecision.recordClass,
          kind: retentionDecision.kind,
          decidedAt: retentionDecision.decidedAt,
        })
        .from(retentionDecision)
    ).map((r) => ({ ...r, kind: r.kind as RetentionDecisionKind })),
    staffFileOption: t.staffFileOption,
    dpia: { state: dpia.state, triggers: dpia.triggers },
    subProcessorsInUse: subProcessorsInUse({
      features: config.features,
      capabilities: config.capabilities,
      aiProvider: config.aiProvider,
    }),
    subProcessorAcknowledgements: [],
    subProcessorChangedAt: {},
    dataOptOut: {
      usesDataBeyondDirectCare: t.usesDataBeyondDirectCare,
      peopleNotChecked: people.length,
    },
    // Not recorded yet: unknown, so these go-live items stay open (fail closed).
    sampleDataPresent: null,
    devices: null,
    escalationChains: chains.map((c) => ({ key: c.key, steps: c.steps as EscalationStep[] })),
    validatedTools: validatedToolsWithLinks(tools, await escalationLinks(tx), activeLocationIds),
    people: people.map((p) => ({
      id: p.id,
      status: p.status,
      sample: false,
      hasPhoto: p.photoDocumentId !== null,
      allergyStatus: p.allergyStatus,
      resuscitation: resuscitation.has(p.id) ? "recorded" : "not_recorded",
      communicationNeedsStatus:
        p.communicationNeedsStatus as OnboardingState["people"][number]["communicationNeedsStatus"],
      iddsiFoodLevel: p.iddsiFoodLevel ?? null,
      iddsiDrinkLevel: p.iddsiDrinkLevel ?? null,
    })),
    dcb0160: {
      recordedAt: dcb?.recordedAt ?? null,
      safetyCaseVersion: dcb?.safetyCaseVersion ?? null,
    },
    currentSafetyCaseVersion: deps.safetyCaseVersion,
  };
}
