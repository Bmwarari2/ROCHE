import {
  CreatePolicy,
  MyPolicies,
  NewPolicyVersion,
  PolicyItem,
  PolicyList,
  PublishPolicyVersion,
  ReadAndSignView,
  RetirePolicy,
  UpdatePolicyVersion,
} from "@harbour/contracts";
import { policy, policySignature, policyVersion, type Transaction } from "@harbour/db";
import {
  checkPolicyPublication,
  POLICY_PUBLICATION_MESSAGES,
  policyReviewStatus,
  readAndSignStatus,
  ukIsoDate,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Context } from "hono";
import { AuditedRefusal, withAuditedRefusal, writeAudit } from "../http/audit";
import {
  type AppEnv,
  refusalOf,
  requirePermission,
  type TenantAccess,
  usablePermissions,
  withTenant,
} from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { publish } from "../outbox";
import { contentHeaders, readDocumentContent } from "../services/documents";
import {
  domainVersion,
  endReviewTasks,
  endSignTasks,
  POLICY_MANAGE,
  type PolicyRow,
  type PolicyVersionRow,
  previousPublished,
  qualityRates,
  signaturesFor,
  staffWithRoles,
  unknownRoleKeys,
} from "../services/policies";
import { staffNames } from "../services/staff";
import { fileResponse } from "./documents";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";
import { audit, dbCode } from "./people-shared";

/**
 * The policy library and read-and-sign (quality.md section 18; QUAL-008; HZ-128; plan slice 25).
 * Every member reads policies and the versions published and signs the version in force; holders
 * of quality.policy.manage write, publish and retire them and see everyone's status. The database
 * enforces the same (migration 0087). Audit events carry opaque ids and codes only.
 */

const SOURCE = "policy";
const A = {
  created: "quality.policy.created",
  drafted: "quality.policy.drafted",
  edited: "quality.policy.edited",
  published: "quality.policy.published",
  retired: "quality.policy.retired",
  signed: "quality.policy.signed",
  statusViewed: "quality.policy.status_viewed",
} as const;

const PolicyParam = z.object({ id: z.uuid() });
const VersionParam = z.object({ id: z.uuid(), versionId: z.uuid() });
const stateConflict = (detail: string) => new HttpProblem(409, "invalid_state", detail);

const refused = (problem: HttpProblem, action: string, id: string | null, reason: string) =>
  new AuditedRefusal(problem, {
    action,
    outcome: "denied",
    resourceType: SOURCE,
    ...(id ? { resourceId: id } : {}),
    reason,
  });

/** Runs a change; refusals and the database's own (403, 409, 422) are audited. */
async function change<T>(
  c: Context<AppEnv>,
  access: TenantAccess,
  action: string,
  id: string | null,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  try {
    return await withAuditedRefusal(c, access, () => withTenant(c, fn));
  } catch (error) {
    const code = dbCode(error);
    if (!["42501", "23000", "23505", "23503", "23514"].includes(code ?? "")) throw error;
    await writeAudit(c.get("services").appPool, access, {
      action,
      outcome: "denied",
      resourceType: SOURCE,
      ...(id ? { resourceId: id } : {}),
      reason: code === "42501" ? "refused_by_database" : `invalid_${code}`,
      requestId: c.get("requestId"),
    });
    if (code === "42501") throw problems.forbidden();
    if (code === "23505") throw stateConflict("That already exists. Reload and try again.");
    if (code === "23503") throw problems.invalid("Choose one of the organisation's documents.");
    throw problems.invalid("That cannot be saved like that. Check the details and try again.");
  }
}

const manages = (c: Context<AppEnv>) => refusalOf(c.get("access"), POLICY_MANAGE) === null;

async function loadPolicy(tx: Transaction, id: string) {
  const [row] = await tx.select().from(policy).where(eq(policy.id, id));
  if (!row) return null;
  const versions = await tx
    .select()
    .from(policyVersion)
    .where(eq(policyVersion.policyId, id))
    .orderBy(desc(policyVersion.versionNumber));
  return { row, versions };
}

/** Whether the caller must sign the version in force, and has (rule 26). */
async function callerStatus(
  tx: Transaction,
  access: TenantAccess,
  row: PolicyRow,
  versions: readonly PolicyVersionRow[],
  inForce: PolicyVersionRow | undefined,
  now: Date,
) {
  if (!inForce) return { mustSign: false, signed: false };
  const previous = previousPublished(versions, inForce);
  const staff = (await staffWithRoles(tx, now)).filter((s) => s.id === access.tenantUserId);
  const signatures = (
    await signaturesFor(tx, row.policyKey, previous ? [inForce, previous] : [inForce])
  ).filter((s) => s.staffId === access.tenantUserId);
  const status = readAndSignStatus(
    domainVersion(row.policyKey, inForce),
    previous ? domainVersion(row.policyKey, previous) : null,
    staff,
    signatures,
    ukIsoDate(now),
  );
  return {
    mustSign: status.required.includes(access.tenantUserId),
    signed: status.signed.includes(access.tenantUserId),
  };
}

async function policyItem(
  c: Context<AppEnv>,
  tx: Transaction,
  access: TenantAccess,
  row: PolicyRow,
  versions: readonly PolicyVersionRow[],
) {
  const now = new Date();
  const today = ukIsoDate(now);
  const rates = await qualityRates(tx, access.tenantId, today);
  const inForce = versions.find((v) => v.state === "published");
  const visible = manages(c) ? versions : versions.filter((v) => v.state !== "draft");
  const mine = await callerStatus(tx, access, row, versions, inForce, now);
  const item = (v: PolicyVersionRow) => ({
    id: v.id,
    version: v.version,
    versionNumber: v.versionNumber,
    state: v.state as "draft" | "published" | "superseded" | "retired",
    change: v.change as "minor" | "major",
    changeSummary: v.changeSummary,
    body: v.body,
    documentId: v.documentId,
    roles: v.roles,
    reviewDueOn: v.reviewDueOn,
    reviewStatus: v.state === "published" ? policyReviewStatus(v, today, rates) : null,
    authorId: v.authorId,
    publishedBy: v.publishedBy,
    publishedOn: v.publishedOn,
    supersededAt: v.supersededAt?.toISOString() ?? null,
    // HZ-128: a superseded version always names the version in force.
    supersededBy: v.state === "superseded" ? (inForce?.id ?? null) : null,
    retiredReason: v.retiredReason,
  });
  return PolicyItem.parse({
    id: row.id,
    version: row.version,
    policyKey: row.policyKey,
    title: row.title,
    requireSecondReviewer: row.requireSecondReviewer,
    retiredAt: row.retiredAt?.toISOString() ?? null,
    inForce: inForce ? item(inForce) : null,
    versions: visible.map(item),
    ...mine,
  });
}

async function respond(c: Context<AppEnv>, access: TenantAccess, id: string) {
  return withTenant(c, async (tx) => {
    const found = await loadPolicy(tx, id);
    if (!found) throw problems.notFound();
    return policyItem(c, tx, access, found.row, found.versions);
  });
}

const policyResponses = {
  200: jsonBody(PolicyItem, "The policy"),
  ...errorResponses,
  ...notFoundResponse,
  ...conflictResponse,
};

export const policiesRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/policies",
      tags: ["quality"],
      summary: "The policy library",
      description:
        "Any member. Each policy with its version in force only (HZ-128), its review status, and whether the caller must sign it and has.",
      security,
      responses: { 200: jsonBody(PolicyList, "Policies"), ...errorResponses },
    }),
    async (c) => {
      const access = c.get("access");
      const now = new Date();
      const today = ukIsoDate(now);
      const items = await withTenant(c, async (tx) => {
        const rates = await qualityRates(tx, access.tenantId, today);
        const policies = await tx.select().from(policy).orderBy(asc(policy.title));
        const versions =
          policies.length === 0
            ? []
            : await tx
                .select()
                .from(policyVersion)
                .where(
                  inArray(
                    policyVersion.policyId,
                    policies.map((p) => p.id),
                  ),
                );
        const out = [];
        for (const p of policies) {
          if (p.retiredAt) continue;
          const mine = versions.filter((v) => v.policyId === p.id);
          const inForce = mine.find((v) => v.state === "published");
          const status = await callerStatus(tx, access, p, mine, inForce, now);
          out.push({
            id: p.id,
            policyKey: p.policyKey,
            title: p.title,
            inForce: inForce
              ? {
                  id: inForce.id,
                  versionNumber: inForce.versionNumber,
                  change: inForce.change as "minor" | "major",
                  publishedOn: inForce.publishedOn,
                  reviewDueOn: inForce.reviewDueOn,
                  reviewStatus: policyReviewStatus(inForce, today, rates),
                }
              : null,
            ...status,
          });
        }
        return out;
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/policies",
      tags: ["quality"],
      summary: "Create a policy with its first draft",
      description: "quality.policy.manage. The first version is a major change. Audited.",
      security,
      request: { body: { content: { "application/json": { schema: CreatePolicy } } } },
      responses: { 201: jsonBody(PolicyItem, "Created"), ...errorResponses, ...conflictResponse },
    }),
    async (c) => {
      const access = await requirePermission(c, POLICY_MANAGE);
      const body = c.req.valid("json");
      const id = await change(c, access, A.created, null, async (tx) => {
        const [row] = await tx
          .insert(policy)
          .values({
            policyKey: body.policyKey,
            title: body.title,
            requireSecondReviewer: body.requireSecondReviewer,
          })
          .returning({ id: policy.id });
        if (!row) throw new Error("policy not stored");
        await tx.insert(policyVersion).values({
          policyId: row.id,
          versionNumber: 0,
          change: "major",
          authorId: access.tenantUserId,
          ...body.firstVersion,
        });
        await audit(c, tx, access, { action: A.created, resourceType: SOURCE, resourceId: row.id });
        return row.id;
      });
      return c.json(await respond(c, access, id), 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/policies/{id}",
      tags: ["quality"],
      summary: "A policy and its versions",
      description:
        "Any member. The version in force and every version with the change log, newest first; a superseded version names the version in force (HZ-128). Drafts only for holders of quality.policy.manage.",
      security,
      request: { params: PolicyParam },
      responses: policyResponses,
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      return c.json(await respond(c, c.get("access"), id), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/policies/{id}/versions",
      tags: ["quality"],
      summary: "Start a new draft",
      description:
        "quality.policy.manage. A minor or major change, from the version in force unless content is given. One draft at a time. Audited.",
      security,
      request: {
        params: PolicyParam,
        body: { content: { "application/json": { schema: NewPolicyVersion } } },
      },
      responses: policyResponses,
    }),
    async (c) => {
      const access = await requirePermission(c, POLICY_MANAGE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      await change(c, access, A.drafted, id, async (tx) => {
        const found = await loadPolicy(tx, id);
        if (!found) throw refused(problems.notFound(), A.drafted, id, "not_found");
        if (found.row.retiredAt) {
          throw refused(stateConflict("This policy is retired."), A.drafted, id, "retired");
        }
        const base = found.versions.find((v) => v.state === "published") ?? found.versions[0];
        const [row] = await tx
          .insert(policyVersion)
          .values({
            policyId: id,
            versionNumber: 0,
            change: body.change,
            changeSummary: body.changeSummary,
            body: body.body !== undefined ? body.body : (base?.body ?? null),
            documentId:
              body.documentId !== undefined ? body.documentId : (base?.documentId ?? null),
            roles: body.roles ?? base?.roles ?? [],
            reviewDueOn: body.reviewDueOn !== undefined ? body.reviewDueOn : null,
            authorId: access.tenantUserId,
          })
          .returning({ id: policyVersion.id });
        await audit(c, tx, access, {
          action: A.drafted,
          resourceType: "policy_version",
          resourceId: row?.id ?? id,
          scopeExtra: { policyId: id, change: body.change },
        });
      });
      return c.json(await respond(c, access, id), 200);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/v1/policies/{id}/versions/{versionId}",
      tags: ["quality"],
      summary: "Change a draft",
      description: "quality.policy.manage, drafts only, against the version you loaded. Audited.",
      security,
      request: {
        params: VersionParam,
        body: { content: { "application/json": { schema: UpdatePolicyVersion } } },
      },
      responses: policyResponses,
    }),
    async (c) => {
      const access = await requirePermission(c, POLICY_MANAGE);
      const { id, versionId } = c.req.valid("param");
      const { expectedVersion, ...body } = c.req.valid("json");
      await change(c, access, A.edited, versionId, async (tx) => {
        const [found] = await tx
          .select()
          .from(policyVersion)
          .where(and(eq(policyVersion.id, versionId), eq(policyVersion.policyId, id)));
        if (!found) throw refused(problems.notFound(), A.edited, versionId, "not_found");
        if (found.state !== "draft") {
          throw refused(
            stateConflict("Only a draft can be changed."),
            A.edited,
            versionId,
            "not_draft",
          );
        }
        const [row] = await tx
          .update(policyVersion)
          .set(body)
          .where(and(eq(policyVersion.id, versionId), eq(policyVersion.version, expectedVersion)))
          .returning({ id: policyVersion.id });
        if (!row) throw refused(problems.conflict(), A.edited, versionId, "version_conflict");
        await audit(c, tx, access, {
          action: A.edited,
          resourceType: "policy_version",
          resourceId: versionId,
          scopeExtra: { policyId: id },
        });
      });
      return c.json(await respond(c, access, id), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/policies/{id}/versions/{versionId}/publish",
      tags: ["quality"],
      summary: "Publish a draft",
      description:
        "quality.policy.manage, in the caller's own name; never the author where the policy needs a second reviewer. Needs at least one role and a review date after today and within policy.review_interval_months.max. Supersedes the version in force and ends its read-and-sign reminders (HZ-128). Audited; outbox quality.policy.published.",
      security,
      request: {
        params: VersionParam,
        body: { content: { "application/json": { schema: PublishPolicyVersion } } },
      },
      responses: policyResponses,
    }),
    async (c) => {
      const access = await requirePermission(c, POLICY_MANAGE);
      const { id, versionId } = c.req.valid("param");
      const body = c.req.valid("json");
      const today = ukIsoDate(new Date());
      await change(c, access, A.published, versionId, async (tx) => {
        const found = await loadPolicy(tx, id);
        const draft = found?.versions.find((v) => v.id === versionId);
        if (!found || !draft)
          throw refused(problems.notFound(), A.published, versionId, "not_found");
        if (draft.version !== body.expectedVersion) {
          throw refused(problems.conflict(), A.published, versionId, "version_conflict");
        }
        const unknown = await unknownRoleKeys(tx, draft.roles);
        if (unknown.length > 0) {
          throw refused(
            problems.invalid(
              "Choose roles your organisation has. Some of the roles named do not exist.",
            ),
            A.published,
            versionId,
            "unknown_role",
          );
        }
        const rates = await qualityRates(tx, access.tenantId, today);
        const problemsFound = checkPolicyPublication(
          domainVersion(found.row.policyKey, draft),
          {
            publisherId: access.tenantUserId,
            publishedOn: today,
            permissions: [...usablePermissions(access)],
            requireSecondReviewer: found.row.requireSecondReviewer,
          },
          rates,
        );
        const first = problemsFound[0];
        if (first) {
          throw refused(
            first === "missing_permission" || first === "second_reviewer_required"
              ? new HttpProblem(403, first, POLICY_PUBLICATION_MESSAGES[first])
              : first === "not_draft"
                ? stateConflict(POLICY_PUBLICATION_MESSAGES[first])
                : problems.invalid(POLICY_PUBLICATION_MESSAGES[first]),
            A.published,
            versionId,
            first,
          );
        }
        const previous = found.versions.find((v) => v.state === "published");
        const [row] = await tx
          .update(policyVersion)
          .set({ state: "published", publishedBy: access.tenantUserId })
          .where(and(eq(policyVersion.id, versionId), eq(policyVersion.version, draft.version)))
          .returning({ id: policyVersion.id });
        if (!row) throw refused(problems.conflict(), A.published, versionId, "version_conflict");
        if (previous) {
          await endSignTasks(tx, previous.id, {
            status: "cancelled",
            reason: "Ended: a newer version was published",
          });
          await endReviewTasks(tx, previous.id, "Ended: a newer version was published");
        }
        await audit(c, tx, access, {
          action: A.published,
          resourceType: "policy_version",
          resourceId: versionId,
          scopeExtra: { policyId: id, change: draft.change, superseded: previous?.id ?? null },
        });
        await publish(tx, {
          context: "quality",
          aggregateType: "policy_version",
          aggregateId: versionId,
          type: "quality.policy.published",
          payload: { policyId: id, versionNumber: draft.versionNumber, change: draft.change },
        });
      });
      return c.json(await respond(c, access, id), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/policies/{id}/retire",
      tags: ["quality"],
      summary: "Retire a policy",
      description:
        "quality.policy.manage, with a reason. The version in force becomes retired and its reminders end; the policy leaves the library list. Audited.",
      security,
      request: {
        params: PolicyParam,
        body: { content: { "application/json": { schema: RetirePolicy } } },
      },
      responses: policyResponses,
    }),
    async (c) => {
      const access = await requirePermission(c, POLICY_MANAGE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      await change(c, access, A.retired, id, async (tx) => {
        // Locked first, so a publication meanwhile waits and sees the retirement (finding 7).
        await tx.select({ id: policy.id }).from(policy).where(eq(policy.id, id)).for("update");
        const found = await loadPolicy(tx, id);
        if (!found) throw refused(problems.notFound(), A.retired, id, "not_found");
        if (found.row.retiredAt) {
          throw refused(stateConflict("This policy is already retired."), A.retired, id, "retired");
        }
        const [row] = await tx
          .update(policy)
          .set({ retiredAt: new Date(), retiredReason: body.reason })
          .where(and(eq(policy.id, id), eq(policy.version, body.expectedVersion)))
          .returning({ id: policy.id });
        if (!row) throw refused(problems.conflict(), A.retired, id, "version_conflict");
        const inForce = found.versions.find((v) => v.state === "published");
        if (inForce) {
          await tx
            .update(policyVersion)
            .set({ state: "retired", retiredReason: body.reason })
            .where(eq(policyVersion.id, inForce.id));
          await endSignTasks(tx, inForce.id, {
            status: "cancelled",
            reason: "Ended: the policy was retired",
          });
          await endReviewTasks(tx, inForce.id, "Ended: the policy was retired");
        }
        await audit(c, tx, access, { action: A.retired, resourceType: SOURCE, resourceId: id });
      });
      return c.json(await respond(c, access, id), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/policies/{id}/versions/{versionId}/signatures",
      tags: ["quality"],
      summary: "Read and sign the version in force",
      description:
        "Any member, in their own name, on the version in force only (HZ-128): a draft, superseded or retired version is refused. Completes the member's reminder. Audited.",
      security,
      request: { params: VersionParam },
      responses: policyResponses,
    }),
    async (c) => {
      const access = c.get("access");
      const { id, versionId } = c.req.valid("param");
      await change(c, access, A.signed, versionId, async (tx) => {
        const [found] = await tx
          .select({ state: policyVersion.state })
          .from(policyVersion)
          .where(and(eq(policyVersion.id, versionId), eq(policyVersion.policyId, id)));
        if (!found) throw refused(problems.notFound(), A.signed, versionId, "not_found");
        if (found.state !== "published") {
          throw refused(
            stateConflict("This version is not in force. Open the current version to sign it."),
            A.signed,
            versionId,
            `not_in_force_${found.state}`,
          );
        }
        await tx
          .insert(policySignature)
          .values({ policyVersionId: versionId, signerId: access.tenantUserId });
        await endSignTasks(
          tx,
          versionId,
          { status: "done", reason: "Signed" },
          access.tenantUserId,
        );
        await audit(c, tx, access, {
          action: A.signed,
          resourceType: "policy_version",
          resourceId: versionId,
          scopeExtra: { policyId: id },
        });
      });
      return c.json(await respond(c, access, id), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/policies/{id}/versions/{versionId}/read-and-sign",
      tags: ["quality"],
      summary: "Who has read and signed a version",
      description:
        "quality.policy.manage. Who must sign the version in force, who has and who is outstanding since when (rule 26). Audited.",
      security,
      request: { params: VersionParam },
      responses: {
        200: jsonBody(ReadAndSignView, "Read-and-sign status"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, POLICY_MANAGE);
      const { id, versionId } = c.req.valid("param");
      const now = new Date();
      const view = await withTenant(c, async (tx) => {
        const found = await loadPolicy(tx, id);
        const current = found?.versions.find((v) => v.id === versionId);
        if (!found || !current) throw problems.notFound();
        const previous = previousPublished(found.versions, current);
        const staff = await staffWithRoles(tx, now);
        const signatures = await signaturesFor(
          tx,
          found.row.policyKey,
          previous ? [current, previous] : [current],
        );
        const status = readAndSignStatus(
          domainVersion(found.row.policyKey, current),
          previous ? domainVersion(found.row.policyKey, previous) : null,
          staff,
          signatures,
          ukIsoDate(now),
        );
        const names = await staffNames(tx, status.required);
        const name = (memberId: string) => names(memberId)?.displayName ?? "Member of staff";
        await audit(c, tx, access, {
          action: A.statusViewed,
          resourceType: "policy_version",
          resourceId: versionId,
        });
        return {
          versionId,
          required: status.required.length,
          signed: status.signed.map((memberId) => ({ memberId, displayName: name(memberId) })),
          outstanding: status.outstanding.map((o) => ({
            memberId: o.staffId,
            displayName: name(o.staffId),
            dueFrom: o.dueFrom,
          })),
        };
      });
      return c.json(view, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/policies/{id}/versions/{versionId}/document",
      tags: ["quality"],
      summary: "A policy version's PDF",
      description:
        "Any member for a published, superseded or retired version; drafts only for holders of quality.policy.manage. The response says the version's state and, when superseded, the version in force (x-harbour-policy-state, x-harbour-policy-in-force; HZ-128). Audited.",
      security,
      request: { params: VersionParam },
      responses: { 200: fileResponse("The file"), ...errorResponses, ...notFoundResponse },
    }),
    async (c) => {
      const access = c.get("access");
      const { id, versionId } = c.req.valid("param");
      const { storage } = c.get("services");
      const result = await withTenant(c, async (tx) => {
        const found = await loadPolicy(tx, id);
        const version = found?.versions.find((v) => v.id === versionId);
        if (!found || !version?.documentId) throw problems.notFound();
        const content = await readDocumentContent(tx, storage, version.documentId);
        const inForce = found.versions.find((v) => v.state === "published");
        await audit(c, tx, access, {
          action: "quality.policy.document_viewed",
          resourceType: "policy_version",
          resourceId: versionId,
          scopeExtra: { policyId: id, state: version.state },
        });
        return { ...content, state: version.state, inForce: inForce?.id ?? null };
      });
      return c.body(result.bytes as Uint8Array<ArrayBuffer>, 200, {
        ...contentHeaders(result.row),
        "x-harbour-policy-state": result.state,
        ...(result.state === "superseded" && result.inForce
          ? { "x-harbour-policy-in-force": result.inForce }
          : {}),
      });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/me/policies",
      tags: ["quality"],
      summary: "Policies I must read and sign",
      description: "Any member. The versions in force the caller must sign and has not.",
      security,
      responses: { 200: jsonBody(MyPolicies, "Your policies to sign"), ...errorResponses },
    }),
    async (c) => {
      const access = c.get("access");
      const now = new Date();
      const items = await withTenant(c, async (tx) => {
        const rows = await tx
          .select({ p: policy, v: policyVersion })
          .from(policyVersion)
          .innerJoin(policy, eq(policy.id, policyVersion.policyId))
          .where(eq(policyVersion.state, "published"));
        const out = [];
        for (const { p, v } of rows) {
          if (p.retiredAt) continue;
          const versions = await tx
            .select()
            .from(policyVersion)
            .where(eq(policyVersion.policyId, p.id));
          const previous = previousPublished(versions, v);
          const staff = (await staffWithRoles(tx, now)).filter((s) => s.id === access.tenantUserId);
          const signatures = (
            await signaturesFor(tx, p.policyKey, previous ? [v, previous] : [v])
          ).filter((s) => s.staffId === access.tenantUserId);
          const status = readAndSignStatus(
            domainVersion(p.policyKey, v),
            previous ? domainVersion(p.policyKey, previous) : null,
            staff,
            signatures,
            ukIsoDate(now),
          );
          const mine = status.outstanding.find((o) => o.staffId === access.tenantUserId);
          if (mine) {
            out.push({
              policyId: p.id,
              versionId: v.id,
              title: p.title,
              versionNumber: v.versionNumber,
              dueFrom: mine.dueFrom,
            });
          }
        }
        return out;
      });
      return c.json({ items }, 200);
    },
  );
