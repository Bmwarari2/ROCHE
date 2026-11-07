import { describe, expect, it } from "vitest";
import {
  cdDoseStatementText,
  type DeviceKeyFacts,
  deviceSignatureIssues,
  pairIssues,
} from "./device-signature";

const NOW = new Date("2026-11-07T10:00:00Z");
const MIN = 60_000;
const key: DeviceKeyFacts = {
  keyId: "k1",
  keyMemberId: "witness",
  keyDeviceId: "device",
  enrolledAt: new Date("2026-11-01T08:00:00Z"),
  replacedAt: null,
};
const base = {
  signerId: "witness",
  deviceId: "device",
  signedAt: new Date("2026-11-07T09:00:00Z"),
  key,
  deviceRevokedAt: null,
  verified: true,
  now: NOW,
  toleranceMs: 5 * MIN,
};

describe("hazard HZ-116 a controlled drug signed on one phone offline needs two people's own keys (ADR-0084)", () => {
  it("signs one fixed text, field by field, so phone and server agree", () => {
    const text = cdDoseStatementText({
      tenantId: "t",
      deviceId: "d",
      role: "witness",
      signerId: "w",
      recorderId: "r",
      personId: "p",
      entryId: "e",
      administrationId: "a",
      quantity: 2.5,
      unitCode: "u",
      signedAt: "2026-11-07T09:00:00Z",
    });
    expect(text).toBe(
      "harbour-cd-dose-v1\nt\nd\nwitness\nw\nr\np\ne\na\n2.5\nu\n2026-11-07T09:00:00.000Z",
    );
  });

  it.each([
    ["a signature that stands", {}, []],
    ["another member's key", { signerId: "recorder" }, ["key_not_for_signer"]],
    ["a key from another phone", { deviceId: "other" }, ["key_not_for_signer"]],
    ["no key", { key: null }, ["key_not_for_signer"]],
    [
      "a key replaced before signing",
      { key: { ...key, replacedAt: new Date("2026-11-07T08:00:00Z") } },
      ["key_replaced"],
    ],
    [
      "a key replaced after signing",
      { key: { ...key, replacedAt: new Date("2026-11-07T09:30:00Z") } },
      [],
    ],
    [
      "a phone revoked before signing",
      { deviceRevokedAt: new Date("2026-11-07T08:00:00Z") },
      ["device_revoked"],
    ],
    [
      "a signature before the key",
      { signedAt: new Date("2026-10-31T08:00:00Z") },
      ["signed_before_enrolment"],
    ],
    [
      "a signature in the future",
      { signedAt: new Date("2026-11-07T10:30:00Z") },
      ["signed_in_future"],
    ],
    ["a signature that does not verify", { verified: false }, ["signature_invalid"]],
  ] as const)("%s", (_case, change, issues) => {
    expect(
      deviceSignatureIssues({ ...base, ...change } as Parameters<typeof deviceSignatureIssues>[0]),
    ).toEqual(issues);
  });

  it.each([
    ["two people close together", "r", "w", 2, []],
    ["one person signing twice", "r", "r", 2, ["witness_is_recorder"]],
    ["signatures far apart", "r", "w", 90, ["signed_too_long_apart"]],
  ] as const)("%s", (_case, recorderId, witnessId, minutesApart, issues) => {
    expect(
      pairIssues({
        recorderId,
        witnessId,
        recorderSignedAt: NOW,
        witnessSignedAt: new Date(NOW.getTime() + minutesApart * MIN),
        apartMs: 30 * MIN,
      }),
    ).toEqual(issues);
  });
});
