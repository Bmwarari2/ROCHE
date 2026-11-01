import {
  policy,
  policySignature,
  policyVersion,
  role,
  roleAssignment,
  type Transaction,
  task,
  tenantUser,
} from "@harbour/db";
import {
  addUkDays,
  type Outstanding,
  type PolicyChange,
  type PolicySignature,
  type PolicyState,
  type PolicyVersion,
  policyReviewStatus,
  QUALITY_PHASE_2_RATE_KEYS,
  type QualityPhase2Rates,
  readAndSignRemindersDue,
  readAndSignStatus,
  resolveQualityPhase2Rates,
  type StaffMember,
  ukEndOfDay,
  ukIsoDate,
} from "@harbour/domain";
import { and, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { rateRows } from "./rates";
import { ON_STAFF } from "./role-holders";
import { withSystemRights } from "./system-rights";

/**
 * The policy library and read-and-sign (quality.md section 19; QUAL-008; HZ-128): the stored rows
 * as the slice 8 rules read them, who must sign, and the reminder and review tasks raised through
 * the task engine.
 */

export type PolicyRow = typeof policy.$inferSelect;
export type PolicyVersionRow = typeof policyVersion.$inferSelect;

export const POLICY_SIGN_TASK = "quality.policy_read_and_sign";
export const POLICY_REVIEW_TASK = "quality.policy_review";
export const POLICY_MANAGE = "quality.policy.manage";
export const POLICY_VERSION_SOURCE = "policy_version";

/** The Phase 2 quality figures in force on a UK date (England until the nation packs). */
export async function qualityRates(
  tx: Transaction,
  tenantId: string,
  on: string,
): Promise<QualityPhase2Rates> {
  const rows = await rateRows(tx, Object.values(QUALITY_PHASE_2_RATE_KEYS));
  return resolveQualityPhase2Rates(rows, "england", on, tenantId);
}

/** The domain's view of a stored version. */
export function domainVersion(policyKey: string, row: PolicyVersionRow): PolicyVersion {
  return {
    policyKey,
    version: row.versionNumber,
    state: row.state as PolicyState,
    change: row.change as PolicyChange,
    authorId: row.authorId,
    publishedOn: row.publishedOn,
    reviewDueOn: row.reviewDueOn,
    roles: row.roles,
  };
}

/**
 * Every member on staff with the role keys they hold now (a tenant role's key and the built-in key
 * it is based on) and the UK date their earliest assignment in force began: the staff the slice 8
 * rule counts (a member with no assignment in force has left and is not listed).
 */
export async function staffWithRoles(tx: Transaction, now: Date): Promise<StaffMember[]> {
  const rows = await tx
    .select({
      memberId: roleAssignment.tenantUserId,
      key: role.key,
      basedOn: role.basedOnKey,
      from: roleAssignment.validFrom,
    })
    .from(roleAssignment)
    .innerJoin(role, eq(role.id, roleAssignment.roleId))
    .innerJoin(tenantUser, eq(tenantUser.id, roleAssignment.tenantUserId))
    .where(
      and(
        isNull(roleAssignment.deletedAt),
        isNull(role.archivedAt),
        isNull(role.deletedAt),
        isNull(tenantUser.deletedAt),
        inArray(tenantUser.status, [...ON_STAFF]),
        lte(roleAssignment.validFrom, now),
        or(isNull(roleAssignment.validTo), sql`${roleAssignment.validTo} > ${now}`),
      ),
    );
  const byMember = new Map<string, { roles: Set<string>; startedOn: string }>();
  for (const r of rows) {
    const day = ukIsoDate(r.from);
    const entry = byMember.get(r.memberId) ?? { roles: new Set<string>(), startedOn: day };
    entry.roles.add(r.key);
    if (r.basedOn) entry.roles.add(r.basedOn);
    if (day < entry.startedOn) entry.startedOn = day;
    byMember.set(r.memberId, entry);
  }
  return [...byMember].map(([id, e]) => ({
    id,
    roles: [...e.roles],
    startedOn: e.startedOn,
    leftOn: null,
  }));
}

/** The version a minor change kept the signatures of: the newest superseded one before it. */
export function previousPublished(
  versions: readonly PolicyVersionRow[],
  current: PolicyVersionRow,
): PolicyVersionRow | null {
  return (
    versions
      .filter(
        (v) =>
          v.policyId === current.policyId &&
          v.versionNumber < current.versionNumber &&
          v.state === "superseded",
      )
      .sort((a, b) => b.versionNumber - a.versionNumber)[0] ?? null
  );
}

/** The signatures counting for a version: on it, and on the one it superseded. */
export async function signaturesFor(
  tx: Transaction,
  policyKey: string,
  versions: readonly PolicyVersionRow[],
): Promise<PolicySignature[]> {
  if (versions.length === 0) return [];
  const byId = new Map(versions.map((v) => [v.id, v]));
  const rows = await tx
    .select()
    .from(policySignature)
    .where(inArray(policySignature.policyVersionId, [...byId.keys()]));
  return rows.map((r) => ({
    staffId: r.signerId,
    policyKey,
    version: byId.get(r.policyVersionId)?.versionNumber ?? 0,
    signedOn: ukIsoDate(r.signedAt),
  }));
}

/** Who must sign the version in force, who has and who is outstanding (rule 26). */
export async function versionStatus(
  tx: Transaction,
  policyRow: PolicyRow,
  versions: readonly PolicyVersionRow[],
  current: PolicyVersionRow,
  now: Date,
) {
  const previous = previousPublished(versions, current);
  const staff = await staffWithRoles(tx, now);
  const signatures = await signaturesFor(
    tx,
    policyRow.policyKey,
    previous ? [current, previous] : [current],
  );
  return readAndSignStatus(
    domainVersion(policyRow.policyKey, current),
    previous ? domainVersion(policyRow.policyKey, previous) : null,
    staff,
    signatures,
    ukIsoDate(now),
  );
}

/** Ends the open read-and-sign tasks of a version (all members, or one), as done or cancelled. */
export function endSignTasks(
  tx: Transaction,
  versionId: string,
  outcome: { readonly status: "done" | "cancelled"; readonly reason: string },
  memberId?: string,
): Promise<number> {
  return withSystemRights(tx, async () => {
    const ended = await tx
      .update(task)
      .set({
        status: outcome.status,
        statusReason: outcome.reason,
        ...(outcome.status === "done" ? { completedAt: new Date(), completedBy: memberId } : {}),
      })
      .where(
        and(
          eq(task.kind, POLICY_SIGN_TASK),
          eq(task.sourceType, POLICY_VERSION_SOURCE),
          eq(task.sourceId, versionId),
          inArray(task.status, ["open", "in_progress"]),
          memberId ? eq(task.assigneeTenantUserId, memberId) : undefined,
        ),
      )
      .returning({ id: task.id });
    return ended.length;
  });
}

/**
 * Read-and-sign reminders and review tasks (quality.md section 19.3; rules 27 and 28; HZ-128). For
 * each version in force: a task assigned to each outstanding member when the reminder interval has
 * passed since they became due or their last reminder (the previous one cancelled); and one review
 * task per review state (`due_soon`, `overdue`), assigned to the author, or the publisher when the
 * author has left. Runs as the system in each organisation.
 */
export async function raisePolicyReminders(
  tx: Transaction,
  tenantId: string,
  now: Date,
): Promise<number> {
  const today = ukIsoDate(now);
  const rates = await qualityRates(tx, tenantId, today);
  const rows = await tx
    .select({ p: policy, v: policyVersion })
    .from(policyVersion)
    .innerJoin(policy, eq(policy.id, policyVersion.policyId))
    .where(and(eq(policyVersion.state, "published"), isNull(policy.retiredAt)));
  if (rows.length === 0) return 0;
  const staff = await staffWithRoles(tx, now);
  const managers = await policyManagers(tx, now);
  let raised = 0;
  for (const { p, v } of rows) {
    const versions = await tx.select().from(policyVersion).where(eq(policyVersion.policyId, p.id));
    const previous = previousPublished(versions, v);
    const signatures = await signaturesFor(tx, p.policyKey, previous ? [v, previous] : [v]);
    const status = readAndSignStatus(
      domainVersion(p.policyKey, v),
      previous ? domainVersion(p.policyKey, previous) : null,
      staff,
      signatures,
      today,
    );
    const sent = await tx
      .select({
        assignee: task.assigneeTenantUserId,
        createdAt: task.createdAt,
        kind: task.kind,
        details: task.details,
      })
      .from(task)
      .where(and(eq(task.sourceType, POLICY_VERSION_SOURCE), eq(task.sourceId, v.id)))
      .orderBy(desc(task.createdAt));
    const lastReminded: Record<string, string> = {};
    for (const s of sent) {
      const on =
        (s.details as { remindedOn?: string } | null)?.remindedOn ?? ukIsoDate(s.createdAt);
      if (s.kind === POLICY_SIGN_TASK && s.assignee && (lastReminded[s.assignee] ?? "") < on) {
        lastReminded[s.assignee] = on;
      }
    }
    // A member never reminded about this version is told at once, on the first run after it is
    // published or they became due (security and clinical safety reviews round 1: no week's wait
    // after a major change); then every `policy.read_and_sign.reminder_days` (rule 27).
    const due = new Set([
      ...status.outstanding.filter((o) => !lastReminded[o.staffId]).map((o) => o.staffId),
      ...readAndSignRemindersDue(status.outstanding as Outstanding[], lastReminded, today, rates),
    ]);
    for (const memberId of due) {
      await endSignTasks(tx, v.id, { status: "cancelled", reason: "Reminded again" }, memberId);
      await tx.insert(task).values({
        kind: POLICY_SIGN_TASK,
        title: "Read and sign a policy",
        requiredPermission: POLICY_MANAGE,
        sourceType: POLICY_VERSION_SOURCE,
        sourceId: v.id,
        assigneeTenantUserId: memberId,
        // Due at the next reminder, when a new one replaces it: never overdue the same evening
        // (security review round 1, finding 4).
        dueAt: addUkDays(ukEndOfDay(today), rates.readAndSignReminderDays),
        priority: "routine",
        details: { policyId: p.id, remindedOn: today },
      });
      raised += 1;
    }
    const review = policyReviewStatus(v, today, rates);
    if (review === "due_soon" || review === "overdue") {
      const already = sent.some(
        (s) =>
          s.kind === POLICY_REVIEW_TASK &&
          (s.details as { reviewStatus?: string } | null)?.reviewStatus === review,
      );
      // Someone who can act on it: the author, else the publisher, else any holder of manage, each
      // only while they hold it (clinical safety review round 1, finding 6).
      const owner = [v.authorId, v.publishedBy, ...[...managers].sort()].find(
        (id): id is string => id !== null && managers.has(id),
      );
      if (!already && owner) {
        await tx.insert(task).values({
          kind: POLICY_REVIEW_TASK,
          title: "Review a policy",
          requiredPermission: POLICY_MANAGE,
          sourceType: POLICY_VERSION_SOURCE,
          sourceId: v.id,
          assigneeTenantUserId: owner,
          dueAt: ukEndOfDay(v.reviewDueOn ?? today),
          priority: review === "overdue" ? "urgent" : "routine",
          details: { policyId: p.id, reviewStatus: review },
        });
        raised += 1;
      }
    }
  }
  return raised;
}

/**
 * How the policy library uses some documents (security and clinical safety reviews round 1,
 * HZ-128): `in_force` when a published version's content, `not_in_force` when only a draft's, a
 * superseded or a retired version's. Read with the system's rights, because drafts are hidden from
 * most members and a draft's PDF must stay hidden too. The general document routes serve a policy
 * document only while it is in force, and never take a new version of one.
 */
export async function policyDocumentUse(
  tx: Transaction,
  documentIds: readonly string[],
): Promise<Map<string, "in_force" | "not_in_force">> {
  const use = new Map<string, "in_force" | "not_in_force">();
  if (documentIds.length === 0) return use;
  const rows = await withSystemRights(tx, () =>
    tx
      .select({ documentId: policyVersion.documentId, state: policyVersion.state })
      .from(policyVersion)
      .where(inArray(policyVersion.documentId, [...documentIds])),
  );
  for (const r of rows) {
    if (!r.documentId) continue;
    if (r.state === "published") use.set(r.documentId, "in_force");
    else if (!use.has(r.documentId)) use.set(r.documentId, "not_in_force");
  }
  return use;
}

/** Members holding `quality.policy.manage` now through a role in force (who can act on a review). */
export async function policyManagers(tx: Transaction, now: Date): Promise<Set<string>> {
  const rows = await tx
    .select({ id: roleAssignment.tenantUserId })
    .from(roleAssignment)
    .innerJoin(role, eq(role.id, roleAssignment.roleId))
    .innerJoin(tenantUser, eq(tenantUser.id, roleAssignment.tenantUserId))
    .where(
      and(
        isNull(roleAssignment.deletedAt),
        isNull(role.archivedAt),
        isNull(role.deletedAt),
        isNull(tenantUser.deletedAt),
        eq(tenantUser.status, "active"),
        lte(roleAssignment.validFrom, now),
        or(isNull(roleAssignment.validTo), sql`${roleAssignment.validTo} > ${now}`),
        sql`${POLICY_MANAGE} = ANY (${role.permissions})`,
      ),
    );
  return new Set(rows.map((r) => r.id));
}

/** Ends a version's open review tasks once a newer version is published or the policy retired. */
export function endReviewTasks(
  tx: Transaction,
  versionId: string,
  reason: string,
): Promise<number> {
  return withSystemRights(tx, async () => {
    const ended = await tx
      .update(task)
      .set({ status: "cancelled", statusReason: reason })
      .where(
        and(
          eq(task.kind, POLICY_REVIEW_TASK),
          eq(task.sourceType, POLICY_VERSION_SOURCE),
          eq(task.sourceId, versionId),
          inArray(task.status, ["open", "in_progress"]),
        ),
      )
      .returning({ id: task.id });
    return ended.length;
  });
}

/**
 * Role keys a version names that no role of the organisation has (by its key or the built-in key
 * it is based on): a typing slip would leave nobody asked to sign (security and clinical safety
 * reviews round 1).
 */
export async function unknownRoleKeys(tx: Transaction, keys: readonly string[]): Promise<string[]> {
  if (keys.length === 0) return [];
  const rows = await tx
    .select({ key: role.key, basedOn: role.basedOnKey })
    .from(role)
    .where(and(isNull(role.archivedAt), isNull(role.deletedAt)));
  const known = new Set(rows.flatMap((r) => [r.key, r.basedOn].filter((k): k is string => !!k)));
  return keys.filter((k) => !known.has(k));
}
