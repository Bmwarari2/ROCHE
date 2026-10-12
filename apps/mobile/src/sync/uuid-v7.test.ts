import { describe, expect, it } from "vitest";
import { isUuidV7, type RandomBytes, uuidV7, uuidV7Time } from "./uuid-v7";

// Tests only need varied bytes; the app passes expo-crypto's secure source.
const secure: RandomBytes = (length) =>
  Uint8Array.from({ length }, () => Math.floor(Math.random() * 256));
const fixed =
  (value: number): RandomBytes =>
  (length) =>
    new Uint8Array(length).fill(value);

describe("uuidV7 (device ids for offline writes)", () => {
  it("encodes the time, version 7 and the RFC 9562 variant", () => {
    const at = Date.parse("2026-10-11T09:30:00.123Z");
    const id = uuidV7(at, fixed(0xff));
    expect(isUuidV7(id)).toBe(true);
    expect(id[14]).toBe("7");
    expect(id[19]).toBe("b");
    expect(uuidV7Time(id)?.toISOString()).toBe("2026-10-11T09:30:00.123Z");
  });

  it("matches RFC 9562's layout with zero random bits", () => {
    expect(uuidV7(0x017f22e279b0, fixed(0))).toBe("017f22e2-79b0-7000-8000-000000000000");
  });

  it("sorts by creation time", () => {
    const ids = [3, 1, 2].map((offset) => uuidV7(1_760_000_000_000 + offset, secure));
    expect([...ids].sort()).toEqual([ids[1], ids[2], ids[0]]);
  });

  it("does not repeat in the same millisecond", () => {
    const ids = new Set(Array.from({ length: 2000 }, () => uuidV7(1_760_000_000_000, secure)));
    expect(ids.size).toBe(2000);
  });

  it.each([-1, 1.5, 2 ** 48, Number.NaN])("refuses the clock reading %s", (ms) => {
    expect(() => uuidV7(ms, secure)).toThrow(RangeError);
  });

  it("refuses a short random source", () => {
    expect(() => uuidV7(0, () => new Uint8Array(8))).toThrow(RangeError);
  });

  it.each(["", "not-a-uuid", "017f22e2-79b0-4000-8000-000000000000"])(
    "does not read a time from %j",
    (value) => {
      expect(uuidV7Time(value)).toBeNull();
    },
  );
});
