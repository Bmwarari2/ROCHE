/**
 * What the sign-in screen says about held entries (HZ-006, HZ-040; clinical reviews C8 and H2,
 * security review M3): whose they are, how many, and where the hold stands in time. Whole
 * sentences with a select, never a name fragment, so word order works in Welsh too.
 */
import { ukDateTimeParts } from "../care/time";
import { t } from "../i18n/t";
import { type HeldTimeState, heldTimeState } from "../sync/held-limit";
import type { HeldWork } from "./held-work";

export interface HeldView {
  readonly state: HeldTimeState;
  readonly title: string;
  readonly owner: string;
  readonly body: string;
  /** The deadline, the final warning, the escalation to a manager, or the clock warning. */
  readonly time: string;
  /** Shown as a warning (final day, escalated, clock behind) rather than plain text. */
  readonly urgent: boolean;
  readonly discardLabel: string;
  readonly confirmTitle: string;
  /** Sending the entries for their owner (care.md section 6, Device integrity part 6). */
  readonly handOverLabel: string;
}

export function heldView(held: HeldWork, now: Date): HeldView {
  const entries = held.entries;
  const who = { named: held.ownerName ? "yes" : "no", name: held.ownerName ?? "" };
  const state = heldTimeState(held, now);
  const deadline = held.expiresAt ? ukDateTimeParts(new Date(held.expiresAt)) : null;
  let time: string;
  if (state === "clockBehind") {
    time = t("mobile.held.clockBehind");
  } else if (state === "escalated" || !deadline) {
    time =
      entries === null
        ? t("mobile.held.escalatedUnknown", who)
        : t("mobile.held.escalated", { ...who, count: entries });
  } else if (state === "final") {
    time =
      entries === null
        ? t("mobile.held.finalWarningUnknown", { ...deadline, ...who })
        : t("mobile.held.finalWarning", { ...deadline, ...who, count: entries });
  } else {
    time = t("mobile.held.deadline", deadline);
  }
  return {
    state,
    title:
      entries === null ? t("mobile.held.titleUnknown") : t("mobile.held.title", { count: entries }),
    owner: held.tenantId !== "" ? t("mobile.held.owner", who) : t("mobile.held.ownerUnknown"),
    // A deletion that did not finish: these are never sent (clinical review round 4, H1). A device
    // a manager revoked: sent only by the hand-over (care.md section 6, Device integrity).
    body: held.uploadBlocked
      ? t("mobile.held.blocked")
      : held.revoked
        ? t("mobile.held.revoked")
        : t("mobile.held.body"),
    time,
    urgent: state !== "open",
    discardLabel:
      entries === null
        ? t("mobile.held.discardStartUnknown")
        : t("mobile.held.discardStart", { count: entries }),
    confirmTitle:
      entries === null
        ? t("mobile.held.discardTitleUnknown")
        : t("mobile.held.discardTitle", { count: entries }),
    handOverLabel:
      entries === null
        ? t("mobile.held.handOverStartUnknown")
        : t("mobile.held.handOverStart", { count: entries }),
  };
}
