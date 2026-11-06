/**
 * Structured doses (medicines.md rule 2, HZ-005). A dose is a number and a unit, never free text,
 * and the unit must be one dm+d permits for the product. Numbers are written the way the BNF's
 * guidance on writing prescriptions asks: a zero before a decimal point (0.5, never .5), no
 * trailing zero (5, never 5.0), no thousands separator; "micrograms", "nanograms" and "units"
 * always in full. Harbour transcribes the prescribed dose exactly: it never converts a dose,
 * calculates one or says whether one is usual (medical-device boundary, section 4).
 */

/** A dm+d unit of measure: its code and its dm+d description (for example "tablet", "mg"). */
export interface DoseUnit {
  readonly code: string;
  readonly name: string;
}

/**
 * - `amount`: one quantity ("2 tablets").
 * - `range`: the prescription allows a range ("1 to 2 tablets"); the amount given is recorded.
 * - `variable`: the dose changes by date and is read from the current dosing record (for example
 *   an anticoagulant clinic's record); only the unit is fixed on the MAR.
 */
export type Dose =
  | { readonly kind: "amount"; readonly quantity: number; readonly unit: DoseUnit }
  | {
      readonly kind: "range";
      readonly from: number;
      readonly to: number;
      readonly unit: DoseUnit;
    }
  | { readonly kind: "variable"; readonly unit: DoseUnit };

/** Doses are written with at most this many decimal places; a smaller unit is used instead. */
export const DOSE_MAX_DECIMALS = 3;
/** A format limit on typed numbers (never a dose limit): at most 7 digits before the point. */
const DOSE_MAX_INTEGER_DIGITS = 7;

export type DoseQuantityProblem =
  | "empty"
  | "comma"
  | "no_leading_zero"
  | "trailing_zero"
  | "leading_zeros"
  | "not_a_number"
  | "too_many_decimals"
  | "too_large"
  | "not_more_than_zero";

export type ParsedDoseQuantity =
  | { readonly ok: true; readonly quantity: number }
  | { readonly ok: false; readonly problem: DoseQuantityProblem; readonly message: string };

function refuse(problem: DoseQuantityProblem, message: string): ParsedDoseQuantity {
  return { ok: false, problem, message };
}

/** The canonical way to write a typed number, for the "write X, never Y" messages. */
function canonical(text: string): string {
  const [whole = "0", fraction = ""] = text.split(".");
  const trimmedWhole = whole.replace(/^0+(?=\d)/, "") || "0";
  const trimmedFraction = fraction.replace(/0+$/, "");
  return trimmedFraction ? `${trimmedWhole}.${trimmedFraction}` : trimmedWhole;
}

/**
 * Reads a dose quantity as typed. Anything not already in the canonical form is refused with the
 * form to type instead, so what was typed, what is stored and what is shown are the same.
 */
export function parseDoseQuantity(text: string): ParsedDoseQuantity {
  const value = text.trim();
  if (value === "") return refuse("empty", "Enter the dose as a number.");
  if (value.includes(",")) {
    return refuse(
      "comma",
      "Use a full stop for decimals and no thousands separator, for example 0.5 or 5000.",
    );
  }
  if (/^\.\d+$/.test(value)) {
    return refuse(
      "no_leading_zero",
      `Write a zero before the decimal point: ${canonical(`0${value}`)}, never ${value}.`,
    );
  }
  if (!/^\d+(\.\d*)?$/.test(value)) {
    return refuse("not_a_number", "Enter the dose as a number in figures, for example 2 or 0.5.");
  }
  if (/\.$/.test(value) || /\.\d*0$/.test(value)) {
    return refuse(
      "trailing_zero",
      `Write ${canonical(value.replace(/\.$/, ""))}, never ${value}: a trailing zero or point can be misread as ten times the dose.`,
    );
  }
  if (/^0\d/.test(value)) {
    return refuse("leading_zeros", `Write ${canonical(value)}, never ${value}.`);
  }
  const [whole = "", fraction = ""] = value.split(".");
  if (fraction.length > DOSE_MAX_DECIMALS) {
    return refuse(
      "too_many_decimals",
      `Write the dose with at most ${DOSE_MAX_DECIMALS} decimal places. If the source document has more, ask the prescriber or pharmacist before transcribing it.`,
    );
  }
  if (whole.length > DOSE_MAX_INTEGER_DIGITS) {
    return refuse("too_large", "That number is too long. Check the dose on the source document.");
  }
  const quantity = Number(value);
  if (quantity <= 0) return refuse("not_more_than_zero", "A dose must be more than zero.");
  return { ok: true, quantity };
}

/** True when a stored number is one `parseDoseQuantity` could have produced. */
export function isDoseQuantity(value: number): boolean {
  if (!Number.isFinite(value) || value <= 0) return false;
  const scaled = value * 10 ** DOSE_MAX_DECIMALS;
  if (Math.abs(scaled - Math.round(scaled)) > 1e-6) return false;
  return Math.trunc(value).toString().length <= DOSE_MAX_INTEGER_DIGITS;
}

/** Writes a quantity with a leading zero, no trailing zero and no thousands separator. */
export function formatDoseQuantity(value: number): string {
  if (!isDoseQuantity(value)) throw new RangeError("Not a dose quantity.");
  return value.toFixed(DOSE_MAX_DECIMALS).replace(/0+$/, "").replace(/\.$/, "");
}

// Units written in full whatever the source calls them (BNF: "micrograms", "nanograms" and
// "units" are never abbreviated, because "mcg", "ng" and "u" are misread).
const FULL_NAME_UNITS: Readonly<Record<string, readonly [string, string]>> = {
  microgram: ["microgram", "micrograms"],
  micrograms: ["microgram", "micrograms"],
  mcg: ["microgram", "micrograms"],
  µg: ["microgram", "micrograms"],
  μg: ["microgram", "micrograms"],
  ug: ["microgram", "micrograms"],
  nanogram: ["nanogram", "nanograms"],
  nanograms: ["nanogram", "nanograms"],
  ng: ["nanogram", "nanograms"],
  unit: ["unit", "units"],
  units: ["unit", "units"],
  u: ["unit", "units"],
  iu: ["unit", "units"],
  "i.u.": ["unit", "units"],
  "international unit": ["unit", "units"],
  "international units": ["unit", "units"],
};

/** Abbreviated SI units, written the same for one or many ("1 mg", "2 mg"). */
const INVARIANT_UNITS = new Set(["mg", "g", "kg", "ml", "l", "mmol", "mol", "cm", "mm", "%"]);

function plural(word: string): string {
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

/** The "per" part of a compound unit, written in full and singular ("hour", "microgram"). */
const PER_UNITS: Readonly<Record<string, string>> = { h: "hour", hr: "hour", hrs: "hour" };

function simpleUnitName(name: string, one: boolean): string {
  const key = name.toLowerCase();
  const full = FULL_NAME_UNITS[key];
  if (full) return one ? full[0] : full[1];
  if (INVARIANT_UNITS.has(key) || !/^[a-z][a-z -]*$/i.test(name)) return name;
  if (one) return name;
  const words = name.split(" ");
  const last = words.pop() as string;
  return [...words, plural(last)].join(" ");
}

/**
 * A unit that is a measured amount of something, such as "5ml spoonful": its size and its noun. The
 * noun starts with a non-space so the space before it and the noun cannot share characters, which
 * keeps matching linear (CodeQL js/polynomial-redos); names reach it trimmed with single spaces.
 */
const SIZED_UNIT = /^(\d+(?:\.\d+)?)\s*([a-z\u00b5\u03bc.]+)\s+(\S.*)$/i;

/**
 * The unit's name for display: in full where the BNF asks, plural unless the quantity is 1. A
 * compound unit keeps its parts in full ("micrograms/hour" for "mcg/hr"); a measured unit puts a
 * space between its size and unit ("5 ml spoonfuls").
 */
export function doseUnitName(unit: DoseUnit, one: boolean): string {
  const name = unit.name.trim().replace(/\s+/g, " ");
  const slash = name.indexOf("/");
  if (slash > 0) {
    const per = name.slice(slash + 1).trim();
    const perName = FULL_NAME_UNITS[per.toLowerCase()]?.[0] ?? PER_UNITS[per.toLowerCase()] ?? per;
    return `${simpleUnitName(name.slice(0, slash).trim(), one)}/${perName}`;
  }
  const sized = SIZED_UNIT.exec(name);
  if (sized) {
    const [, size, sizeUnit, noun] = sized as unknown as [string, string, string, string];
    return `${size} ${simpleUnitName(sizeUnit, true)} ${simpleUnitName(noun, one)}`;
  }
  return simpleUnitName(name, one);
}

/** "2 tablets", or "2 × 5 ml spoonfuls" for a measured unit, so the size is never read as part of the number. */
function quantityWithUnit(quantity: string, unit: DoseUnit, one: boolean): string {
  const name = doseUnitName(unit, one);
  return /^\d/.test(name) ? `${quantity} \u00d7 ${name}` : `${quantity} ${name}`;
}

/** A dose in words for the MAR, the round and every print ("0.5 micrograms", "1 to 2 tablets"). */
export function formatDose(dose: Dose): string {
  if (dose.kind === "amount") {
    return quantityWithUnit(formatDoseQuantity(dose.quantity), dose.unit, dose.quantity === 1);
  }
  if (dose.kind === "range") {
    const range = `${formatDoseQuantity(dose.from)} to ${formatDoseQuantity(dose.to)}`;
    return quantityWithUnit(range, dose.unit, dose.to === 1);
  }
  return `As on the current dosing record, in ${doseUnitName(dose.unit, false)}`;
}

export type DoseProblem =
  | "unit_not_permitted"
  | "not_a_dose_quantity"
  | "range_not_ascending"
  | "smaller_unit_permitted";

/**
 * The mass units in the order the BNF steps down through them, each with the names dm+d and
 * prescribers write it under. A quantity below 1 in one of the first three is written in the next
 * one where dm+d permits it for the product ("500 mg", never "0.5 g"; H-551).
 */
const MASS_UNITS = [
  { key: "g", names: ["g", "gram", "grams", "gramme", "grammes"] },
  { key: "mg", names: ["mg", "milligram", "milligrams", "milligramme", "milligrammes"] },
  {
    key: "microgram",
    names: ["microgram", "micrograms", "mcg", "\u00b5g", "\u03bcg", "ug", "microgramme"],
  },
  { key: "nanogram", names: ["nanogram", "nanograms", "ng", "nanogramme"] },
] as const;

type MassUnitKey = (typeof MASS_UNITS)[number]["key"];

/** The mass unit a dm+d unit is, by its description; null for any other unit. */
function massUnit(unit: DoseUnit): MassUnitKey | null {
  const name = unit.name.trim().toLowerCase();
  return MASS_UNITS.find((m) => (m.names as readonly string[]).includes(name))?.key ?? null;
}

/** The next smaller mass unit, for g, mg and micrograms; null otherwise. */
function nextSmallerMassUnit(key: MassUnitKey): MassUnitKey | null {
  const index = MASS_UNITS.findIndex((m) => m.key === key);
  return index >= 0 && index < 3 ? (MASS_UNITS[index + 1]?.key ?? null) : null;
}

export interface DoseIssue {
  readonly problem: DoseProblem;
  readonly message: string;
}

/**
 * Checks a structured dose against the units dm+d permits for the product (matched by code, never
 * by name). Returns every problem, or none.
 */
export function checkDose(dose: Dose, permittedUnits: readonly DoseUnit[]): readonly DoseIssue[] {
  const issues: DoseIssue[] = [];
  if (!permittedUnits.some((u) => u.code === dose.unit.code)) {
    const names = permittedUnits.map((u) => doseUnitName(u, false)).join(", ");
    issues.push({
      problem: "unit_not_permitted",
      message: names
        ? `dm+d does not give "${dose.unit.name}" for this product. Choose one of: ${names}.`
        : "dm+d gives no dose unit for this product. Check the product chosen.",
    });
  }
  const quantities =
    dose.kind === "amount" ? [dose.quantity] : dose.kind === "range" ? [dose.from, dose.to] : [];
  if (quantities.some((q) => !isDoseQuantity(q))) {
    issues.push({
      problem: "not_a_dose_quantity",
      message: `A dose is a number more than zero with at most ${DOSE_MAX_DECIMALS} decimal places.`,
    });
  }
  if (dose.kind === "range" && !(dose.from < dose.to)) {
    issues.push({
      problem: "range_not_ascending",
      message: "A dose range goes from the smaller amount to the larger, for example 1 to 2.",
    });
  }
  // A quantity below 1 in g, mg or micrograms where dm+d permits the next smaller unit for the
  // product: the BNF asks for the smaller unit ("500 mg", never "0.5 g"). Harbour never converts a
  // dose (medical-device boundary), so it refuses and sends the reader to the prescriber (H-551).
  const mass = massUnit(dose.unit);
  const smaller = mass ? nextSmallerMassUnit(mass) : null;
  const smallerUnit = smaller ? permittedUnits.find((u) => massUnit(u) === smaller) : undefined;
  if (smallerUnit && quantities.some((q) => Number.isFinite(q) && q > 0 && q < 1)) {
    const name = doseUnitName(dose.unit, false);
    const smallerName = doseUnitName(smallerUnit, false);
    issues.push({
      problem: "smaller_unit_permitted",
      message: `A dose below 1 ${doseUnitName(dose.unit, true)} is written in ${smallerName} for this product, never as a decimal of ${name}. Harbour does not convert doses: ask the prescriber or pharmacist for the dose in ${smallerName}.`,
    });
  }
  return issues;
}
