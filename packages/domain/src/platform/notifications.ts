/**
 * Notification centre rules (section 9.1): escalation chains and quiet hours. Example: an
 * unacknowledged missed-visit alarm escalates to on-call after 10 minutes. Urgent safety
 * notifications ignore quiet hours. Push, email and SMS bodies never carry personal data.
 */

export type Channel = "in_app" | "push" | "email" | "sms";
export type Severity = "info" | "warning" | "urgent";

export interface EscalationStep {
  /** Minutes after the notification was raised (cumulative, not since the previous step). */
  readonly afterMinutes: number;
  readonly targetRoleKey?: string;
  readonly targetTenantUserId?: string;
  readonly channels: readonly Channel[];
}

export interface EscalationState {
  readonly createdAt: Date;
  /** Steps already fired; 0 means only the original recipient has been told. */
  readonly stepsFired: number;
  readonly acknowledgedAt: Date | null;
}

export function validateChain(steps: readonly EscalationStep[]): string[] {
  const problems: string[] = [];
  steps.forEach((step, i) => {
    if (!step.targetRoleKey && !step.targetTenantUserId)
      problems.push(`Step ${i + 1} has no target.`);
    if (step.channels.length === 0) problems.push(`Step ${i + 1} has no channel.`);
    const previous = steps[i - 1];
    if (previous && step.afterMinutes <= previous.afterMinutes) {
      problems.push(`Step ${i + 1} must come after step ${i}.`);
    }
    if (step.afterMinutes <= 0) problems.push(`Step ${i + 1} must wait at least a minute.`);
  });
  return problems;
}

/** When the next escalation step is due, or null when acknowledged or the chain is exhausted. */
export function nextEscalationAt(
  steps: readonly EscalationStep[],
  state: EscalationState,
): Date | null {
  if (state.acknowledgedAt) return null;
  const next = steps[state.stepsFired];
  if (!next) return null;
  return new Date(state.createdAt.getTime() + next.afterMinutes * 60_000);
}

/** Steps that should fire now (more than one if the scheduler was delayed). */
export function dueEscalationSteps(
  steps: readonly EscalationStep[],
  state: EscalationState,
  now: Date,
): { readonly index: number; readonly step: EscalationStep }[] {
  if (state.acknowledgedAt) return [];
  const due: { index: number; step: EscalationStep }[] = [];
  for (let i = state.stepsFired; i < steps.length; i++) {
    const step = steps[i];
    if (!step) break;
    if (state.createdAt.getTime() + step.afterMinutes * 60_000 <= now.getTime())
      due.push({ index: i, step });
    else break;
  }
  return due;
}

export interface QuietHours {
  /** "HH:MM" in UK local time; a window may cross midnight. */
  readonly start: string;
  readonly end: string;
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function inQuietHours(quiet: QuietHours | null, localMinutesOfDay: number): boolean {
  if (!quiet) return false;
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  if (start === end) return false;
  return start < end
    ? localMinutesOfDay >= start && localMinutesOfDay < end
    : localMinutesOfDay >= start || localMinutesOfDay < end;
}

/** In-app always; other channels are held during quiet hours unless the notification is urgent. */
export function channelsToSend(
  requested: readonly Channel[],
  severity: Severity,
  quiet: QuietHours | null,
  localMinutesOfDay: number,
): Channel[] {
  const channels = new Set<Channel>(["in_app", ...requested]);
  if (severity !== "urgent" && inQuietHours(quiet, localMinutesOfDay)) {
    return ["in_app"];
  }
  return [...channels];
}
