import { describe, expect, it } from "vitest";
import { UNIT } from "../../test/medicines-fixtures";
import { dmdProductDifference, isDmdId, isDmdProduct } from "./dmd";
import {
  checkDose,
  type Dose,
  type DoseQuantityProblem,
  doseUnitName,
  formatDose,
  formatDoseQuantity,
  isDoseQuantity,
  parseDoseQuantity,
} from "./dose";

const unit = (name: string) => ({ code: `uom-${name}`, name });
const amount = (quantity: number, name: string): Dose => ({
  kind: "amount",
  quantity,
  unit: unit(name),
});

describe("hazard HZ-005 formats doses with a leading zero, no trailing zero and micrograms in full", () => {
  it.each<[Dose, string]>([
    [amount(0.5, "microgram"), "0.5 micrograms"],
    [amount(1, "microgram"), "1 microgram"],
    [amount(25, "mcg"), "25 micrograms"],
    [amount(25, "µg"), "25 micrograms"],
    [amount(25, "μg"), "25 micrograms"],
    [amount(25, "ug"), "25 micrograms"],
    [amount(5, "ng"), "5 nanograms"],
    [amount(1, "nanogram"), "1 nanogram"],
    [amount(10, "u"), "10 units"],
    [amount(10, "IU"), "10 units"],
    [amount(1, "international unit"), "1 unit"],
    [amount(5000, "unit"), "5000 units"],
    [amount(5, "mg"), "5 mg"],
    [amount(1, "mg"), "1 mg"],
    [amount(2.5, "ml"), "2.5 ml"],
    [amount(1.25, "mg"), "1.25 mg"],
    [amount(0.125, "mg"), "0.125 mg"],
    [amount(2, "tablet"), "2 tablets"],
    [amount(1, "tablet"), "1 tablet"],
    [amount(0.5, "tablet"), "0.5 tablets"],
    [amount(2, "patch"), "2 patches"],
    [amount(1, "patch"), "1 patch"],
    [amount(2, "pessary"), "2 pessaries"],
    [amount(3, "spray"), "3 sprays"],
    [amount(2, "unit dose"), "2 unit doses"],
    [amount(2, "gram"), "2 grams"],
    [amount(2, "5ml spoonful"), "2 5ml spoonful"],
    [{ kind: "range", from: 1, to: 2, unit: unit("tablet") }, "1 to 2 tablets"],
    [{ kind: "range", from: 0.5, to: 1, unit: unit("tablet") }, "0.5 to 1 tablet"],
    [{ kind: "range", from: 5, to: 10, unit: unit("ml") }, "5 to 10 ml"],
    [{ kind: "variable", unit: unit("mg") }, "As on the current dosing record, in mg"],
    [{ kind: "variable", unit: unit("tablet") }, "As on the current dosing record, in tablets"],
  ])("%o reads %s", (dose, words) => {
    expect(formatDose(dose)).toBe(words);
  });

  it.each([
    [0.5, "0.5"],
    [5, "5"],
    [10, "10"],
    [2.25, "2.25"],
    [0.001, "0.001"],
    [1234567, "1234567"],
  ])("writes %d as %s", (value, text) => {
    expect(formatDoseQuantity(value)).toBe(text);
  });

  it.each([0, -1, 0.0005, Number.NaN, Number.POSITIVE_INFINITY, 12345678])(
    "refuses to write %d as a dose",
    (value) => {
      expect(isDoseQuantity(value)).toBe(false);
      expect(() => formatDoseQuantity(value)).toThrow(RangeError);
    },
  );

  it("never abbreviates micrograms, nanograms or units, whatever the source calls them", () => {
    for (const name of ["mcg", "MCG", "ug", "ng", "u", "iu", "I.U.", "units"]) {
      expect(doseUnitName(unit(name), false)).toMatch(/^(micrograms|nanograms|units)$/);
    }
  });
});

describe("hazard HZ-005 reads a typed dose only in the form it is shown", () => {
  it.each<[string, number]>([
    ["0.5", 0.5],
    ["5", 5],
    [" 2 ", 2],
    ["2.25", 2.25],
    ["0.125", 0.125],
    ["5000", 5000],
  ])("%s is %d", (text, quantity) => {
    expect(parseDoseQuantity(text)).toEqual({ ok: true, quantity });
  });

  it.each<[string, DoseQuantityProblem, string | null]>([
    ["", "empty", null],
    [".5", "no_leading_zero", "0.5, never .5"],
    [".50", "no_leading_zero", "0.5, never .50"],
    ["5.0", "trailing_zero", "Write 5, never 5.0"],
    ["5.", "trailing_zero", "Write 5, never 5."],
    ["0.50", "trailing_zero", "Write 0.5, never 0.50"],
    ["0.0", "trailing_zero", null],
    ["05", "leading_zeros", "Write 5, never 05"],
    ["1,5", "comma", null],
    ["5,000", "comma", null],
    ["1/2", "not_a_number", null],
    ["½", "not_a_number", null],
    ["two", "not_a_number", null],
    ["-1", "not_a_number", null],
    ["1e3", "not_a_number", null],
    ["0.0005", "too_many_decimals", null],
    ["12345678", "too_large", null],
    ["0", "not_more_than_zero", null],
  ])("%j is refused as %s", (text, problem, words) => {
    const result = parseDoseQuantity(text);
    expect(result).toMatchObject({ ok: false, problem });
    if (words && !result.ok) expect(result.message).toContain(words);
  });
});

describe("hazard HZ-005 rejects a dose whose unit is not permitted for the dm+d product", () => {
  const tablets = [UNIT.tablet, UNIT.mg];

  it("accepts a unit dm+d gives for the product, matched by code", () => {
    expect(checkDose({ kind: "amount", quantity: 2, unit: UNIT.tablet }, tablets)).toEqual([]);
  });

  it("refuses millilitres for a tablet and lists the units dm+d gives", () => {
    const [issue] = checkDose({ kind: "amount", quantity: 5, unit: UNIT.ml }, tablets);
    expect(issue?.problem).toBe("unit_not_permitted");
    expect(issue?.message).toContain("tablets, mg");
  });

  it("matches the unit by its dm+d code, never by its name", () => {
    const lookalike = { code: "uom-other", name: "tablet" };
    expect(checkDose({ kind: "amount", quantity: 1, unit: lookalike }, tablets)[0]?.problem).toBe(
      "unit_not_permitted",
    );
  });

  it("says when dm+d gives no unit for the product", () => {
    expect(checkDose({ kind: "variable", unit: UNIT.mg }, [])[0]?.message).toContain(
      "Check the product chosen",
    );
  });

  it.each<[Dose, string[]]>([
    [{ kind: "amount", quantity: 0, unit: UNIT.tablet }, ["not_a_dose_quantity"]],
    [{ kind: "amount", quantity: 0.0005, unit: UNIT.mg }, ["not_a_dose_quantity"]],
    [{ kind: "range", from: 2, to: 1, unit: UNIT.tablet }, ["range_not_ascending"]],
    [{ kind: "range", from: 1, to: 1, unit: UNIT.tablet }, ["range_not_ascending"]],
    [
      { kind: "range", from: Number.NaN, to: 1, unit: UNIT.ml },
      ["unit_not_permitted", "not_a_dose_quantity", "range_not_ascending"],
    ],
    [{ kind: "variable", unit: UNIT.mg }, []],
  ])("%o gives %o", (dose, problems) => {
    expect(checkDose(dose, tablets).map((i) => i.problem)).toEqual(problems);
  });
});

describe("hazard HZ-005 medicines come from dm+d, never typed", () => {
  it.each([
    ["322236009", true],
    ["42109611000001109", true],
    ["90000011000001104", true],
    ["322236008", false],
    ["90000011000001105", false],
    ["Paracetamol 500mg tablets", false],
    ["012345", false],
    ["12345", false],
    ["1234567890123456789", false],
    ["90000011000001114", false],
  ])("%s is a dm+d identifier: %s", (value, valid) => {
    expect(isDmdId(value)).toBe(valid);
  });

  it("refuses a product without a dm+d VMP, with a bad AMP, or with no name", () => {
    const base = { vmpId: "90000011000001104", ampId: null, name: "Paracetamol 500mg tablets" };
    expect(isDmdProduct(base)).toBe(true);
    expect(isDmdProduct({ ...base, vmpId: "paracetamol" })).toBe(false);
    expect(isDmdProduct({ ...base, ampId: "90000021000001109" })).toBe(false);
    expect(isDmdProduct({ ...base, ampId: "90000021000001108" })).toBe(true);
    expect(isDmdProduct({ ...base, name: " " })).toBe(false);
  });

  it("compares products by identity only: another VMP is another product, never matched by ingredient", () => {
    const tablets = { vmpId: "90000011000001104", ampId: null, name: "Paracetamol 500mg tablets" };
    const capsules = {
      vmpId: "90000041000001103",
      ampId: null,
      name: "Paracetamol 500mg capsules",
    };
    const brandA = { ...tablets, ampId: "90000021000001108" };
    const brandB = { ...tablets, ampId: "90000031000001105" };
    expect(dmdProductDifference(tablets, capsules)).toBe("product");
    expect(dmdProductDifference(brandA, brandB)).toBe("brand");
    expect(dmdProductDifference(tablets, brandA)).toBeNull();
    expect(dmdProductDifference(brandA, brandA)).toBeNull();
  });
});
