import { createPublicKey, randomBytes, verify } from "node:crypto";
import { cdDoseStatementText } from "@harbour/domain";
import { describe, expect, it } from "vitest";
import { newWrappedKey, PIN_FREE_ATTEMPTS, pinProblems, signText, unlockKey } from "./device-key";

const random = (n: number) => new Uint8Array(randomBytes(n));
const NOW = new Date("2026-11-07T10:00:00Z");

describe("a member's medicines PIN on this phone (ADR-0084)", () => {
  it.each([
    ["482916", "482916", []],
    ["4829", "4829", ["too_short"]],
    ["111111", "111111", ["all_same"]],
    ["123456", "123456", ["sequence"]],
    ["987654", "987654", ["sequence"]],
    ["48a916", "48a916", ["not_digits"]],
    ["482916", "482917", ["mismatch"]],
  ] as const)("%s", (pin, confirm, problems) => {
    expect(pinProblems(pin, confirm)).toEqual(problems);
  });
});

describe("hazard HZ-116 a signature made on the phone is one the API verifies", () => {
  const sealed = { ...newWrappedKey("member-1", "482916", random), keyId: "k1" };

  it("opens with the right PIN and signs text the server verifies with node:crypto", () => {
    const opened = unlockKey(sealed, "482916", NOW);
    if (opened.kind !== "unlocked") throw new Error("not unlocked");
    const text = cdDoseStatementText({
      tenantId: "t",
      deviceId: "d",
      role: "witness",
      signerId: "member-1",
      recorderId: "member-2",
      personId: "p",
      entryId: "e",
      administrationId: "a",
      quantity: 1,
      unitCode: "u",
      signedAt: NOW.toISOString(),
    });
    const raw = Buffer.from(sealed.publicKey, "base64");
    const key = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: raw.subarray(1, 33).toString("base64url"),
        y: raw.subarray(33).toString("base64url"),
      },
      format: "jwk",
    });
    const signature = Buffer.from(signText(opened.secret, text), "base64");
    expect(verify("sha256", Buffer.from(text), { key, dsaEncoding: "ieee-p1363" }, signature)).toBe(
      true,
    );
    expect(
      verify("sha256", Buffer.from(`${text}x`), { key, dsaEncoding: "ieee-p1363" }, signature),
    ).toBe(false);
  });

  it("throttles wrong PINs after a few, doubling, and never for good", () => {
    let key = sealed;
    for (let i = 0; i < PIN_FREE_ATTEMPTS; i++) {
      const r = unlockKey(key, "000000", NOW);
      if (r.kind !== "wrong_pin") throw new Error("expected wrong pin");
      key = r.key;
    }
    expect(key.waitUntil).toBeNull();
    const sixth = unlockKey(key, "000000", NOW);
    if (sixth.kind !== "wrong_pin") throw new Error("expected wrong pin");
    expect(sixth.key.waitUntil).not.toBeNull();
    expect(unlockKey(sixth.key, "482916", NOW).kind).toBe("wait");
    const later = new Date(new Date(sixth.key.waitUntil as string).getTime() + 1);
    const right = unlockKey(sixth.key, "482916", later);
    expect(right.kind).toBe("unlocked");
    if (right.kind === "unlocked") expect(right.key.failures).toBe(0);
  });
});
