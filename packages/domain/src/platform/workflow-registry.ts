import { DOLS_LEGAL_CHANGE_REVIEW_WORKFLOW } from "../care/mca/dols";
import { OUTAGE_WORKFLOW } from "../operations/outage";
import { EXIT_WORKFLOWS } from "../people/exit";
import { CANDOUR_WORKFLOW } from "../safety/candour";
import { INCIDENT_WORKFLOW } from "../safety/incident";
import { STATUTORY_NOTIFICATION_WORKFLOW } from "../safety/notifications";
import { type Permission, requiresStepUp } from "./permissions";
import { type WorkflowDefinition, workflowPermissions } from "./workflow";

/**
 * The workflows the approvals screen lists (PLAT-011): those whose records are work waiting for
 * someone, each started and moved by its own module. The person lifecycle is a record's status,
 * not work, so it is not listed. A workflow added here shows on the screen once the web gives its
 * name and states words (`approvals.workflow`, `approvals.state`).
 */
// biome-ignore lint/suspicious/noExplicitAny: why: one list holds workflows whose state unions differ.
export type ListedWorkflow = WorkflowDefinition<any>;

export const LISTED_WORKFLOWS: readonly ListedWorkflow[] = [
  INCIDENT_WORKFLOW,
  CANDOUR_WORKFLOW,
  STATUTORY_NOTIFICATION_WORKFLOW,
  DOLS_LEGAL_CHANGE_REVIEW_WORKFLOW,
  OUTAGE_WORKFLOW,
  ...Object.values(EXIT_WORKFLOWS),
];

const BY_KEY = new Map(LISTED_WORKFLOWS.map((w) => [w.key, w]));

/** The listed workflow with this key, or undefined. */
export function listedWorkflow(key: string): ListedWorkflow | undefined {
  return BY_KEY.get(key);
}

/**
 * Every permission some listed step needs: holding one gives a part in the list. Step-up
 * permissions last, so a check that takes the first one held judges a session on one it can use.
 */
export const LISTED_WORKFLOW_PERMISSIONS: readonly Permission[] = [
  ...new Set(LISTED_WORKFLOWS.flatMap((w) => [...workflowPermissions(w)])),
].sort((a, b) => Number(requiresStepUp(a)) - Number(requiresStepUp(b)));
