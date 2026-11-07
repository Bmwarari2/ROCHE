import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type CdDoseFields, signAs } from "./cd-sign";
import { newWrappedKey } from "./device-key";

const random = (n: number) => new Uint8Array(randomBytes(n));
const recorderKey = { ...newWrappedKey("recorder", "482916", random), keyId: "k1" };
const witnessKey = { ...newWrappedKey("witness", "739215", random), keyId: "k2" };
const dose: CdDoseFields = {
  tenantId: "t",
  deviceId: "d",
  recorderId: "recorder",
  personId: "p",
  entryId: "e",
  administrationId: "a",
  vmpId: "1000001",
  givenAt: "2026-11-07T10:00:00.000Z",
  quantity: 1,
  unitCode: "u",
};
const NOW = new Date("2026-11-07T10:00:00Z");

describe("hazard HZ-116 a controlled drug is signed on the phone by two people with their own PINs", () => {
  it("signs as the witness first, then as the recorder, each with their own key", () => {
    const w = signAs("witness", witnessKey, "739215", dose, NOW);
    const r = signAs("recorder", recorderKey, "482916", dose, new Date(NOW.getTime() + 60_000));
    expect(w).toMatchObject({ kind: "signed", signature: { keyId: "k2" } });
    expect(r).toMatchObject({ kind: "signed", signature: { keyId: "k1" } });
  });

  it("signs nothing with a wrong PIN, and counts it on that key", () => {
    const w = signAs("witness", witnessKey, "000000", dose, NOW);
    expect(w).toMatchObject({ kind: "refused", problem: { kind: "wrong_pin", who: "witness" } });
    expect(w.key?.failures).toBe(1);
  });

  it("needs a witness with a PIN on this phone", () => {
    expect(signAs("witness", null, "", dose, NOW)).toMatchObject({
      kind: "refused",
      problem: { kind: "no_key", who: "witness" },
    });
  });
});
