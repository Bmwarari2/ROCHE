/**
 * Bowel chart (care.md section 4 rule 6). Movements are recorded with the Bristol Stool Form Scale
 * type 1 to 7; "no bowel movement" can be recorded too and does not reset the count. Staff are
 * prompted when no movement has been recorded for `bowel.no_movement_prompt_days` days (a tenant
 * default in the rate table).
 *
 * Source: Lewis SJ, Heaton KW. Stool form scale as a useful guide to intestinal transit time.
 * Scandinavian Journal of Gastroenterology 1997;32(9):920–924. Descriptions as commonly used in
 * NHS patient information. The scale is shown, never interpreted (medical-device boundary).
 */

import { addUkDays } from "../shared/time";
import type { CareRates } from "./rates";

export type BristolStoolType = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const BRISTOL_STOOL_SCALE: Readonly<Record<BristolStoolType, string>> = {
  1: "Separate hard lumps",
  2: "Lumpy and sausage-like",
  3: "A sausage shape with cracks in the surface",
  4: "Like a smooth, soft sausage or snake",
  5: "Soft blobs with clear-cut edges",
  6: "A mushy consistency with ragged edges",
  7: "A liquid consistency with no solid pieces",
};

export type BowelEntry =
  | { readonly kind: "movement"; readonly occurredAt: Date; readonly bristolType: number }
  | { readonly kind: "no_movement"; readonly occurredAt: Date };

export function isBristolStoolType(value: number): value is BristolStoolType {
  return Number.isInteger(value) && value >= 1 && value <= 7;
}

export type BowelEntryCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export function checkBowelEntry(entry: BowelEntry): BowelEntryCheck {
  if (entry.kind === "movement" && !isBristolStoolType(entry.bristolType)) {
    return { ok: false, message: "Choose a Bristol stool type from 1 to 7." };
  }
  return { ok: true };
}

export interface NoMovementPrompt {
  /** The last recorded movement, or null when none has been recorded since the chart started. */
  readonly lastMovementAt: Date | null;
  readonly promptDueAt: Date;
  readonly prompt: boolean;
}

/**
 * The "no bowel movement" prompt falls due the configured number of days after the last recorded
 * movement (or the start of the chart), in UK calendar days so a clock change does not move it.
 */
export function noBowelMovementPrompt(
  entries: readonly BowelEntry[],
  chartStartedAt: Date,
  now: Date,
  rates: Pick<CareRates, "bowelNoMovementPromptDays">,
): NoMovementPrompt {
  const movements = entries
    .filter((e) => e.kind === "movement" && e.occurredAt.getTime() <= now.getTime())
    .map((e) => e.occurredAt.getTime());
  const lastMovementAt = movements.length > 0 ? new Date(Math.max(...movements)) : null;
  const promptDueAt = addUkDays(lastMovementAt ?? chartStartedAt, rates.bowelNoMovementPromptDays);
  return { lastMovementAt, promptDueAt, prompt: now.getTime() >= promptDueAt.getTime() };
}
