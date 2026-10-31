/**
 * Round tasks an entry saved on this device has answered (#123 clinical review, M1 and its
 * re-check; HZ-029, HZ-003). An entry carries the task it answers in a device-only column
 * (`task_id`) that its synced copy does not have, so once it uploads the device can no longer tell
 * from its entries that the task was answered. The answer is therefore kept in the encrypted
 * database's bookkeeping (`sync_meta`), keyed by the member and the task, written in the same
 * transaction as the entry. It survives a restart, and holding or ending the session clears it
 * with the rest of the bookkeeping (`holdUnsentWork`, the wipe).
 *
 * Its state is worked out in SQL, so the round, the record and the route all read the same:
 * `answered` while the entry waits to upload or once Harbour has it; `refused` once Harbour refused
 * that entry (it is in "needs attention", `upload_issue`, under the entry's id), when the task may
 * be answered again; no row, `none`.
 */

/** `sync_meta` id of an answer: the member and the task. */
export const ANSWERED_META_PREFIX = "answered:";
export const ANSWERED_META_KEY = "answered_task";

export function answeredMetaId(tenantUserId: string, taskId: string): string {
  return `${ANSWERED_META_PREFIX}${tenantUserId}:${taskId}`;
}

export type AnsweredState = "none" | "answered" | "refused";

/**
 * SQL for a task's answer state, for the task in `taskExpr` and the member bound at `?` (one
 * parameter, the member's tenant_user id).
 */
export function answeredStateSql(taskExpr: string): string {
  return `coalesce((SELECT CASE WHEN EXISTS (
      SELECT 1 FROM upload_issue i WHERE i.id = json_extract(m.value, '$.entryId'))
    THEN 'refused' ELSE 'answered' END
    FROM sync_meta m WHERE m.id = '${ANSWERED_META_PREFIX}' || ? || ':' || ${taskExpr}), 'none')`;
}

/** The statements that keep an answer, replacing any earlier one (a re-recording after refusal). */
export function rememberAnsweredStatements(input: {
  readonly tenantUserId: string;
  readonly taskId: string;
  readonly entryTable: string;
  readonly entryId: string;
  readonly at: Date;
}): { readonly sql: string; readonly params: string[] }[] {
  const id = answeredMetaId(input.tenantUserId, input.taskId);
  return [
    { sql: "DELETE FROM sync_meta WHERE id = ?", params: [id] },
    {
      sql: "INSERT INTO sync_meta (id, key, value) VALUES (?, ?, ?)",
      params: [
        id,
        ANSWERED_META_KEY,
        JSON.stringify({
          taskId: input.taskId,
          entryTable: input.entryTable,
          entryId: input.entryId,
          at: input.at.toISOString(),
        }),
      ],
    },
  ];
}
