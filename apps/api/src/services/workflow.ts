import { type Transaction, workflowInstance, workflowTransition } from "@harbour/db";
import {
  checkWorkflowTransition,
  slaDueAt,
  type WorkflowDefinition,
  type WorkflowTransitionProblem,
} from "@harbour/domain";
import { and, eq } from "drizzle-orm";
import { rateNumber } from "./rates";

/**
 * Workflow service (section 9.1): starts a workflow for a subject and moves it, checking the rules
 * in packages/domain, recording every move in the append-only `workflow_transition` table and
 * setting the next service-level deadline. Modules call these inside their own transaction so the
 * record and its workflow change together.
 */

export class WorkflowMoveRefused extends Error {
  constructor(
    readonly problem: WorkflowTransitionProblem,
    message: string,
  ) {
    super(message);
    this.name = "WorkflowMoveRefused";
  }
}

export interface WorkflowSubject {
  readonly subjectType: string;
  readonly subjectId: string;
  readonly personId?: string | null;
}

export async function startWorkflow<S extends string>(
  tx: Transaction,
  tenantId: string,
  definition: WorkflowDefinition<S>,
  subject: WorkflowSubject,
  now = new Date(),
) {
  const [row] = await tx
    .insert(workflowInstance)
    .values({
      definitionKey: definition.key,
      definitionVersion: definition.version,
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
      personId: subject.personId ?? null,
      state: definition.initial,
      enteredStateAt: now,
      slaDueAt: await rateDue(tx, tenantId, definition, definition.initial, now),
    })
    .returning();
  if (!row) throw new Error("workflow instance was not created");
  return row;
}

export interface WorkflowMove<S extends string> {
  readonly to: S;
  readonly actorTenantUserId: string;
  readonly permissions: ReadonlySet<string>;
  readonly reason?: string | null;
  readonly stepUpFresh: boolean;
}

export async function moveWorkflow<S extends string>(
  tx: Transaction,
  tenantId: string,
  definition: WorkflowDefinition<S>,
  subject: WorkflowSubject,
  move: WorkflowMove<S>,
  now = new Date(),
) {
  const [instance] = await tx
    .select()
    .from(workflowInstance)
    .where(
      and(
        eq(workflowInstance.subjectType, subject.subjectType),
        eq(workflowInstance.subjectId, subject.subjectId),
        eq(workflowInstance.definitionKey, definition.key),
      ),
    )
    .for("update");
  if (!instance)
    throw new WorkflowMoveRefused("no_such_transition", "This record has no workflow.");
  const check = checkWorkflowTransition(
    definition,
    { state: instance.state as S, createdBy: instance.createdBy ?? "" },
    {
      to: move.to,
      actorId: move.actorTenantUserId,
      permissions: move.permissions,
      reason: move.reason ?? null,
      stepUpFresh: move.stepUpFresh,
    },
  );
  if (!check.ok) throw new WorkflowMoveRefused(check.problem, check.message);
  const [updated] = await tx
    .update(workflowInstance)
    .set({
      state: move.to,
      enteredStateAt: now,
      slaDueAt: await rateDue(tx, tenantId, definition, move.to, now),
    })
    .where(eq(workflowInstance.id, instance.id))
    .returning();
  await tx.insert(workflowTransition).values({
    instanceId: instance.id,
    personId: instance.personId,
    fromState: instance.state,
    toState: move.to,
    reason: move.reason ?? null,
    stepUp: move.stepUpFresh,
    occurredAt: now,
  });
  return updated ?? instance;
}

/** The SLA deadline for entering `state` now: fixed hours, or a rate-table figure by key. */
async function rateDue<S extends string>(
  tx: Transaction,
  tenantId: string,
  definition: WorkflowDefinition<S>,
  state: S,
  now: Date,
): Promise<Date | null> {
  const sla = definition.sla?.[state];
  if (!sla) return null;
  if ("hours" in sla) return slaDueAt(definition, state, now, () => 0);
  const value = await rateNumber(tx, tenantId, sla.rateKey);
  return slaDueAt(definition, state, now, () => value);
}
