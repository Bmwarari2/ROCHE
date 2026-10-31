/**
 * Round tasks an entry saved on this device has already answered (#123 clinical review, M1;
 * HZ-029). An entry carries the task it answers in a device-only column (`task_id`), which the
 * synced copy of the entry does not have: once it uploads, the device can no longer tell from its
 * entries that the task was answered, and while the task is still open (the API kept the entry for
 * review, or the task's own update has not synced yet) the record would tag the next entry with
 * the same task. This keeps the answer for as long as the app runs, so a task is answered by one
 * entry at most from this device; the task leaving the device ends it for good.
 */
const answered = new Set<string>();

/** Notes that an entry saved here answers this task. */
export function rememberAnswered(taskId: string): void {
  answered.add(taskId);
}

/** Whether an entry saved here has already answered this task. */
export function isAnswered(taskId: string): boolean {
  return answered.has(taskId);
}

/** Forgets every answer (sign-out, and tests). */
export function forgetAnswered(): void {
  answered.clear();
}
