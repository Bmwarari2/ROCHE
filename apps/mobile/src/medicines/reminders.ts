/**
 * Local reminders for time-critical doses (Phase 2 slice 69; HZ-003): one at the moment each
 * time-critical dose's window opens, for the doses on this phone not yet recorded, over the next
 * hours. A reminder is a prompt, never the record: the round is what says what is due. The words
 * carry no name, medicine or count, because a notification shows on the lock screen. Nothing goes
 * to a push service. Pure planning here; `platform/notifications.ts` schedules the plan.
 */
import type { PersonRound } from "./round";

export const MEDS_REMINDER_PREFIX = "meds-time-critical:";
/** iOS keeps 64 scheduled notifications for an app; the held-entry ones need room too. */
export const MEDS_REMINDER_LIMIT = 20;

export interface PlannedReminder {
  readonly identifier: string;
  readonly at: Date;
}

/** The reminders to hold: each unrecorded time-critical dose whose window opens from now on. */
export function planTimeCriticalReminders(
  rounds: readonly PersonRound[],
  now: Date,
): PlannedReminder[] {
  const seen = new Set<string>();
  const plan: PlannedReminder[] = [];
  for (const r of rounds) {
    for (const d of r.doses) {
      if (!d.timeCritical || d.state === "recorded" || !d.entryStatus.mayGive) continue;
      const at = new Date(d.opensAt);
      if (at.getTime() <= now.getTime()) continue;
      // One reminder a moment: two people's doses at 08:00 need one prompt to open the round.
      const key = at.toISOString();
      if (seen.has(key)) continue;
      seen.add(key);
      plan.push({ identifier: `${MEDS_REMINDER_PREFIX}${key}`, at });
    }
  }
  return plan.sort((a, b) => a.at.getTime() - b.at.getTime()).slice(0, MEDS_REMINDER_LIMIT);
}
