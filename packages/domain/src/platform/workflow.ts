import { addUkDays } from "../shared/time";
import { type BankHolidays, workingDaysDeadline } from "../shared/working-days";
import { isPermission, type Permission, requiresStepUp } from "./permissions";

/**
 * Workflow engine rules (section 9.1): records such as incidents, complaints, recruitment files
 * and maintenance jobs move through named states. Each module declares its workflow in code;
 * these rules check a requested move (permission, reason, step-up, separation of duties) and work
 * out the service-level deadline of the state the record enters. Statutory deadlines come from the
 * rate table by key (resolved by the caller), never from literals.
 */

export interface WorkflowTransitionRule<S extends string> {
  readonly from: S | readonly S[];
  readonly to: S;
  readonly permission: Permission;
  readonly requiresReason?: boolean;
  /** Needs a sign-in within the step-up window; implied when the permission is a step-up one. */
  readonly requiresStepUp?: boolean;
  /** The actor must differ from the record's creator (for example closing an incident). */
  readonly distinctFromCreator?: boolean;
}

export type WorkflowSla =
  | { readonly hours: number }
  | { readonly rateKey: string; readonly unit: "hours" | "days" | "working_days" };

export interface WorkflowDefinition<S extends string> {
  readonly key: string;
  readonly version: number;
  readonly states: readonly S[];
  readonly initial: S;
  readonly terminal: readonly S[];
  readonly transitions: readonly WorkflowTransitionRule<S>[];
  readonly sla?: Partial<Record<S, WorkflowSla>>;
}

export class WorkflowDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowDefinitionError";
  }
}

const asList = <S extends string>(from: S | readonly S[]): readonly S[] =>
  typeof from === "string" ? [from] : from;

/** Checks a workflow declaration when the module loads, so a broken workflow never ships. */
export function defineWorkflow<S extends string>(
  definition: WorkflowDefinition<S>,
): WorkflowDefinition<S> {
  const states = new Set<string>(definition.states);
  if (states.size !== definition.states.length) {
    throw new WorkflowDefinitionError(`${definition.key}: states must be unique.`);
  }
  if (!states.has(definition.initial)) {
    throw new WorkflowDefinitionError(`${definition.key}: the initial state is not a state.`);
  }
  for (const t of definition.terminal) {
    if (!states.has(t))
      throw new WorkflowDefinitionError(`${definition.key}: terminal state ${t} is not a state.`);
  }
  for (const rule of definition.transitions) {
    for (const from of asList(rule.from)) {
      if (!states.has(from))
        throw new WorkflowDefinitionError(`${definition.key}: unknown state ${from}.`);
      if (definition.terminal.includes(from)) {
        throw new WorkflowDefinitionError(
          `${definition.key}: terminal state ${from} cannot have transitions.`,
        );
      }
    }
    if (!states.has(rule.to))
      throw new WorkflowDefinitionError(`${definition.key}: unknown state ${rule.to}.`);
    if (!isPermission(rule.permission)) {
      throw new WorkflowDefinitionError(
        `${definition.key}: unknown permission ${rule.permission}.`,
      );
    }
  }
  for (const [state, sla] of Object.entries(definition.sla ?? {}) as [S, WorkflowSla][]) {
    if (!states.has(state))
      throw new WorkflowDefinitionError(`${definition.key}: SLA for unknown state ${state}.`);
    if ("hours" in sla && !(sla.hours > 0)) {
      throw new WorkflowDefinitionError(`${definition.key}: SLA hours must be positive.`);
    }
  }
  return definition;
}

export type WorkflowTransitionProblem =
  | "terminal"
  | "no_such_transition"
  | "missing_permission"
  | "reason_required"
  | "step_up_required"
  | "separation_of_duties";

export interface WorkflowTransitionRequest<S extends string> {
  readonly to: S;
  readonly actorId: string;
  readonly permissions: ReadonlySet<string>;
  readonly reason?: string | null;
  /** True when the actor signed in within the step-up window. */
  readonly stepUpFresh: boolean;
}

export interface WorkflowInstanceView<S extends string> {
  readonly state: S;
  readonly createdBy: string;
}

export type WorkflowTransitionCheck<S extends string> =
  | { readonly ok: true; readonly rule: WorkflowTransitionRule<S> }
  | { readonly ok: false; readonly problem: WorkflowTransitionProblem; readonly message: string };

const MESSAGES: Record<WorkflowTransitionProblem, string> = {
  terminal: "This record is closed and cannot move on.",
  no_such_transition: "That step is not possible from the record's current state.",
  missing_permission: "Your role does not allow this step.",
  reason_required: "Give a reason for this step.",
  step_up_required: "Sign in again to confirm it is you, then try again.",
  separation_of_duties:
    "Someone other than the person who created this record must take this step.",
};

/** Shortest reason accepted where a step needs one. */
export const MIN_WORKFLOW_REASON_LENGTH = 3;

export function checkWorkflowTransition<S extends string>(
  definition: WorkflowDefinition<S>,
  instance: WorkflowInstanceView<S>,
  request: WorkflowTransitionRequest<S>,
): WorkflowTransitionCheck<S> {
  const fail = (problem: WorkflowTransitionProblem): WorkflowTransitionCheck<S> => ({
    ok: false,
    problem,
    message: MESSAGES[problem],
  });
  if (definition.terminal.includes(instance.state)) return fail("terminal");
  const rule = definition.transitions.find(
    (t) => t.to === request.to && asList(t.from).includes(instance.state),
  );
  if (!rule) return fail("no_such_transition");
  if (!request.permissions.has(rule.permission)) return fail("missing_permission");
  if (rule.distinctFromCreator && request.actorId === instance.createdBy) {
    return fail("separation_of_duties");
  }
  if (rule.requiresReason && (request.reason?.trim().length ?? 0) < MIN_WORKFLOW_REASON_LENGTH) {
    return fail("reason_required");
  }
  if ((rule.requiresStepUp || requiresStepUp(rule.permission)) && !request.stepUpFresh) {
    return fail("step_up_required");
  }
  return { ok: true, rule };
}

/** The moves open to an actor from the record's current state (for buttons and API hints). */
export function availableTransitions<S extends string>(
  definition: WorkflowDefinition<S>,
  instance: WorkflowInstanceView<S>,
  actorId: string,
  permissions: ReadonlySet<string>,
): S[] {
  if (definition.terminal.includes(instance.state)) return [];
  return definition.transitions
    .filter((t) => asList(t.from).includes(instance.state))
    .filter((t) => permissions.has(t.permission))
    .filter((t) => !(t.distinctFromCreator && actorId === instance.createdBy))
    .map((t) => t.to);
}

/**
 * When the state entered at `enteredAt` is due to be left, or null when the state has no SLA.
 * `resolveRate` returns the current value of a rate-table key (in the unit the SLA names);
 * working days skip the bank holidays given (docs/specs/calendar.md).
 */
export function slaDueAt<S extends string>(
  definition: WorkflowDefinition<S>,
  state: S,
  enteredAt: Date,
  resolveRate: (key: string) => number,
  holidays: BankHolidays = new Set(),
): Date | null {
  const sla = definition.sla?.[state];
  if (!sla) return null;
  if ("hours" in sla) return new Date(enteredAt.getTime() + sla.hours * 3_600_000);
  const value = resolveRate(sla.rateKey);
  if (!(value > 0))
    throw new WorkflowDefinitionError(`${definition.key}: rate ${sla.rateKey} must be positive.`);
  if (sla.unit === "hours") return new Date(enteredAt.getTime() + value * 3_600_000);
  if (sla.unit === "working_days") return workingDaysDeadline(enteredAt, value, holidays);
  return addUkDays(enteredAt, value);
}
