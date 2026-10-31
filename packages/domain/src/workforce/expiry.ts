import { addDays, daysBetween } from "./dates";

/**
 * Expiring documents (workforce.md rule 1): a document is valid through its expiry date, expired
 * from the day after, and raises a reminder on each of the reminder offsets before it
 * (`document_expiry.reminder_days.*`), once each. A reminder missed (the system was down, the
 * document was added late) is raised on the next evaluation, but only the nearest one: nobody gets
 * a 90-day reminder seven days before expiry.
 */

export type ExpiryStatus = "valid" | "due_soon" | "expired";

export interface ExpiryState {
  readonly status: ExpiryStatus;
  /** Days from today to the expiry date (negative once expired). */
  readonly daysLeft: number;
  /** The reminder offset (in days) to raise today, or null. */
  readonly reminderDue: number | null;
}

export function expiryState(
  expiresOn: string,
  today: string,
  offsets: readonly number[],
  remindersSent: readonly number[] = [],
): ExpiryState {
  const daysLeft = daysBetween(today, expiresOn);
  if (daysLeft < 0) return { status: "expired", daysLeft, reminderDue: null };
  const largest = Math.max(...offsets);
  // The nearest offset whose day has come: the smallest offset not below the days left.
  const reached = [...offsets].sort((a, b) => a - b).find((offset) => daysLeft <= offset);
  const reminderDue = reached !== undefined && !remindersSent.includes(reached) ? reached : null;
  return {
    status: daysLeft <= largest ? "due_soon" : "valid",
    daysLeft,
    reminderDue,
  };
}

/** The day each reminder falls on, for scheduling tasks ahead. */
export function reminderDates(expiresOn: string, offsets: readonly number[]): readonly string[] {
  return [...offsets].sort((a, b) => b - a).map((offset) => addDays(expiresOn, -offset));
}
