import { type Transaction, workflowInstance, workflowTransition } from "@harbour/db";
import {
  checkWorkflowTransition,
  slaDueAt,
  type WorkflowDefinition,
  type WorkflowTransitionProblem,
} from "@harbour/domain";
import { and, eq, notInArray } from "drizzle-orm";
import { bankHolidays, rateNumber } from "./rates";

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
  /** For a workflow whose deadline is kept on the record: the record's deadline now. */
  recordDeadline: Date | null = null,
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
      slaDueAt: definition.deadlineOnRecord
        ? recordDeadline
        : await rateDue(tx, tenantId, definition, definition.initial, now),
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
      // A deadline kept on the record stays until the module changes it, and ends with the work.
      slaDueAt: definition.deadlineOnRecord
        ? definition.terminal.includes(move.to)
          ? null
          : instance.slaDueAt
        : await rateDue(tx, tenantId, definition, move.to, now),
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

/**
 * Takes a finished instance back to an unfinished state of its definition, with the reason kept on
 * the append-only transition (#120 review round 3, H1). Not a transition of the definition: the
 * module decides when a finished record may be reopened and checks the reason first. Refused when
 * the instance is not finished or the state is not one of the definition's unfinished states.
 */
export async function reopenWorkflow<S extends string>(
  tx: Transaction,
  definition: WorkflowDefinition<S>,
  subject: WorkflowSubject,
  to: S,
  reason: string,
  now = new Date(),
  /** For a workflow whose deadline is kept on the record: the record's deadline again. */
  recordDeadline: Date | null = null,
) {
  if (!definition.states.includes(to) || definition.terminal.includes(to)) {
    throw new WorkflowMoveRefused("no_such_transition", "That is not a state to reopen to.");
  }
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
  if (!instance || !definition.terminal.includes(instance.state as S)) {
    throw new WorkflowMoveRefused("no_such_transition", "This record is not finished.");
  }
  const [updated] = await tx
    .update(workflowInstance)
    .set({ state: to, enteredStateAt: now, slaDueAt: recordDeadline })
    .where(eq(workflowInstance.id, instance.id))
    .returning();
  await tx.insert(workflowTransition).values({
    instanceId: instance.id,
    personId: instance.personId,
    fromState: instance.state,
    toState: to,
    reason,
    stepUp: false,
    occurredAt: now,
  });
  return updated ?? instance;
}

/**
 * Writes the record's deadline onto its workflow instance, for a workflow whose deadline is kept
 * on the record (`deadlineOnRecord`): the module calls this whenever it starts or changes that
 * clock, in its own transaction, so the approvals list reads it without joining the module's
 * tables. A finished instance keeps no deadline.
 */
export async function setWorkflowDeadline<S extends string>(
  tx: Transaction,
  definition: WorkflowDefinition<S>,
  subject: WorkflowSubject,
  deadline: Date | null,
): Promise<void> {
  if (!definition.deadlineOnRecord) {
    throw new Error(`${definition.key} works out its own deadline; it is not kept on the record`);
  }
  await tx
    .update(workflowInstance)
    .set({ slaDueAt: deadline })
    .where(
      and(
        eq(workflowInstance.subjectType, subject.subjectType),
        eq(workflowInstance.subjectId, subject.subjectId),
        eq(workflowInstance.definitionKey, definition.key),
        notInArray(workflowInstance.state, [...definition.terminal]),
      ),
    );
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
  // England, like the rate lookup above, until workflows carry their location's nation (slice 7).
  const holidays =
    sla.unit === "working_days" ? await bankHolidays(tx, "england") : new Set<string>();
  return slaDueAt(definition, state, now, () => value, holidays);
}
