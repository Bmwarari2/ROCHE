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
      `Write the dose with at most ${DOSE_MAX_DECIMALS} decimal places, in a smaller unit if the product has one.`,
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

/** The unit's name for display: in full where the BNF asks, plural unless the quantity is 1. */
export function doseUnitName(unit: DoseUnit, one: boolean): string {
  const name = unit.name.trim();
  const key = name.toLowerCase();
  const full = FULL_NAME_UNITS[key];
  if (full) return one ? full[0] : full[1];
  if (INVARIANT_UNITS.has(key) || !/^[a-z][a-z -]*$/i.test(name)) return name;
  if (one) return name;
  const words = name.split(" ");
  const last = words.pop() as string;
  return [...words, plural(last)].join(" ");
}

/** A dose in words for the MAR, the round and every print ("0.5 micrograms", "1 to 2 tablets"). */
export function formatDose(dose: Dose): string {
  if (dose.kind === "amount") {
    return `${formatDoseQuantity(dose.quantity)} ${doseUnitName(dose.unit, dose.quantity === 1)}`;
  }
  if (dose.kind === "range") {
    return `${formatDoseQuantity(dose.from)} to ${formatDoseQuantity(dose.to)} ${doseUnitName(dose.unit, dose.to === 1)}`;
  }
  return `As on the current dosing record, in ${doseUnitName(dose.unit, false)}`;
}

export type DoseProblem = "unit_not_permitted" | "not_a_dose_quantity" | "range_not_ascending";

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
  return issues;
}
