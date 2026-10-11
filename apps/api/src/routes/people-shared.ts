import type { Transaction } from "@harbour/db";
import type { Permission } from "@harbour/domain";
import { z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { auditInTx, writeAudit } from "../http/audit";
import { type AppEnv, requirePermission, type TenantAccess } from "../http/context";
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
export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function actorOf(c: Context<AppEnv>): Actor {
  const access = c.get("access");
  return {
    tenantId: access.tenantId,
    tenantUserId: access.tenantUserId,
    permissions: new Set(access.effective.permissions),
    stepUpFresh: stepUpFresh(c),
  };
}

/** Requires the first of `permissions` the user holds (MFA and refusal audit as usual). */
export async function requireAnyPermission(
  c: Context<AppEnv>,
  permissions: readonly [Permission, ...Permission[]],
): Promise<TenantAccess> {
  const held = c.get("access").effective.permissions;
  return requirePermission(c, permissions.find((p) => held.has(p)) ?? permissions[0]);
}

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
      throw problems.stepUp();
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
    return await applyStatusChange(tx, actorOf(c), p, req, now);
  } catch (error) {
    return refusal(c, error, `people.person.status.${req.to}`, { type: "person", id: p.id });
  }
}
