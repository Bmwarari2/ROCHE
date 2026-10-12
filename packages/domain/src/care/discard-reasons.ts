/**
 * Coded reasons for deleting unsent care entries on a device (care.md section 6, held entries;
 * hazard HZ-040; human action H-146). Only a code leaves the device: the person's own words never
 * reach the server. Each organisation keeps its own list (`discard_reason`), seeded with the codes
 * below when it is set up; it may add codes and retire them. A retired code is no longer offered,
 * and is still accepted from a device that recorded a deletion with it before, so a deletion the
 * device has already made is never stranded on the phone.
 */

export interface DiscardReasonDefinition {
  readonly code: string;
  /** The wording, in English, as the phone offers it (mobile.discard.code.* in the catalogue). */
  readonly label: string;
  readonly sortOrder: number;
}

/** The codes every organisation starts with: the phone's fixed list before reasons were configurable. */
export const DEFAULT_DISCARD_REASONS: readonly DiscardReasonDefinition[] = [
  {
    code: "recorded_elsewhere",
    label: "Recorded again elsewhere, for example on paper",
    sortOrder: 10,
  },
  { code: "entered_in_error", label: "Entered in error", sortOrder: 20 },
  { code: "staff_left", label: "The member of staff who wrote them has left", sortOrder: 30 },
  {
    code: "nurse_in_charge_informed",
    label: "The nurse in charge knows and will make sure the care is recorded",
    sortOrder: 40,
  },
  { code: "other", label: "Other", sortOrder: 90 },
];

/** A code: lower-case letters, digits and underscores, starting with a letter, 2 to 40 long. */
export const DISCARD_REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;

export interface DiscardReasonState {
  readonly code: string;
  readonly retiredAt: Date | null;
}

/**
 * Whether a deletion record may carry a code: one the organisation has, live or retired. A code it
 * never had is refused.
 */
export function discardReasonStatus(
  reasons: readonly DiscardReasonState[],
  code: string,
): "live" | "retired" | "unknown" {
  const found = reasons.find((r) => r.code === code);
  if (!found) return "unknown";
  return found.retiredAt ? "retired" : "live";
}

export type DiscardReasonCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly field: "code" | "label"; readonly message: string };

const PLAIN_TEXT = /^[^\p{Cc}\p{Cf}]*$/u;

/** Checks a new reason: a code in the pattern, not already used, and a plain label. */
export function checkDiscardReason(
  input: { readonly code: string; readonly label: string },
  existing: readonly DiscardReasonState[],
): DiscardReasonCheck {
  if (!DISCARD_REASON_CODE_PATTERN.test(input.code)) {
    return {
      ok: false,
      field: "code",
      message:
        "Use lower-case letters, numbers and underscores for the code, starting with a letter (2 to 40 characters).",
    };
  }
  if (existing.some((r) => r.code === input.code)) {
    return { ok: false, field: "code", message: "That code is already in your list." };
  }
  const label = input.label.trim();
  if (label.length < 3 || label.length > 120 || !PLAIN_TEXT.test(label)) {
    return {
      ok: false,
      field: "label",
      message: "Give the reason as staff will read it, in 3 to 120 characters.",
    };
  }
  return { ok: true };
}
