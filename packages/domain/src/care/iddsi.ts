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
  | { readonly outcome: "mismatch"; readonly needsReason: true; readonly raisesAlert: false }
  /**
   * No level was recorded (a drink saved without its texture). Unsafe when a level is prescribed,
   * because nobody can tell what texture was given (HZ-016).
   */
  | { readonly outcome: "level_not_recorded"; readonly raisesAlert: boolean }
  /** The person's prescribed level is not an IDDSI level, so nothing can be compared with it. */
  | { readonly outcome: "prescribed_unreadable"; readonly raisesAlert: true };

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

/**
 * What happens to an entry the rules would refuse (HZ-016; clinical review C3 of #15):
 * - `refuse`: the person recording it is there to put it right, as on the web form, which asks for
 *   the level and any reason before it saves; the entry is refused with the reason.
 * - `keep`: the entry was recorded on a device (offline, or waiting in its upload queue) and says
 *   what was given; refusing it would take it off the chart and out of the day's fluid total. It
 *   is kept with what is wrong flagged, and an unsafe one alerts the nurse in charge, so the record
 *   of what was given is never lost. A level that is not an IDDSI level at all is refused either
 *   way: it is not a record of a texture.
 */
export type IddsiProblemHandling = "refuse" | "keep";

/** What was wrong with an entry kept under `keep`. */
export type IddsiProblem = "level_not_recorded" | "reason_missing" | "prescribed_unreadable";

export interface IddsiEntry {
  readonly kind: IddsiKind;
  readonly prescribed: string | null;
  /**
   * The level given. Null when none was recorded: a drink may be saved without a level only while
   * no drink level is prescribed; food always needs one (care.md rule 6).
   */
  readonly recorded: string | null;
  /** The override reason staff typed; required for any mismatch. */
  readonly reason?: string | null;
  /** Defaults to `refuse`. */
  readonly onProblem?: IddsiProblemHandling;
}

export type IddsiEntryCheck =
  | {
      readonly ok: true;
      readonly comparison: IddsiComparison;
      readonly alertNurseInCharge: boolean;
      /** Null when the entry is as the rules want it; otherwise what was wrong with it (`keep`). */
      readonly problem: IddsiProblem | null;
    }
  | { readonly ok: false; readonly comparison: IddsiComparison | null; readonly message: string };

/**
 * Decides whether a food or drink chart entry can be saved, and what it raises (HZ-016): a level
 * other than the prescribed one needs a reason, an unsafe one alerts the nurse in charge, and a
 * drink needs its level whenever a drink level is prescribed.
 */
export function checkIddsiEntry(entry: IddsiEntry): IddsiEntryCheck {
  const keep = entry.onProblem === "keep";
  if (entry.recorded !== null && !iddsiLevel(entry.kind, entry.recorded)) {
    return {
      ok: false,
      comparison: null,
      message: `Choose an IDDSI ${entry.kind} level from the list.`,
    };
  }
  if (entry.prescribed !== null && !iddsiLevel(entry.kind, entry.prescribed)) {
    return keep
      ? {
          ok: true,
          comparison: { outcome: "prescribed_unreadable", raisesAlert: true },
          alertNurseInCharge: true,
          problem: "prescribed_unreadable",
        }
      : {
          ok: false,
          comparison: null,
          message: `The prescribed ${entry.kind} level is not an IDDSI level. Ask the nurse in charge to correct it.`,
        };
  }
  if (entry.recorded === null) return unrecordedLevel(entry.kind, entry.prescribed, keep);
  const comparison = compareIddsiLevels(entry.kind, entry.prescribed, entry.recorded);
  if (comparison.outcome === "match" || comparison.outcome === "no_prescribed_level") {
    return { ok: true, comparison, alertNurseInCharge: false, problem: null };
  }
  const unsafe = comparison.outcome === "unsafe_mismatch";
  if (!entry.reason?.trim()) {
    if (keep) {
      return { ok: true, comparison, alertNurseInCharge: unsafe, problem: "reason_missing" };
    }
    const prescribed = describeIddsiLevel(entry.kind, entry.prescribed as string);
    return {
      ok: false,
      comparison,
      message: unsafe
        ? `This is not the prescribed ${entry.kind} level (${prescribed}) and may not be safe. Give an override reason.`
        : `This is not the prescribed ${entry.kind} level (${prescribed}). Give a reason.`,
    };
  }
  return { ok: true, comparison, alertNurseInCharge: unsafe, problem: null };
}

/**
 * An entry with no level: a drink is as the chart allows while no drink level is prescribed; with
 * one prescribed nobody can tell what texture was given, which is unsafe. Food always needs one.
 */
function unrecordedLevel(
  kind: IddsiKind,
  prescribed: string | null,
  keep: boolean,
): IddsiEntryCheck {
  if (prescribed === null && kind === "drink") {
    return {
      ok: true,
      comparison: { outcome: "no_prescribed_level" },
      alertNurseInCharge: false,
      problem: null,
    };
  }
  const comparison = { outcome: "level_not_recorded", raisesAlert: prescribed !== null } as const;
  if (keep) {
    return {
      ok: true,
      comparison,
      alertNurseInCharge: comparison.raisesAlert,
      problem: "level_not_recorded",
    };
  }
  return {
    ok: false,
    comparison,
    message:
      prescribed === null
        ? `Choose the IDDSI ${kind} level given.`
        : `${describeIddsiLevel(kind, prescribed)} is prescribed. Choose the IDDSI ${kind} level given.`,
  };
}
