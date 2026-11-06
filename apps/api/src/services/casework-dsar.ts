import { type Transaction, task } from "@harbour/db";
import { ukEndOfDay } from "@harbour/domain";
import { sql } from "drizzle-orm";
import { withSystemRights } from "./system-rights";

/** H-805: a case manager collects an employee relations case for a subject access request. */
export const CASEWORK_DSAR_TASK = "workforce.casework_dsar_collection";

/**
 * H-805, for the DSAR workbench: casework is never searched by the workbench (a restricted silo,
 * ADR-0089), so for a staff subject access request each case about or naming the requester raises
 * a task for its case manager to collect it, by the request's due date; the data protection lead
 * keeps the clock. Run in the caller's transaction, by the system or a holder of
 * `quality.dsar.manage` (`app.casework_for_subject_access` checks). The tasks carry the case's id
 * and the request's reference only, and a generic title. Returns how many tasks it raised and how
 * many cases have no case manager still employed, for the workbench to take to support (H-804).
 *
 * The workbench (on main) calls this when a staff request is opened; until the two are merged
 * the call is the contract, proved by the tests.
 */
export async function raiseCaseworkDsarTasks(
  tx: Transaction,
  input: { readonly requesterId: string; readonly dsarReference: string; readonly dueOn: string },
): Promise<{ readonly tasks: number; readonly withoutManager: number }> {
  const found = await tx.execute<{ case_id: string; case_manager_id: string | null }>(
    sql`SELECT case_id, case_manager_id FROM app.casework_for_subject_access(${input.requesterId}::uuid)`,
  );
  const managed = found.rows.filter((r) => r.case_manager_id !== null);
  const orphaned = new Set(
    found.rows.filter((r) => r.case_manager_id === null).map((r) => r.case_id),
  );
  // Written as the system: the task is for someone else, about no person and no location.
  await withSystemRights(tx, async () => {
    for (const row of managed) {
      await tx.insert(task).values({
        kind: CASEWORK_DSAR_TASK,
        title: "Collect an employee relations case for a subject access request",
        // Every staff role holds it, and it never widens who sees a task (migration 0079), so
        // only the case manager it is assigned to sees it: no other caseworker learns of the case.
        requiredPermission: "workforce.self.read",
        sourceType: "employee_case",
        sourceId: row.case_id,
        locationId: null,
        assigneeTenantUserId: row.case_manager_id,
        dueAt: ukEndOfDay(input.dueOn),
        priority: "urgent",
        details: { caseId: row.case_id, dsarReference: input.dsarReference },
      });
    }
  });
  return { tasks: managed.length, withoutManager: orphaned.size };
}
