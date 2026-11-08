/**
 * Words and statuses for the medicines round on the phone (slice 69). Status is always an icon
 * and a word, never colour alone; allergies sit beside every medicine, and "not recorded" is never
 * read as "none" (HZ-007). Pure, so the words are tested.
 */

import type { PackCheck, ScheduledDoseState } from "@harbour/domain";
import type { StatusChipProps } from "@harbour/ui-native";
import { ukDateTimeParts } from "../care/time";
import { t } from "../i18n/t";
import type { RoundGate } from "./round";

export const DOSE_STATUS: Readonly<Record<ScheduledDoseState, StatusChipProps["status"]>> = {
  late: "overdue",
  due: "due",
  not_yet_due: "notApplicable",
  recorded: "done",
};

export interface AllergySummaryRow {
  readonly substance: string | null;
  readonly reaction: string | null;
}

/** The allergy line beside a medicine. */
export function allergyLine(
  status: string | null,
  allergies: readonly AllergySummaryRow[],
): { readonly words: string; readonly warning: boolean } {
  if (allergies.length > 0) {
    const named = allergies.map((a) =>
      a.reaction
        ? t("mobile.meds.allergyWithReaction", {
            substance: a.substance ?? t("mobile.person.allergySubstanceMissing"),
            reaction: a.reaction,
          })
        : (a.substance ?? t("mobile.person.allergySubstanceMissing")),
    );
    return { words: t("mobile.meds.allergies", { list: named.join(", ") }), warning: true };
  }
  if (status === "no_known_allergies") {
    return { words: t("mobile.meds.noKnownAllergies"), warning: false };
  }
  // Unknown, or allergies recorded that this phone has not received: never "none" (HZ-007).
  return {
    words:
      status === "has_allergies"
        ? t("mobile.meds.allergiesNotOnPhone")
        : t("mobile.meds.allergiesUnknown"),
    warning: true,
  };
}

/** Why the round is not offered, in words, or null when it is. */
export function gateWords(gate: RoundGate): string | null {
  switch (gate.kind) {
    case "device_not_trusted":
      return gate.status === "compromised"
        ? t("mobile.security.compromised")
        : t("mobile.meds.integrityUnknown");
    case "waiting_for_sync":
      return t("mobile.meds.waitingForSync");
    case "waiting_for_figures":
      return t("mobile.meds.waitingForFigures");
    default:
      return null;
  }
}

/** What a scan found, in words, and whether the dose may go on with it. */
export function packCheckWords(check: PackCheck | "unreadable"): {
  readonly words: string;
  readonly matches: boolean;
} {
  if (check === "unreadable") return { words: t("mobile.meds.scanUnreadable"), matches: false };
  switch (check.result) {
    case "matches":
      return { words: t("mobile.meds.scanMatches"), matches: true };
    case "different_product":
      return { words: t("mobile.meds.scanDifferent"), matches: false };
    case "expired":
      return { words: t("mobile.meds.scanExpired", { date: check.expiry }), matches: false };
    default:
      return { words: t("mobile.meds.scanUnknown"), matches: false };
  }
}

export function personName(p: {
  readonly preferred_name: string | null;
  readonly given_name: string | null;
  readonly family_name: string | null;
}): string {
  return [p.preferred_name ?? p.given_name, p.family_name].filter(Boolean).join(" ") || "";
}

/** "2026-11-03" as "03/11/2026". */
export function ukDateWords(isoDate: string): string {
  const [y, m, d] = isoDate.split("-");
  return y && m && d ? `${d}/${m}/${y}` : isoDate;
}

/** An instant as "03/11/2026 08:00", UK time (with BST or GMT on a clock-change day). */
export function ukInstantWords(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  const parts = ukDateTimeParts(parsed);
  return `${parts.date} ${parts.time}`;
}

/**
 * hazard HZ-113: when the medicines data a scan is matched against reached this phone, and when a
 * request for it last failed, so an unknown pack is read against how old the data is.
 */
export function dmdSubsetLine(fetchedAt: string | null, failedAt: string | null): string {
  const fetched = fetchedAt
    ? t("mobile.meds.dmdFetched", { at: ukInstantWords(fetchedAt) })
    : t("mobile.meds.dmdNever");
  return failedAt
    ? `${fetched} ${t("mobile.meds.dmdFailed", { at: ukInstantWords(failedAt) })}`
    : fetched;
}

/** How many communication needs the person's synced row lists (the Accessible Information Standard flag). */
export function communicationNeedsCount(json: string | null): number {
  try {
    const parsed: unknown = JSON.parse(json ?? "[]");
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}
