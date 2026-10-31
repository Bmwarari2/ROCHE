import type { Transaction } from "@harbour/db";
import type { WorkflowDefinition } from "@harbour/domain";
import type { Context } from "hono";
import { writeAudit } from "../http/audit";
import {
  type AppEnv,
  stepUpFresh as freshFor,
  permissionsReaching,
  stepUpRefusal,
  usablePermissions,
} from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { moveWorkflow, WorkflowMoveRefused, type WorkflowSubject } from "../services/workflow";

/**
 * Helpers for routes that move a record through the workflow engine (incidents, statutory
 * notifications, candour and the DoLS legal-change review): step-up freshness from the session,
 * and refusals turned into problem details, audited.
 */

/**
 * True when the session used a second factor within the step-up window (section 5.3; ADR-0072
 * amendment); a password sign-in alone never counts.
 */
export function stepUpFresh(c: Context<AppEnv>): boolean {
  return freshFor(c.get("access"));
}

/**
 * Moves a workflow, or throws the problem a person can act on (and audits the refusal). The
 * guards see the permissions that reach the subject's person (`permissionsReaching`), or for a
 * subject about no one those the session may use (ADR-0071 review round 1, L9), never one held
 * only at another home.
 */
export async function moveOrRefuse<S extends string>(
  c: Context<AppEnv>,
  tx: Transaction,
  definition: WorkflowDefinition<S>,
  subject: WorkflowSubject,
  to: S,
  reason: string | null | undefined,
  now: Date,
) {
  const access = c.get("access");
  const permissions = subject.personId
    ? await permissionsReaching(tx, access, subject.personId)
    : usablePermissions(access);
  try {
    return await moveWorkflow(
      tx,
      access.tenantId,
      definition,
      subject,
      {
        to,
        actorTenantUserId: access.tenantUserId,
        permissions: new Set(permissions),
        reason: reason ?? null,
        stepUpFresh: stepUpFresh(c),
      },
      now,
    );
  } catch (error) {
    if (!(error instanceof WorkflowMoveRefused)) throw error;
    if (
      ["missing_permission", "step_up_required", "separation_of_duties"].includes(error.problem)
    ) {
      await writeAudit(c.get("services").appPool, access, {
        action: `${definition.key}.${to}`,
        outcome: "denied",
        resourceType: subject.subjectType,
        resourceId: subject.subjectId,
        reason: error.problem,
        requestId: c.get("requestId"),
      });
    }
    switch (error.problem) {
      case "missing_permission":
        throw problems.forbidden();
      case "step_up_required":
        throw stepUpRefusal(access);
      case "separation_of_duties":
        throw new HttpProblem(403, "separation_of_duties", error.message);
      default:
        throw problems.invalid(error.message);
    }
  }
}
