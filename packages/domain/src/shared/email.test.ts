import { describe, expect, it } from "vitest";
import { isPlausibleEmail, normaliseEmail } from "./email";

describe("isPlausibleEmail", () => {
  it.each([
    ["ada.inspector@example.invalid", true],
    ["  Ada.Inspector@Example.Invalid  ", true],
    ["a@example.invalid", true],
    ["", false],
    [null, false],
    ["no-at-sign.example.invalid", false],
    ["@example.invalid", false],
    ["ada@", false],
    ["ada@example", false],
    ["ada@@example.invalid", false],
    ["ada@ex@ample.invalid", false],
    ["ada@.example.invalid", false],
    ["ada@example.invalid.", false],
    ["ada@example..invalid", false],
    ["ada inspector@example.invalid", false],
    ["Ada <ada@example.invalid>", false],
    ["ada@example.invalid,ben@example.invalid", false],
    ["ada\r\n@example.invalid", false],
    ["аda@example.invalid", false],
    ["ada@Kexample.invalid", false],
    ["adé@example.invalid", false],
    [`${"a".repeat(65)}@example.invalid`, false],
    [`ada@${"e".repeat(250)}.invalid`, false],
  ])("%s is plausible: %s", (value, expected) => {
    expect(isPlausibleEmail(value)).toBe(expected);
  });

  it("stays fast on long hostile input", () => {
    const hostile = `${"a.".repeat(50_000)}@`;
    const started = Date.now();
    expect(isPlausibleEmail(hostile)).toBe(false);
    expect(Date.now() - started).toBeLessThan(200);
  });
});

describe("normaliseEmail", () => {
  it("trims and lower-cases ASCII letters for comparison", () => {
    expect(normaliseEmail("  Ada@Example.INVALID ")).toBe("ada@example.invalid");
  });

  it("never folds other scripts into ASCII", () => {
    expect(normaliseEmail("Kate@example.invalid")).toBe("Kate@example.invalid");
    expect(normaliseEmail("Kate@example.invalid")).not.toBe(normaliseEmail("kate@example.invalid"));
  });
});
