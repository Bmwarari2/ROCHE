/**
 * The round on the phone (care.md rule 8 and section 6; CARE-013): what each open task on this
 * device says and what the carer may do with it, worked out from the synced rows so the screen only
 * draws. Pure apart from the translator, so every rule of the screens gate is unit-tested:
 *
 * - (b) a round from an earlier plan says so (`task.from_earlier_plan`; HZ-024);
 * - (d) the list never reads as "nothing due": the header says what the phone holds, from when,
 *   when it last synced, and that it may be incomplete, and an empty list says the same (HZ-028);
 * - (f) a task whose evidence entry is saved here says "evidence recorded, waiting to upload", and
 *   offers nothing, so it is not recorded twice (HZ-029);
 * - a move made here and waiting to upload says so, and a task put back by a session's end as a bare
 *   row (no title, due time or version; `held-work.ts`) is named from the move itself;
 * - status is always an icon and a word, never colour alone.
 */
import { knownAsName } from "@harbour/ui-native/logic";
import { type MessageKey, t } from "../i18n/t";
import { parseCommunicationNeeds } from "../people/person-view";
import { offlineWindowBounds } from "../sync/offline-days";
import type { AnsweredState } from "./answered-tasks";
import type { FieldError } from "./entries";
import { parseQueuedMove, type TaskToMove } from "./round-actions";
import { parseInstant, ukDateTimeParts } from "./time";

/** A synced open task with its person's names and whether evidence for it waits to upload. */
export interface RoundTaskRow extends TaskToMove {
  readonly window_start: string | null;
  readonly window_end: string | null;
  readonly priority: string | null;
  readonly from_earlier_plan: number | null;
  readonly preferred_name: string | null;
  readonly given_name: string | null;
  readonly family_name: string | null;
  /** The person's communication needs (JSON), for the Accessible Information Standard flag. */
  readonly communication_needs: string | null;
  /** The person's home, for the write scope (null when the person row is not on the device). */
  readonly person_location_id: string | null;
  /** The task's series, when a schedule (a plan's round) made it. */
  readonly series_id?: string | null;
  /** Entries saved on this device that answer the task and have not uploaded yet. */
  readonly evidence_waiting: number | null;
  /** Entries for the task Harbour refused, kept in "needs attention" (HZ-006). */
  readonly evidence_refused?: number | null;
  /** How many times the overdue task has been escalated (0 or null when never). */
  readonly escalation_level?: number | null;
  /**
   * Whether an entry saved here by this member answers the task (`answered-tasks.ts`): `answered`
   * while it waits or once Harbour has it, `refused` once Harbour refused it.
   */
  readonly answered_state?: AnsweredState | null;
}

export type RoundTiming = "overdue" | "due" | "later";

export type RoundChip =
  | { readonly kind: "status"; readonly status: "overdue" | "due"; readonly label: string }
  | {
      readonly kind: "flag";
      readonly tone: "info" | "neutral";
      readonly icon: "cloud-upload" | "clock";
      readonly label: string;
    };

export interface RoundFlag {
  readonly key: "urgent" | "communication";
  readonly icon: "triangle-alert" | "message-square-text";
  readonly tone: "warning" | "info";
  readonly label: string;
}

export interface RoundItem {
  readonly id: string;
  readonly title: string;
  /** The person, by the name they are known by; null for a task about nobody. */
  readonly person: string | null;
  readonly personId: string | null;
  /** "Due 11/10/2026 at 14:00", or how late. */
  readonly when: string | null;
  readonly timing: RoundTiming;
  readonly chip: RoundChip;
  /** Flags beside the person, each an icon and a word: urgent, and communication needs (AIS). */
  readonly flags: readonly RoundFlag[];
  /** Words to show with the task, in order: an earlier plan, what waits. */
  readonly notices: readonly string[];
  /** What the carer may do here: mark it, record its evidence, or nothing (waiting to upload). */
  readonly action: "mark" | "evidence" | "none";
  readonly row: RoundTaskRow;
}

function timingOf(row: RoundTaskRow, now: Date): RoundTiming {
  const due = parseInstant(row.due_at);
  const end = parseInstant(row.window_end) ?? due;
  const start = parseInstant(row.window_start) ?? due;
  if (end && now.getTime() > end.getTime()) return "overdue";
  if (start && now.getTime() >= start.getTime()) return "due";
  return "later";
}

function personName(row: RoundTaskRow): string | null {
  if (!row.person_id) return null;
  const known = knownAsName({
    preferredName: row.preferred_name,
    givenName: row.given_name,
    familyName: row.family_name,
  });
  const family = (row.family_name ?? "").trim();
  if (!known) return t("mobile.round.personNotOnDevice");
  return family && known !== family ? `${known} ${family}` : known;
}

/**
 * The person's communication needs in words (Accessible Information Standard; #123 clinical
 * review, M3): each need by name, and unreadable needs said as such; null when none recorded.
 */
function communicationNeedsWords(row: RoundTaskRow): string | null {
  if (!row.person_id) return null;
  const { needs, unreadable } = parseCommunicationNeeds(row.communication_needs);
  const names = needs.map((n) =>
    n.preferredFormat
      ? t("mobile.round.needWithFormat", { need: n.display, format: n.preferredFormat })
      : n.display,
  );
  if (names.length === 0 && !unreadable) return null;
  return t("mobile.round.communication", {
    needs: names.join("; "),
    unreadable: unreadable ? "yes" : "no",
    count: names.length,
  });
}

function dateTime(value: string | null): string | null {
  const instant = parseInstant(value);
  if (!instant) return null;
  const { date, time } = ukDateTimeParts(instant);
  return t("mobile.common.dateTime", { date, time });
}

/** One open task as the round shows it. */
export function roundItem(row: RoundTaskRow, now: Date): RoundItem {
  const move = parseQueuedMove(row.queued_transition);
  // A task put back on the device by a session's end holds only its move (held-work.ts).
  const title = row.title?.trim() || move?.title || t("mobile.round.untitled");
  const timing = timingOf(row, now);
  const due = dateTime(row.due_at);
  const notices: string[] = [];
  const flags: RoundFlag[] = [];
  if (row.priority === "urgent") {
    flags.push({
      key: "urgent",
      icon: "triangle-alert",
      tone: "warning",
      label: t("mobile.round.urgent"),
    });
  }
  const needs = communicationNeedsWords(row);
  if (needs) {
    flags.push({ key: "communication", icon: "message-square-text", tone: "info", label: needs });
  }
  // A plan's round whose flag has not synced is unknown, not "current" (#123 clinical review, L8).
  if (row.from_earlier_plan === 1) notices.push(t("mobile.round.earlierPlan"));
  else if (row.from_earlier_plan === null && row.series_id) {
    notices.push(t("mobile.round.earlierPlanUnknown"));
  }
  let action: RoundItem["action"] = row.evidence_required === 1 ? "evidence" : "mark";
  let chip: RoundChip =
    timing === "later"
      ? {
          kind: "flag",
          tone: "neutral",
          icon: "clock",
          label: t("mobile.round.later"),
        }
      : {
          kind: "status",
          status: timing,
          // An escalated overdue task says so in words (#123 clinical review, L11).
          label:
            timing === "overdue" && (row.escalation_level ?? 0) > 0
              ? t("mobile.round.overdueEscalated")
              : t(`mobile.round.${timing}` as MessageKey),
        };
  if (row.kind?.startsWith("medicines.")) {
    // Recorded through eMAR on the web until the phone has it (#123 clinical review, L10).
    notices.push(t("mobile.round.medicinesOnWeb"));
    action = "none";
  }
  if (move) {
    notices.push(t("mobile.round.moveWaiting", { to: move.to, reason: move.reason ?? "" }));
    chip = { kind: "flag", tone: "info", icon: "cloud-upload", label: t("mobile.round.waiting") };
    action = "none";
  } else if ((row.evidence_waiting ?? 0) > 0) {
    // Gate item (f): never offered again while its evidence waits to upload (HZ-029).
    notices.push(t("mobile.round.evidenceWaiting"));
    chip = { kind: "flag", tone: "info", icon: "cloud-upload", label: t("mobile.round.waiting") };
    action = "none";
  } else if (row.answered_state === "answered") {
    // The entry reached Harbour but the task is still open: Harbour kept it without completing
    // the task (the carer may not complete it, or it was not the evidence asked for), or the
    // task's own change has not synced yet. Never offered again, and never "Not done" over
    // evidence already given (#123 clinical review re-check, M1).
    notices.push(t("mobile.round.sentNotDone"));
    chip = { kind: "flag", tone: "info", icon: "clock", label: t("mobile.round.sent") };
    action = "none";
  } else if ((row.evidence_refused ?? 0) > 0 || row.answered_state === "refused") {
    // A refused entry for this task is tied back to it, not only listed above (HZ-006).
    notices.push(t("mobile.round.evidenceRefused"));
  }
  if (action === "evidence" && !row.person_id) notices.push(t("mobile.round.evidenceOnWeb"));
  return {
    id: row.id,
    title,
    person: personName(row),
    personId: row.person_id,
    when: due ? t("mobile.round.dueAt", { when: due }) : null,
    timing,
    chip,
    flags,
    notices,
    action,
    row,
  };
}

const ORDER: Record<RoundTiming, number> = { overdue: 0, due: 1, later: 2 };

/** The round, overdue first, then due now, then later, each by due time. */
export function roundItems(rows: readonly RoundTaskRow[], now: Date): RoundItem[] {
  return rows
    .map((row) => roundItem(row, now))
    .sort(
      (a, b) =>
        ORDER[a.timing] - ORDER[b.timing] ||
        (parseInstant(a.row.due_at)?.getTime() ?? 0) -
          (parseInstant(b.row.due_at)?.getTime() ?? 0) ||
        a.id.localeCompare(b.id),
    );
}

export interface RoundHeader {
  /** What the phone holds: open tasks due from the first day of the window to tomorrow. */
  readonly holds: string;
  /** When it last synced, or that it never has. */
  readonly synced: string;
  /** That the round on the phone may be incomplete, and where the whole round is. */
  readonly incomplete: string;
}

export interface RoundHeaderInput {
  readonly now: Date;
  /**
   * The offline window's days exactly as the last token gave them (UTC days; `sync/offline-days`),
   * or null while none is kept. Never a day count with the clock (#123 clinical review, M4).
   */
  readonly offlineDays: readonly string[] | null;
  readonly lastSyncedAt: Date | null;
  readonly demo: boolean;
}

/** An instant in UK time, "30/10/2026 at 01:00". */
function ukWhen(instant: Date): string {
  return t("mobile.common.dateTime", ukDateTimeParts(instant));
}

/**
 * Gate item (d) and HZ-028: what the phone holds and from when, said before any task. The window is
 * whole UTC days, so its bounds are said as UK times: in British Summer Time it runs from 01:00 to
 * 00:59, and a sync late in the evening never claims a day the phone does not hold (M4; HZ-009).
 */
export function roundHeader(input: RoundHeaderInput): RoundHeader {
  const bounds = input.offlineDays ? offlineWindowBounds(input.offlineDays) : null;
  const holds = bounds
    ? t("mobile.round.holds", {
        from: ukWhen(bounds.start),
        to: ukWhen(new Date(bounds.end.getTime() - 60_000)),
      })
    : t("mobile.round.holdsUnknown");
  let synced: string;
  if (input.demo) synced = t("mobile.sync.demo");
  else if (input.lastSyncedAt) {
    const { date, time } = ukDateTimeParts(input.lastSyncedAt);
    synced = t("mobile.sync.lastSuccess", { when: t("mobile.common.dateTime", { date, time }) });
  } else synced = t("mobile.sync.neverSynced");
  return { holds, synced, incomplete: t("mobile.round.incomplete") };
}

/** The empty round: never "nothing due" (gate item (d)). */
export function roundEmpty(input: { readonly lastSyncedAt: Date | null; readonly demo: boolean }) {
  return input.lastSyncedAt || input.demo
    ? t("mobile.round.emptySynced")
    : t("mobile.round.emptyNeverSynced");
}

/** Whether the member manages tasks on the web (the person in charge of a shift, or a manager). */
export function managesTasks(permissions: readonly string[] | undefined): boolean {
  return (permissions ?? []).includes("platform.task.manage");
}

const WHO_TO_TELL: ReadonlySet<string> = new Set([
  "mobile.round.userUnknown",
  "mobile.round.scopeUnknown",
  "mobile.round.notYours",
  "mobile.round.personUnknown",
]);

/**
 * A refusal to mark a task, in words for this member: who to tell depends on whether they are the
 * person in charge (#36 review round 2: never "tell the person in charge" to that person).
 */
export function roundRefusalText(error: FieldError, manager: boolean): string {
  const words = t(error.key, error.values);
  if (!WHO_TO_TELL.has(error.key)) return words;
  return `${words} ${t("mobile.round.whoToTell", { manager: manager ? "yes" : "no" })}`;
}
