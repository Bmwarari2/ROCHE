import {
  type EmailMessage,
  outboundTitleProblem,
  type PortName,
  type PushMessage,
  type SmsMessage,
} from "../integrations/ports";
import { inQuietHours, type QuietHours } from "../platform/notifications";
import { addUkDays, fromUkWallClock, toUkWallClock } from "../shared/time";
import {
  type ChannelUnusableReason,
  checkFamilyChannelAddress,
  FAMILY_CHANNEL_PORTS,
  type FamilyChannelKind,
  type FamilyChannelState,
  familyChannelUsability,
} from "./channels";
import { findClinicalTerms, findNameMentions } from "./feed-text";

/**
 * Family update notifications (INTG-011 domain side; comms.md section 4 rules 13 and 15; hazard
 * HZ-060). A notification only says that there is something new and links to the portal, where
 * sign-in, MFA and the sharing rules apply. Its words are an approved template, the same whatever
 * the update says: the planner is given the ids of the new updates, never their content, so
 * nothing about the person's health can reach an email, an SMS or a lock screen. Family members
 * choose their channels (opt-in), quiet hours always apply (family updates are never urgent), and
 * one waiting notification covers every update that arrives before it goes.
 */

// ------------------------------------------------------------------------------------------------
// Templates (approval itself is the templates and letters work, COMMS-007)
// ------------------------------------------------------------------------------------------------

/**
 * An approved notification template, as this module reads it. The words are the whole message: a
 * generic line with no placeholders. The link travels separately in the port's `link` field.
 */
export interface FamilyNotificationTemplate {
  readonly key: string;
  readonly version: number;
  readonly channel: FamilyChannelKind;
  readonly text: string;
  readonly approvedAt: Date | null;
  readonly approvedBy: string | null;
  readonly withdrawnAt: Date | null;
}

export type FamilyTemplateProblem =
  | { readonly problem: "not_approved"; readonly message: string }
  | { readonly problem: "withdrawn"; readonly message: string }
  | { readonly problem: "has_placeholder"; readonly message: string }
  | { readonly problem: "not_generic"; readonly message: string }
  | {
      readonly problem: "clinical_term";
      readonly found: readonly string[];
      readonly message: string;
    }
  | { readonly problem: "names_the_person"; readonly message: string };

/**
 * Checks a template before any message is built from it. Approval is required; the text may hold
 * no placeholder, nothing the outbound guard refuses (NHS numbers, dates, email addresses, phone
 * numbers, more than a short line), no clinical word and none of the person's names.
 */
export function checkFamilyNotificationTemplate(
  template: FamilyNotificationTemplate,
  context: { readonly personNames: readonly string[]; readonly now: Date },
): FamilyTemplateProblem[] {
  const problems: FamilyTemplateProblem[] = [];
  if (
    template.approvedAt === null ||
    !template.approvedBy ||
    template.approvedAt.getTime() > context.now.getTime()
  ) {
    problems.push({ problem: "not_approved", message: "Only approved templates are sent." });
  }
  if (template.withdrawnAt !== null && template.withdrawnAt.getTime() <= context.now.getTime()) {
    problems.push({ problem: "withdrawn", message: "This template has been withdrawn." });
  }
  if (template.text.includes("{") || template.text.includes("}")) {
    problems.push({
      problem: "has_placeholder",
      message: "Notification templates take no merge fields: the words are the same for everyone.",
    });
  }
  const outbound = outboundTitleProblem(template.text);
  if (outbound !== null) problems.push({ problem: "not_generic", message: outbound });
  const terms = findClinicalTerms(template.text);
  if (terms.length > 0) {
    problems.push({
      problem: "clinical_term",
      found: terms.map((t) => t.found),
      message: "Notifications never carry health details.",
    });
  }
  const lower = template.text.toLowerCase();
  const named = context.personNames.some(
    (name) =>
      name.trim().length > 0 && findNameMentions(lower, name.trim().toLowerCase()).length > 0,
  );
  if (named) {
    problems.push({
      problem: "names_the_person",
      message: "Notifications never name the person. Say only that there is an update.",
    });
  }
  return problems;
}

/** The latest approved, unwithdrawn template for a channel, or null. */
export function currentFamilyTemplate(
  templates: readonly FamilyNotificationTemplate[],
  channel: FamilyChannelKind,
  now: Date,
): FamilyNotificationTemplate | null {
  return (
    templates
      .filter(
        (t) =>
          t.channel === channel &&
          t.approvedAt !== null &&
          t.approvedAt.getTime() <= now.getTime() &&
          (t.withdrawnAt === null || t.withdrawnAt.getTime() > now.getTime()),
      )
      .sort((a, b) => b.version - a.version)[0] ?? null
  );
}

// ------------------------------------------------------------------------------------------------
// The link
// ------------------------------------------------------------------------------------------------

/** Where every family notification points: the updates page, with no id or name in the link. */
export const FAMILY_UPDATES_PATH = "/family/updates";

function isHostCharacter(ch: string): boolean {
  return (
    (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "." || ch === "-" || ch === ":"
  );
}

/**
 * The link a notification carries: the tenant's portal origin (https only, no path, query or
 * fragment) plus the updates page. Returns null for anything else, so a misconfigured portal
 * address fails loudly instead of sending a link that could carry data.
 */
export function familyUpdatesLink(portalBaseUrl: string): string | null {
  const prefix = "https://";
  const value = portalBaseUrl.trim().toLowerCase();
  if (!value.startsWith(prefix)) return null;
  let host = value.slice(prefix.length);
  if (host.endsWith("/")) host = host.slice(0, -1);
  if (host.length === 0 || host.startsWith(".") || host.startsWith("-")) return null;
  for (const ch of host) if (!isHostCharacter(ch)) return null;
  if (!host.includes(".")) return null;
  return `${prefix}${host}${FAMILY_UPDATES_PATH}`;
}

// ------------------------------------------------------------------------------------------------
// Quiet hours (UK local time; never bypassed for family updates)
// ------------------------------------------------------------------------------------------------

function hhMmToMinute(value: string): number | null {
  if (value.length !== 5 || value[2] !== ":") return null;
  const hours = Number(value.slice(0, 2));
  const minutes = Number(value.slice(3));
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Whether a quiet-hours window is well formed ("HH:MM" to "HH:MM", UK local time). */
export function isValidQuietHours(window: QuietHours): boolean {
  return hhMmToMinute(window.start) !== null && hhMmToMinute(window.end) !== null;
}

function ukMinuteOfDay(at: Date): number {
  const w = toUkWallClock(at);
  return w.hour * 60 + w.minute;
}

/** The next instant strictly after `after` when the UK clock reads `minute`. */
function nextUkClockTime(after: Date, minute: number): Date {
  const w = toUkWallClock(after);
  const today = fromUkWallClock(w.year, w.month, w.day, Math.floor(minute / 60), minute % 60);
  return today.getTime() > after.getTime() ? today : addUkDays(today, 1);
}

/**
 * When a notification found inside quiet hours may go: the first moment no window holds, or null
 * when none holds now. Windows are the tenant's and, if set, the family member's own; both apply.
 * Computed on the UK clock, so 08:00 is 08:00 on either side of a clock change. If the windows
 * together cover the whole day, the first window (the tenant's) decides.
 */
export function quietHoursRelease(windows: readonly QuietHours[], now: Date): Date | null {
  for (const window of windows) {
    if (!isValidQuietHours(window)) throw new RangeError("Quiet hours must be HH:MM to HH:MM.");
  }
  let at = now;
  // Each step leaves one window; windows can hand over to each other at most once each.
  for (let step = 0; step <= windows.length; step++) {
    const holding = windows.find((w) => inQuietHours(w, ukMinuteOfDay(at)));
    if (!holding) return step === 0 ? null : at;
    at = nextUkClockTime(at, hhMmToMinute(holding.end) as number);
  }
  const first = windows[0] as QuietHours;
  return nextUkClockTime(now, hhMmToMinute(first.end) as number);
}

// ------------------------------------------------------------------------------------------------
// The plan
// ------------------------------------------------------------------------------------------------

export interface FamilyNotificationRequest {
  /** Opaque id of this notification; delivery ids derive from it, so a retry never sends twice. */
  readonly notificationId: string;
  /** Ids of the new updates this family member may see (checked with `checkFeedItemVisibility`). */
  readonly newItemIds: readonly string[];
  /** A notification to this family member is already waiting (quiet hours or the queue). */
  readonly alreadyPending: boolean;
  readonly channels: readonly FamilyChannelState[];
  readonly templates: readonly FamilyNotificationTemplate[];
  /** The person's names, which a template must never contain. */
  readonly personNames: readonly string[];
  readonly portalBaseUrl: string;
  /** From `familyQuietHours` (rate table default or the tenant's own). */
  readonly tenantQuietHours: QuietHours;
  /** The family member's own window, if they set one. */
  readonly ownQuietHours: QuietHours | null;
  readonly now: Date;
}

export type SkippedChannelReason =
  | ChannelUnusableReason
  | "address_not_valid"
  | "no_approved_template"
  | "template_not_allowed";

export interface SkippedFamilyChannel {
  readonly channelId: string;
  readonly channel: FamilyChannelKind;
  readonly reason: SkippedChannelReason;
  readonly problems: readonly FamilyTemplateProblem[];
}

export interface PlannedFamilyDelivery {
  readonly channel: FamilyChannelKind;
  readonly port: PortName;
  /** The family member's channel records the delivery goes to. */
  readonly channelIds: readonly string[];
  readonly templateKey: string;
  readonly templateVersion: number;
  readonly message: EmailMessage | SmsMessage | PushMessage;
}

export type FamilyNotificationPlan =
  | {
      readonly action: "none";
      readonly reason:
        | "no_new_updates"
        | "already_pending"
        | "no_channel"
        | "portal_link_not_valid";
      readonly skipped: readonly SkippedFamilyChannel[];
    }
  | {
      readonly action: "send";
      /** Now, or when quiet hours end. */
      readonly deliverAt: Date;
      readonly heldForQuietHours: boolean;
      readonly deliveries: readonly PlannedFamilyDelivery[];
      readonly skipped: readonly SkippedFamilyChannel[];
    };

/**
 * Plans the notification for one family member about new updates they can see: which channels,
 * which words, which link and when. Content-free by construction (HZ-060).
 */
export function planFamilyNotification(request: FamilyNotificationRequest): FamilyNotificationPlan {
  if (request.newItemIds.length === 0)
    return { action: "none", reason: "no_new_updates", skipped: [] };
  if (request.alreadyPending) return { action: "none", reason: "already_pending", skipped: [] };
  const link = familyUpdatesLink(request.portalBaseUrl);
  if (link === null) return { action: "none", reason: "portal_link_not_valid", skipped: [] };

  const skipped: SkippedFamilyChannel[] = [];
  const skip = (
    state: FamilyChannelState,
    reason: SkippedChannelReason,
    problems: FamilyTemplateProblem[] = [],
  ) => skipped.push({ channelId: state.id, channel: state.kind, reason, problems });

  const ready: { state: FamilyChannelState; template: FamilyNotificationTemplate }[] = [];
  for (const state of request.channels) {
    const usability = familyChannelUsability(state);
    if (!usability.usable) {
      skip(state, usability.reason);
      continue;
    }
    if (!checkFamilyChannelAddress(state.kind, state.address)) {
      skip(state, "address_not_valid");
      continue;
    }
    const template = currentFamilyTemplate(request.templates, state.kind, request.now);
    if (template === null) {
      skip(state, "no_approved_template");
      continue;
    }
    const problems = checkFamilyNotificationTemplate(template, request);
    if (problems.length > 0) {
      skip(state, "template_not_allowed", problems);
      continue;
    }
    ready.push({ state, template });
  }
  if (ready.length === 0) return { action: "none", reason: "no_channel", skipped };

  const deliveries: PlannedFamilyDelivery[] = [];
  for (const { state, template } of ready) {
    if (state.kind === "push") continue;
    deliveries.push({
      channel: state.kind,
      port: FAMILY_CHANNEL_PORTS[state.kind],
      channelIds: [state.id],
      templateKey: template.key,
      templateVersion: template.version,
      message: {
        idempotencyKey: `${request.notificationId}:${state.id}`,
        title: template.text,
        link,
        to: state.address,
      },
    });
  }
  const push = ready.filter((r) => r.state.kind === "push");
  const pushTemplate = push[0]?.template;
  if (pushTemplate) {
    deliveries.push({
      channel: "push",
      port: FAMILY_CHANNEL_PORTS.push,
      channelIds: push.map((p) => p.state.id),
      templateKey: pushTemplate.key,
      templateVersion: pushTemplate.version,
      message: {
        idempotencyKey: `${request.notificationId}:push`,
        title: pushTemplate.text,
        link,
        to: push.map((p) => p.state.address),
      },
    });
  }

  const windows = [
    request.tenantQuietHours,
    ...(request.ownQuietHours ? [request.ownQuietHours] : []),
  ];
  const release = quietHoursRelease(windows, request.now);
  return {
    action: "send",
    deliverAt: release ?? request.now,
    heldForQuietHours: release !== null,
    deliveries,
    skipped,
  };
}
