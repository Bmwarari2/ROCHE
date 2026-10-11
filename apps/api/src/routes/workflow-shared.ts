import type { Transaction } from "@harbour/db";
import type { WorkflowDefinition } from "@harbour/domain";
import type { Context } from "hono";
import { writeAudit } from "../http/audit";
import type { AppEnv } from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { moveWorkflow, WorkflowMoveRefused, type WorkflowSubject } from "../services/workflow";

/**
 * Helpers for routes that move a record through the workflow engine (incidents, statutory
 * notifications, candour and the DoLS legal-change review): step-up freshness from the session,
 * and refusals turned into problem details, audited.
 */

/** True when the person signed in within the step-up window (section 5.3). */
export function stepUpFresh(c: Context<AppEnv>): boolean {
  const access = c.get("access");
  const windowSeconds = c.get("services").config.STEP_UP_WINDOW_SECONDS;
  return Date.now() - access.session.sessionCreatedAt.getTime() <= windowSeconds * 1000;
}

/** Moves a workflow, or throws the problem a person can act on (and audits the refusal). */
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
  try {
    return await moveWorkflow(
      tx,
      access.tenantId,
      definition,
      subject,
      {
        to,
        actorTenantUserId: access.tenantUserId,
        permissions: new Set(access.effective.permissions),
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
        throw problems.stepUp();
      case "separation_of_duties":
        throw new HttpProblem(403, "separation_of_duties", error.message);
      default:
        throw problems.invalid(error.message);
    }
  }
}
