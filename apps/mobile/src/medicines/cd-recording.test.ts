import { describe, expect, it } from "vitest";
import {
  CD_RECORDING_FLAG,
  cdRecordingFromMeta,
  cdRecordingMetaValue,
  fetchCdRecording,
  parseCdRecordingFlags,
} from "./cd-recording";

const HOME = "01890000-0000-7000-8000-0000000000e1";
const OTHER = "01890000-0000-7000-8000-0000000000e2";
const AT = new Date("2026-11-08T09:00:00.000Z");

describe("hazard HZ-115 the phone records a controlled drug only where recording is turned on (H-1517)", () => {
  it.each([
    ["turned on", { locationId: HOME, flags: { [CD_RECORDING_FLAG]: true } }, true],
    ["turned off", { locationId: HOME, flags: { [CD_RECORDING_FLAG]: false } }, false],
    ["missing from the flags", { locationId: HOME, flags: {} }, null],
    ["not a yes or no", { locationId: HOME, flags: { [CD_RECORDING_FLAG]: "yes" } }, null],
    ["for another home", { locationId: OTHER, flags: { [CD_RECORDING_FLAG]: true } }, null],
    ["not an object", "on", null],
    ["empty", null, null],
  ] as const)("reads a flags answer %s", (_case, body, expected) => {
    expect(parseCdRecordingFlags(body, HOME)).toBe(expected);
  });

  it.each([
    ["kept as on", cdRecordingMetaValue(true, AT), "on"],
    ["kept as off", cdRecordingMetaValue(false, AT), "off"],
    ["never read", null, "unknown"],
    ["unreadable", "{not json", "unknown"],
    ["without when it was read", JSON.stringify({ enabled: true }), "unknown"],
    ["with no answer", JSON.stringify({ readAt: AT.toISOString() }), "unknown"],
  ] as const)("takes a kept answer %s as %s", (_case, value, expected) => {
    expect(cdRecordingFromMeta(value)).toBe(expected);
  });

  it.each([
    ["a refusal", () => new Response("{}", { status: 404 })],
    [
      "no connection",
      () => {
        throw new TypeError("offline");
      },
    ],
  ] as const)("reads nothing on %s, so the kept answer stands", async (_case, answer) => {
    const got = await fetchCdRecording(
      {
        apiUrl: "https://api.example.invalid",
        fetch: async () => answer(),
        token: "tok",
        tenantId: "t1",
        deviceId: "d1",
      },
      HOME,
    );
    expect(got).toBeNull();
  });

  it("asks for the home's own flags", async () => {
    const urls: string[] = [];
    const got = await fetchCdRecording(
      {
        apiUrl: "https://api.example.invalid",
        fetch: async (url) => {
          urls.push(url);
          return new Response(
            JSON.stringify({ locationId: HOME, flags: { [CD_RECORDING_FLAG]: true } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
        token: "tok",
        tenantId: "t1",
        deviceId: "d1",
      },
      HOME,
    );
    expect(got).toBe(true);
    expect(urls).toEqual([`https://api.example.invalid/v1/me/locations/${HOME}/flags`]);
  });
});

describe("hazard HZ-115 the phone says how old its answer is", () => {
  it("keeps when it read the switch, and nothing for an answer it cannot read", async () => {
    const { cdRecordingMetaValue, cdRecordingReadAt } = await import("./cd-recording");
    const at = new Date("2026-11-08T09:00:00.000Z");
    expect(cdRecordingReadAt(cdRecordingMetaValue(false, at))).toBe(at.toISOString());
    expect(cdRecordingReadAt(null)).toBeNull();
    expect(cdRecordingReadAt("not json")).toBeNull();
  });
});
