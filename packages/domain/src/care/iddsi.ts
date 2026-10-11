/**
 * IDDSI food and drink levels (care.md section 4 rule 6; hazard HZ-016). Levels are always shown
 * with number, name and colour. Recording a level other than the person's prescribed level needs a
 * reason; food more solid than prescribed, or a drink thinner than prescribed, is unsafe (choking
 * and aspiration risk): it needs an override reason and raises an alert to the nurse in charge.
 *
 * Source: International Dysphagia Diet Standardisation Initiative. Complete IDDSI Framework:
 * Detailed Definitions 2.0 (2019), licensed under CC BY-SA 4.0. https://iddsi.org/framework
 */

export const IDDSI_FRAMEWORK_VERSION = "iddsi-2.0-2019";

export type IddsiColour =
  | "white"
  | "grey"
  | "pink"
  | "yellow"
  | "green"
  | "orange"
  | "blue"
  | "black";

export type IddsiFoodLevel = "3" | "4" | "5" | "6" | "7EC" | "7";
export type IddsiDrinkLevel = "0" | "1" | "2" | "3" | "4";
export type IddsiKind = "food" | "drink";

export interface IddsiLevel {
  readonly code: string;
  readonly name: string;
  readonly colour: IddsiColour;
  /** Position from thinnest or softest (0) upwards; 7EC sits between 6 and 7. */
  readonly rank: number;
}

export const IDDSI_FOOD_LEVELS: Readonly<Record<IddsiFoodLevel, IddsiLevel>> = {
  "3": { code: "3", name: "Liquidised", colour: "yellow", rank: 0 },
  "4": { code: "4", name: "Pureed", colour: "green", rank: 1 },
  "5": { code: "5", name: "Minced and moist", colour: "orange", rank: 2 },
  "6": { code: "6", name: "Soft and bite-sized", colour: "blue", rank: 3 },
  "7EC": { code: "7EC", name: "Easy to chew", colour: "black", rank: 4 },
  "7": { code: "7", name: "Regular", colour: "black", rank: 5 },
};

export const IDDSI_DRINK_LEVELS: Readonly<Record<IddsiDrinkLevel, IddsiLevel>> = {
  "0": { code: "0", name: "Thin", colour: "white", rank: 0 },
  "1": { code: "1", name: "Slightly thick", colour: "grey", rank: 1 },
  "2": { code: "2", name: "Mildly thick", colour: "pink", rank: 2 },
  "3": { code: "3", name: "Moderately thick", colour: "yellow", rank: 3 },
  "4": { code: "4", name: "Extremely thick", colour: "green", rank: 4 },
};

function levels(kind: IddsiKind): Readonly<Record<string, IddsiLevel>> {
  return kind === "food" ? IDDSI_FOOD_LEVELS : IDDSI_DRINK_LEVELS;
}

/** The level for a code, or null when the code is not an IDDSI level of that kind. */
export function iddsiLevel(kind: IddsiKind, code: string): IddsiLevel | null {
  return Object.hasOwn(levels(kind), code) ? (levels(kind)[code] as IddsiLevel) : null;
}

/** For example "Level 4 Pureed (green)": number, name and colour, never the number alone. */
export function describeIddsiLevel(kind: IddsiKind, code: string): string {
  const level = iddsiLevel(kind, code);
  if (!level) throw new RangeError(`Not an IDDSI ${kind} level: ${code}`);
  return `Level ${level.code} ${level.name} (${level.colour})`;
}

export type IddsiComparison =
  | { readonly outcome: "no_prescribed_level" }
  | { readonly outcome: "match" }
  | { readonly outcome: "unsafe_mismatch"; readonly needsReason: true; readonly raisesAlert: true }
  | { readonly outcome: "mismatch"; readonly needsReason: true; readonly raisesAlert: false };

/**
 * Compares a recorded level with the prescribed one. Food recorded at a higher (more solid) level,
 * or a drink thinner than prescribed, is unsafe; any other difference needs a reason only.
 */
export function compareIddsiLevels(
  kind: IddsiKind,
  prescribed: string | null,
  recorded: string,
): IddsiComparison {
  const given = iddsiLevel(kind, recorded);
  if (!given) throw new RangeError(`Not an IDDSI ${kind} level: ${recorded}`);
  if (prescribed === null) return { outcome: "no_prescribed_level" };
  const target = iddsiLevel(kind, prescribed);
  if (!target) throw new RangeError(`Not an IDDSI ${kind} level: ${prescribed}`);
  if (given.rank === target.rank) return { outcome: "match" };
  const unsafe = kind === "food" ? given.rank > target.rank : given.rank < target.rank;
  return unsafe
    ? { outcome: "unsafe_mismatch", needsReason: true, raisesAlert: true }
    : { outcome: "mismatch", needsReason: true, raisesAlert: false };
}

export interface IddsiEntry {
  readonly kind: IddsiKind;
  readonly prescribed: string | null;
  readonly recorded: string;
  /** The override reason staff typed; required for any mismatch. */
  readonly reason?: string | null;
}

export type IddsiEntryCheck =
  | {
      readonly ok: true;
      readonly comparison: IddsiComparison;
      readonly alertNurseInCharge: boolean;
    }
  | { readonly ok: false; readonly comparison: IddsiComparison | null; readonly message: string };

/** Decides whether a food or drink chart entry can be saved (HZ-016). */
export function checkIddsiEntry(entry: IddsiEntry): IddsiEntryCheck {
  const recorded = iddsiLevel(entry.kind, entry.recorded);
  if (!recorded) {
    return {
      ok: false,
      comparison: null,
      message: `Choose an IDDSI ${entry.kind} level from the list.`,
    };
  }
  if (entry.prescribed !== null && !iddsiLevel(entry.kind, entry.prescribed)) {
    return {
      ok: false,
      comparison: null,
      message: `The prescribed ${entry.kind} level is not an IDDSI level. Ask the nurse in charge to correct it.`,
    };
  }
  const comparison = compareIddsiLevels(entry.kind, entry.prescribed, entry.recorded);
  if (comparison.outcome === "match" || comparison.outcome === "no_prescribed_level") {
    return { ok: true, comparison, alertNurseInCharge: false };
  }
  if (!entry.reason?.trim()) {
    const prescribed = describeIddsiLevel(entry.kind, entry.prescribed as string);
    return {
      ok: false,
      comparison,
      message:
        comparison.outcome === "unsafe_mismatch"
          ? `This is not the prescribed ${entry.kind} level (${prescribed}) and may not be safe. Give an override reason.`
          : `This is not the prescribed ${entry.kind} level (${prescribed}). Give a reason.`,
    };
  }
  return { ok: true, comparison, alertNurseInCharge: comparison.raisesAlert };
}
