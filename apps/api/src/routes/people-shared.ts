import { document, type Transaction } from "@harbour/db";
import { z } from "@hono/zod-openapi";
import { and, eq, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { auditInTx, writeAudit } from "../http/audit";
import {
  type AppEnv,
  permissionsReaching,
  requireAnyPermission,
  stepUpRefusal,
  type TenantAccess,
} from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import {
  type Actor,
  applyStatusChange,
  type PersonRecord,
  PersonStatusRefused,
  type StatusChangeOutcome,
  type StatusChangeRequest,
  WorkflowMoveRefused,
} from "../services/people";
import { stepUpFresh } from "./workflow-shared";

/**
 * Helpers for the people lifecycle routes (people.md section 6): who is acting, status changes
 * with their refusals turned into problem details (and audited where access was refused), and
 * permissions that any one of several roles may hold.
 */

export const PersonParam = z.object({ id: z.uuid() });

/**
 * Rooms and locations carry only the tenant policy in the database, so the API checks that the
 * caller works there for what they are doing: the scope of the permission the route required
 * (`access.context`, ADR-0071) is tenant-wide, or includes the location (HZ-011). Anything else
 * reads as not found.
 */
export function requireLocationInScope(access: TenantAccess, locationId: string): void {
  const { scope, locationIds } = access.context;
  if (scope === "tenant") return;
  if (scope === "locations" && locationIds.includes(locationId)) return;
  throw problems.notFound();
}
export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/**
 * Who is acting on one person's record, with the permissions whose roles and grants reach that
 * person only (ADR-0071), never one held only somewhere else.
 */
export async function actorOf(
  c: Context<AppEnv>,
  tx: Transaction,
  personId: string,
): Promise<Actor> {
  const access = c.get("access");
  return {
    tenantId: access.tenantId,
    tenantUserId: access.tenantUserId,
    permissions: await permissionsReaching(tx, access, personId),
    stepUpFresh: stepUpFresh(c),
  };
}

/** Requires any one of several permissions, in the scope of those the user may use (ADR-0071). */
export { requireAnyPermission };

export function audit(
  c: Context<AppEnv>,
  tx: Transaction,
  access: TenantAccess,
  input: Parameters<typeof auditInTx>[2],
) {
  return auditInTx(tx, access, { ...input, requestId: c.get("requestId") });
}

export function dbCode(error: unknown): string | undefined {
  return (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
}

/**
 * A document a record cites must be in the same person's documents (never another's), available
 * (not quarantined or destroyed) and, when `categories` is given, of one of those categories (a
 * person's document, never a photo or a care attachment as evidence of an authority).
 */
export async function requireOwnDocument(
  tx: Transaction,
  personId: string,
  documentId: string | null | undefined,
  what: string,
  categories?: readonly string[],
): Promise<void> {
  if (!documentId) return;
  const [found] = await tx
    .select({
      personId: document.personId,
      status: document.status,
      category: document.category,
    })
    .from(document)
    .where(and(eq(document.id, documentId), isNull(document.deletedAt)));
  if (
    found?.personId !== personId ||
    found.status !== "available" ||
    (categories !== undefined && !categories.includes(found.category))
  ) {
    throw problems.invalid(`The ${what} was not found in this person's documents.`);
  }
}

/** Requires a fresh sign-in (step-up) for the action, auditing the refusal. */
export async function requireStepUp(
  c: Context<AppEnv>,
  access: TenantAccess,
  action: string,
): Promise<void> {
  if (stepUpFresh(c)) return;
  await writeAudit(c.get("services").appPool, access, {
    action,
    outcome: "denied",
    reason: "step_up_required",
    requestId: c.get("requestId"),
  });
  throw stepUpRefusal(access);
}

/** A foreign key that points nowhere (another person's contact or document) reads as invalid. */
export function invalidOnForeignKey(what: string) {
  return (error: unknown): never => {
    if (dbCode(error) === "23503") throw problems.invalid(`The ${what} was not found.`);
    throw error;
  };
}

const ACCESS_PROBLEMS = new Set(["missing_permission", "step_up_required", "separation_of_duties"]);

/** Turns a refused status change or workflow move into the problem a person can act on. */
export async function refusal(
  c: Context<AppEnv>,
  error: unknown,
  action: string,
  resource: { type: string; id: string },
): Promise<never> {
  if (!(error instanceof PersonStatusRefused) && !(error instanceof WorkflowMoveRefused))
    throw error;
  if (ACCESS_PROBLEMS.has(error.problem)) {
    await writeAudit(c.get("services").appPool, c.get("access"), {
      action,
      outcome: "denied",
      resourceType: resource.type,
      resourceId: resource.id,
      reason: error.problem,
      requestId: c.get("requestId"),
    });
  }
  switch (error.problem) {
    case "missing_permission":
      throw problems.forbidden();
    case "step_up_required":
      throw stepUpRefusal(c.get("access"));
    case "separation_of_duties":
      throw new HttpProblem(403, "separation_of_duties", error.message);
    default:
      throw problems.invalid(error.message);
  }
}

/** Runs a status change in the caller's transaction, or throws its refusal. */
export async function changeStatus(
  c: Context<AppEnv>,
  tx: Transaction,
  p: PersonRecord,
  req: StatusChangeRequest,
  now: Date,
): Promise<StatusChangeOutcome> {
  try {
    return await applyStatusChange(tx, await actorOf(c, tx, p.id), p, req, now);
  } catch (error) {
    return refusal(c, error, `people.person.status.${req.to}`, { type: "person", id: p.id });
  }
}
