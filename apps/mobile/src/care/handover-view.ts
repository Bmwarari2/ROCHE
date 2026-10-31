/**
 * The shift handover on the phone (care.md rule 14 and section 6; screens gate items (a), (d) and
 * (e); HZ-018, HZ-028): which handover the phone should hold, what it says, and what the reader may
 * do, worked out from the synced rows so the screen only draws. Pure apart from the translator.
 *
 * - (e) The outgoing handover is the one for the shift before the one running now, by the
 *   location's nation's shift pattern from the sync token (`sync/handover-shifts.ts`, ADR-0074).
 *   When that handover is not on the phone, it says "not compiled yet" (or not synced since);
 *   while its `locked_at` is empty, "not final". With no pattern for the location's nation it says
 *   it cannot tell which handover to expect, and never guesses (H-303).
 * - (a) Each item is worded from the summary compiled with it (`handover-summary.ts`), or by its
 *   kind, never blank.
 * - (d) What the phone holds, when it last synced, and that items added since are not here, said
 *   before any item; an empty handover never reads as "nothing to hand over".
 * - An acknowledgement made here waits to upload and says so; items added since the reader's last
 *   acknowledgement are marked new, and acknowledging again covers them (HZ-018).
 * - Status is always an icon and a word, never colour alone.
 */
import { previousShift, type ShiftWindow, shiftAt, twoShiftPattern } from "@harbour/domain";
import { knownAsName } from "@harbour/ui-native/logic";
import { t } from "../i18n/t";
import { parseCommunicationNeeds } from "../people/person-view";
import type { HandoverShifts } from "../sync/handover-shifts";
import { offlineWindowBounds } from "../sync/offline-days";
import { handoverItemWords } from "./handover-summary";
import type { ShownItem } from "./round-actions";
import { parseInstant, ukDateTimeParts } from "./time";

/** A synced handover. */
export interface HandoverRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly location_id: string;
  readonly shift_name: string | null;
  readonly shift_start: string | null;
  readonly shift_end: string | null;
  readonly compiled_at: string | null;
  readonly locked_at: string | null;
}

/** A synced item, with its person's names as the phone holds them. */
export interface HandoverItemViewRow {
  readonly id: string;
  readonly handover_id: string;
  readonly item_key: string;
  readonly position: number | null;
  readonly kind: string | null;
  readonly person_id: string | null;
  readonly at: string | null;
  readonly late_addition: number | null;
  readonly added_at: string | null;
  readonly summary: string | null;
  readonly preferred_name: string | null;
  readonly given_name: string | null;
  readonly family_name: string | null;
  readonly communication_needs: string | null;
}

/** The reader's own acknowledgement of a handover (the server's copy, or one made here). */
export interface AcknowledgementRow {
  readonly handover_id: string;
  readonly item_keys: string | null;
  readonly acknowledged_at: string | null;
  /** Set only on an acknowledgement made on this phone and not yet replaced by the server's. */
  readonly seen_token: string | null;
}

export type ExpectedHandover =
  | { readonly kind: "unknown" }
  | { readonly kind: "not_compiled"; readonly shift: ShiftWindow }
  | {
      readonly kind: "not_final" | "final";
      readonly shift: ShiftWindow;
      readonly handover: HandoverRow;
    };

export interface ExpectedHandoverInput {
  readonly now: Date;
  /** The location's nation (`location.nation`); null when the phone does not know it. */
  readonly nation: string | null;
  /** The last pattern a token carried; null when none is kept. */
  readonly shifts: HandoverShifts | null;
  /** The location's handovers on the phone. */
  readonly handovers: readonly HandoverRow[];
}

/** Gate item (e): the outgoing handover the phone should hold for a location, and its state. */
export function expectedHandover(input: ExpectedHandoverInput): ExpectedHandover {
  const figures = input.nation ? input.shifts?.[input.nation] : undefined;
  if (!figures) return { kind: "unknown" };
  let shift: ShiftWindow;
  try {
    const pattern = twoShiftPattern(figures.day, figures.night);
    shift = previousShift(shiftAt(input.now, pattern), pattern);
  } catch {
    return { kind: "unknown" };
  }
  const handover = input.handovers.find(
    (h) => parseInstant(h.shift_start)?.getTime() === shift.start.getTime(),
  );
  if (!handover) return { kind: "not_compiled", shift };
  return { kind: handover.locked_at ? "final" : "not_final", shift, handover };
}

export interface HandoverChip {
  readonly tone: "info" | "neutral" | "warning";
  readonly icon: "circle-help" | "clock" | "circle-check" | "triangle-alert";
  readonly label: string;
}

export interface HandoverStatusView {
  readonly chip: HandoverChip;
  /** Which shift's handover this is, in UK time; null when the phone cannot tell. */
  readonly shift: string | null;
  readonly words: string;
}

function shiftWords(shift: ShiftWindow): string {
  const start = ukDateTimeParts(shift.start);
  const end = ukDateTimeParts(shift.end);
  return t("mobile.handover.shift", {
    name: shift.name,
    start: t("mobile.common.dateTime", start),
    end: t("mobile.common.dateTime", end),
  });
}

function rowShift(row: HandoverRow): ShiftWindow | null {
  const start = parseInstant(row.shift_start);
  const end = parseInstant(row.shift_end);
  return start && end ? { name: row.shift_name ?? "", start, end } : null;
}

export interface HandoverEntry {
  /**
   * `current`: the handover of the shift running now, already compiled (the overlap before a shift
   * change); `outgoing`: the shift before; `latest`: the newest on the phone, shown when it cannot
   * tell which to expect.
   */
  readonly role: "current" | "outgoing" | "latest";
  readonly status: HandoverStatusView;
  /** The handover shown, or null when none (not compiled yet, or none on the phone). */
  readonly handover: HandoverRow | null;
}

/**
 * What a home's handover cards show (clinical review of the handover screen, H1; H-420): the
 * outgoing handover, the one the shift running now received and is working from, with its state;
 * and, when the running shift already has a handover (its staff compile it before they hand over,
 * and the incoming staff read it then), that one too, said to be this shift's and whether it is
 * final. The running shift's own handover comes first only within `handover.preview_lead_minutes`
 * (the nation's `lead`) before the shift ends, the overlap before a shift change; before then, or
 * when the phone has no lead figure, the outgoing one comes first. With no pattern, the newest
 * handover on the phone with its own shift and state, under "Cannot tell" (M1).
 */
export function handoverEntries(input: ExpectedHandoverInput): HandoverEntry[] {
  const expected = expectedHandover(input);
  if (expected.kind === "unknown") {
    const latest = input.handovers.reduce<HandoverRow | null>(
      (best, h) =>
        !best ||
        (parseInstant(h.shift_start)?.getTime() ?? 0) >
          (parseInstant(best.shift_start)?.getTime() ?? 0)
          ? h
          : best,
      null,
    );
    return [{ role: "latest", status: unknownStatusView(latest), handover: latest }];
  }
  const outgoing: HandoverEntry = {
    role: "outgoing",
    status: handoverStatusView(expected),
    handover: expected.kind === "not_compiled" ? null : expected.handover,
  };
  const entries: HandoverEntry[] = [];
  let currentFirst = false;
  const figures = input.nation ? input.shifts?.[input.nation] : undefined;
  if (figures) {
    const running = shiftAt(input.now, twoShiftPattern(figures.day, figures.night));
    const current = input.handovers.find(
      (h) => parseInstant(h.shift_start)?.getTime() === running.start.getTime(),
    );
    currentFirst =
      figures.lead !== undefined &&
      input.now.getTime() >= running.end.getTime() - figures.lead * 60_000;
    if (current) {
      entries.push({
        role: "current",
        handover: current,
        status: {
          chip: current.locked_at
            ? { tone: "neutral", icon: "circle-check", label: t("mobile.handover.final") }
            : { tone: "info", icon: "clock", label: t("mobile.handover.thisShift") },
          shift: shiftWords(running),
          words: current.locked_at
            ? t("mobile.handover.finalWords")
            : t("mobile.handover.thisShiftWords"),
        },
      });
    }
  }
  return currentFirst ? [...entries, outgoing] : [outgoing, ...entries];
}

/** "Cannot tell", with the shift and state of the handover shown, when there is one (M1). */
function unknownStatusView(latest: HandoverRow | null): HandoverStatusView {
  const shift = latest ? rowShift(latest) : null;
  const state = latest
    ? latest.locked_at
      ? t("mobile.handover.shownFinal")
      : t("mobile.handover.shownNotFinal")
    : null;
  return {
    chip: { tone: "warning", icon: "circle-help", label: t("mobile.handover.cannotTell") },
    shift: shift ? shiftWords(shift) : null,
    words: state
      ? `${t("mobile.handover.cannotTellWords")} ${state}`
      : t("mobile.handover.cannotTellWords"),
  };
}

/** What the screen says about the expected handover, before any item. */
export function handoverStatusView(expected: ExpectedHandover): HandoverStatusView {
  switch (expected.kind) {
    case "unknown":
      return {
        chip: { tone: "warning", icon: "circle-help", label: t("mobile.handover.cannotTell") },
        shift: null,
        words: t("mobile.handover.cannotTellWords"),
      };
    case "not_compiled":
      return {
        chip: { tone: "warning", icon: "triangle-alert", label: t("mobile.handover.notCompiled") },
        shift: shiftWords(expected.shift),
        words: t("mobile.handover.notCompiledWords"),
      };
    case "not_final":
      return {
        chip: { tone: "info", icon: "clock", label: t("mobile.handover.notFinal") },
        shift: shiftWords(expected.shift),
        words: t("mobile.handover.notFinalWords"),
      };
    case "final":
      return {
        chip: { tone: "neutral", icon: "circle-check", label: t("mobile.handover.final") },
        shift: shiftWords(expected.shift),
        words: t("mobile.handover.finalWords"),
      };
  }
}

export interface HandoverItemView {
  readonly id: string;
  readonly key: string;
  readonly position: number;
  readonly words: string;
  /** The person, by the name they are known by; null for an item about nobody. */
  readonly person: string | null;
  readonly personId: string | null;
  readonly when: string | null;
  /** Communication needs count for the flag (Accessible Information Standard). */
  readonly communicationNeeds: number;
  readonly communicationLabel: string | null;
  /** Added after the handover was first compiled. */
  readonly lateAddition: boolean;
  /** Not in the reader's last acknowledgement: read it, then acknowledge again. */
  readonly newForReader: boolean;
}

function parseKeys(value: string | null): readonly string[] | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((k) => typeof k === "string") ? parsed : null;
  } catch {
    return null;
  }
}

function personName(row: HandoverItemViewRow): string | null {
  if (!row.person_id) return null;
  const known = knownAsName({
    preferredName: row.preferred_name,
    givenName: row.given_name,
    familyName: row.family_name,
  });
  if (!known) return t("mobile.handover.personNotOnDevice");
  const family = (row.family_name ?? "").trim();
  return family && known !== family ? t("mobile.handover.personName", { known, family }) : known;
}

/** The handover's items in their compiled order, each worded (gate item (a)). */
export function handoverItems(
  rows: readonly HandoverItemViewRow[],
  acknowledgement: AcknowledgementRow | null,
): HandoverItemView[] {
  const seen = acknowledgement ? parseKeys(acknowledgement.item_keys) : null;
  return [...rows]
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.item_key.localeCompare(b.item_key))
    .map((row) => {
      const at = parseInstant(row.at);
      const needs = row.person_id ? parseCommunicationNeeds(row.communication_needs) : null;
      // The person's record is not on the phone, so neither are their needs: say so, never nothing.
      const personMissing =
        row.person_id !== null && !row.preferred_name && !row.given_name && !row.family_name;
      return {
        id: row.id,
        key: row.item_key,
        position: row.position ?? 0,
        words: handoverItemWords({ kind: row.kind, summary: row.summary }),
        person: personName(row),
        personId: row.person_id,
        when: at ? t("mobile.common.dateTime", ukDateTimeParts(at)) : null,
        communicationNeeds: needs ? needs.needs.length + (needs.unreadable ? 1 : 0) : 0,
        // Needs by name, through the catalogue (#123 clinical review, M3 and L12).
        communicationLabel: personMissing
          ? t("mobile.handover.communicationUnknown")
          : needs && (needs.needs.length > 0 || needs.unreadable)
            ? t("mobile.round.communication", {
                needs: needs.needs
                  .map((n) =>
                    n.preferredFormat
                      ? t("mobile.round.needWithFormat", {
                          need: n.display,
                          format: n.preferredFormat,
                        })
                      : n.display,
                  )
                  .join("; "),
                unreadable: needs.unreadable ? "yes" : "no",
                count: needs.needs.length,
              })
            : null,
        lateAddition: row.late_addition === 1,
        // An acknowledgement whose keys cannot be read covers nothing, so every item reads as new.
        newForReader: acknowledgement !== null && !(seen ?? []).includes(row.item_key),
      };
    });
}

export type AcknowledgementState =
  | "none"
  | "waiting"
  | "acknowledged"
  | "new_items"
  | "nothing_to_acknowledge";

/** The reader's acknowledgement: none yet, waiting to upload, done, or new items since. */
export function acknowledgementState(
  items: readonly HandoverItemView[],
  acknowledgement: AcknowledgementRow | null,
): AcknowledgementState {
  if (acknowledgement?.seen_token) return "waiting";
  if (items.length === 0) return "nothing_to_acknowledge";
  if (!acknowledgement) return "none";
  return items.some((i) => i.newForReader) ? "new_items" : "acknowledged";
}

/** The items shown, for the seen token, in their compiled order (`acknowledgementInsert`). */
export function shownItems(items: readonly HandoverItemView[]): ShownItem[] {
  return items.map((i) => ({ item_key: i.key, position: i.position }));
}

export interface HandoverHeader {
  readonly holds: string;
  readonly synced: string;
  readonly incomplete: string;
}

/**
 * Gate item (d) and HZ-028 for the handover: what the phone holds (the handovers for shifts ending
 * on the offline window's days, exactly as the last token gave them: whole UTC days, said in UK
 * time; #123 clinical review, M4), when it last synced, and that items added since are not here.
 */
export function handoverHeader(input: {
  readonly now: Date;
  readonly offlineDays: readonly string[] | null;
  readonly lastSyncedAt: Date | null;
  readonly demo: boolean;
}): HandoverHeader {
  const bounds = input.offlineDays ? offlineWindowBounds(input.offlineDays) : null;
  const holds = bounds
    ? t("mobile.handover.holds", {
        from: t("mobile.common.dateTime", ukDateTimeParts(bounds.start)),
        to: t("mobile.common.dateTime", ukDateTimeParts(new Date(bounds.end.getTime() - 60_000))),
      })
    : t("mobile.handover.holdsUnknown");
  let synced: string;
  if (input.demo) synced = t("mobile.sync.demo");
  else if (input.lastSyncedAt) {
    synced = t("mobile.sync.lastSuccess", {
      when: t("mobile.common.dateTime", ukDateTimeParts(input.lastSyncedAt)),
    });
  } else synced = t("mobile.sync.neverSynced");
  return { holds, synced, incomplete: t("mobile.handover.incomplete") };
}

/** An empty handover: never "nothing to hand over" (gate item (d)). */
export function handoverEmpty(lastSyncedAt: Date | null, demo: boolean): string {
  return lastSyncedAt || demo
    ? t("mobile.handover.emptySynced")
    : t("mobile.handover.emptyNeverSynced");
}
