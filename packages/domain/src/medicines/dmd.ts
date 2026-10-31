/**
 * dm+d identifiers (medicines.md rule 1, HZ-005). Every medicine on the MAR is a dm+d product: a
 * virtual medicinal product (VMP, for example "Paracetamol 500mg tablets") and, where the pack is
 * a named brand, its actual medicinal product (AMP). dm+d identifiers are SNOMED CT concept
 * identifiers, so a free-text name can never stand in for one: the identifier must have the
 * SNOMED CT shape and a valid Verhoeff check digit. The reference data itself (names, permitted
 * units, routes, the AMP's parent VMP) is loaded from the NHSBSA release in slice 10 (ADR-0080).
 *
 * Products are compared by identity only (the same VMP, and the same AMP when both name one).
 * Harbour never compares ingredients: two products with the same ingredient are different
 * products ([medical-device boundary](../../../../docs/compliance/medical-device-boundary.md)).
 */

/** A dm+d product chosen from the reference data, never typed. */
export interface DmdProductRef {
  /** The VMP's dm+d identifier (VPID). */
  readonly vmpId: string;
  /** The AMP's dm+d identifier (APID) when a named brand or supplier's product is meant. */
  readonly ampId: string | null;
  /** The dm+d description, shown as dm+d words it. */
  readonly name: string;
}

/** A route of administration from the dm+d route lookup (for example "Oral"). */
export interface DmdRoute {
  readonly code: string;
  readonly name: string;
}

// Verhoeff dihedral group tables (SNOMED CT technical implementation guide, check digit).
const VERHOEFF_D: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

function verhoeffValid(digits: string): boolean {
  let check = 0;
  const reversed = [...digits].reverse();
  for (let i = 0; i < reversed.length; i++) {
    const row = VERHOEFF_P[i % 8] as readonly number[];
    check = (VERHOEFF_D[check] as readonly number[])[row[Number(reversed[i])] as number] as number;
  }
  return check === 0;
}

/** Concept partitions: "00" short format (international), "10" long format (an extension such as dm+d's). */
const CONCEPT_PARTITIONS = new Set(["00", "10"]);

/**
 * True when a value has the shape of a dm+d (SNOMED CT concept) identifier: 6 to 18 digits with
 * no leading zero, a concept partition and a valid Verhoeff check digit. It says nothing about
 * whether the product exists: the reference data does that.
 */
export function isDmdId(value: string): boolean {
  if (!/^[1-9]\d{5,17}$/.test(value)) return false;
  if (!CONCEPT_PARTITIONS.has(value.slice(-3, -1))) return false;
  return verhoeffValid(value);
}

/** True when a product reference names a dm+d product, never free text. */
export function isDmdProduct(product: DmdProductRef): boolean {
  if (!isDmdId(product.vmpId)) return false;
  if (product.ampId !== null && !isDmdId(product.ampId)) return false;
  return product.name.trim().length > 0;
}

/**
 * How two dm+d products differ, by identity only: a different VMP is a different product; the
 * same VMP with two different AMPs is a different brand. Ingredients are never compared.
 */
export function dmdProductDifference(
  a: DmdProductRef,
  b: DmdProductRef,
): "product" | "brand" | null {
  if (a.vmpId !== b.vmpId) return "product";
  if (a.ampId !== null && b.ampId !== null && a.ampId !== b.ampId) return "brand";
  return null;
}
