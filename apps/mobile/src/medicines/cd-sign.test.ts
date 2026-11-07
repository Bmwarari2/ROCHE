import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signCdDose } from "./cd-sign";
import { newWrappedKey } from "./device-key";

const random = (n: number) => new Uint8Array(randomBytes(n));
const recorderKey = { ...newWrappedKey("recorder", "482916", random), keyId: "k1" };
const witnessKey = { ...newWrappedKey("witness", "739215", random), keyId: "k2" };
const dose = {
  tenantId: "t",
  deviceId: "d",
  personId: "p",
  entryId: "e",
  administrationId: "a",
  quantity: 1,
  unitCode: "u",
};
const NOW = new Date("2026-11-07T10:00:00Z");

describe("hazard HZ-116 a controlled drug is signed on the phone by two people with their own PINs", () => {
  it("signs for both when both PINs open their keys", () => {
    const r = signCdDose({
      recorderKey,
      recorderPin: "482916",
      witnessKey,
      witnessPin: "739215",
      dose,
      now: NOW,
    });
    expect(r.kind).toBe("signed");
    if (r.kind === "signed") {
      expect(r.signatures.witness.witnessId).toBe("witness");
      expect(r.signatures.recorder.keyId).toBe("k1");
    }
  });

  it.each([
    ["the witness's wrong PIN", "482916", "000000", { kind: "wrong_pin", who: "witness" }],
    ["the recorder's wrong PIN", "000000", "739215", { kind: "wrong_pin", who: "recorder" }],
  ] as const)("signs nothing with %s, and counts it on that key", (_case, rp, wp, problem) => {
    const r = signCdDose({
      recorderKey,
      recorderPin: rp,
      witnessKey,
      witnessPin: wp,
      dose,
      now: NOW,
    });
    expect(r).toMatchObject({ kind: "refused", problem });
    expect(r.keys.find((k) => k.memberId === problem.who)?.failures).toBe(1);
  });

  it("needs a witness with a PIN on this phone", () => {
    const r = signCdDose({
      recorderKey,
      recorderPin: "482916",
      witnessKey: null,
      witnessPin: "",
      dose,
      now: NOW,
    });
    expect(r).toMatchObject({ kind: "refused", problem: { kind: "no_key", who: "witness" } });
  });
});
