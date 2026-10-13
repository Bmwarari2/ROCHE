import { describe, expect, it } from "vitest";
import type { RateRow } from "./rates";
import {
  activityDue,
  IDLE_TIMEOUT_CEILING_KEY,
  IDLE_TIMEOUT_FLOOR_KEY,
  IDLE_TIMEOUT_RATE_KEY,
  idleExpired,
  idleTimeoutMinutes,
} from "./sessions";

const TENANT = "tenant-a";
const ON = "2026-10-13";

function row(key: string, value: number, tenantId: string | null = null): RateRow {
  return {
    key,
    value,
    unit: "minutes",
    nation: "all",
    validFrom: "2000-01-01",
    validTo: null,
    tenantId,
    verificationStatus: "to-verify",
    source: "test",
  };
}

const KEY = IDLE_TIMEOUT_RATE_KEY;
const GLOBAL = [row(KEY, 30), row(`${KEY}.owner`, 15)];

describe("idle timeout per role (section 5.3)", () => {
  it.each([
    ["no role reads the default", GLOBAL, [], 30],
    ["a role without its own row reads the default", GLOBAL, ["care_worker"], 30],
    ["a role with its own row reads it", GLOBAL, ["owner"], 15],
    ["several roles take the strictest", GLOBAL, ["care_worker", "owner"], 15],
    [
      "the organisation's override of a role wins",
      [...GLOBAL, row(`${KEY}.owner`, 10, TENANT)],
      ["owner"],
      10,
    ],
    [
      "the organisation's default applies to roles without a row",
      [...GLOBAL, row(KEY, 20, TENANT)],
      ["care_worker", "owner"],
      15,
    ],
    [
      "another organisation's override is ignored",
      [...GLOBAL, row(KEY, 5, "tenant-b"), row(`${KEY}.owner`, 5, "tenant-b")],
      ["care_worker", "owner"],
      15,
    ],
  ] as const)("%s", (_name, rows, roles, expected) => {
    expect(idleTimeoutMinutes(rows, roles, TENANT, ON)).toBe(expected);
  });

  // #40 review: a missing or invalid figure never refuses a request.
  it.each([
    ["no default and no role row: not enforced", [row(`${KEY}.owner`, 15)], ["care_worker"], null],
    ["no rows at all: not enforced", [], [], null],
    ["a zero role figure takes the default", [row(KEY, 30), row(`${KEY}.owner`, 0)], ["owner"], 30],
    [
      "a negative role figure takes the default",
      [row(KEY, 30), row(`${KEY}.owner`, -5)],
      ["owner"],
      30,
    ],
    [
      "a role figure that is not a number takes the default",
      [row(KEY, 30), row(`${KEY}.owner`, Number.NaN)],
      ["owner"],
      30,
    ],
    ["a zero default with no role row: not enforced", [row(KEY, 0)], ["care_worker"], null],
    [
      "a figure under the floor is raised to it",
      [row(KEY, 30), row(`${KEY}.owner`, 1), row(IDLE_TIMEOUT_FLOOR_KEY, 5)],
      ["owner"],
      5,
    ],
    [
      "a figure over the ceiling is lowered to it",
      [row(KEY, 2000), row(IDLE_TIMEOUT_CEILING_KEY, 720)],
      ["care_worker"],
      720,
    ],
    [
      "an organisation's figure is kept within the floor and ceiling",
      [
        row(KEY, 30),
        row(KEY, 2, TENANT),
        row(IDLE_TIMEOUT_FLOOR_KEY, 5),
        row(IDLE_TIMEOUT_CEILING_KEY, 720),
      ],
      ["care_worker"],
      5,
    ],
  ] as const)("%s", (_name, rows, roles, expected) => {
    expect(idleTimeoutMinutes(rows, roles, TENANT, ON)).toBe(expected);
  });
});

describe("idle expiry and activity", () => {
  const last = new Date("2026-10-13T09:00:00Z");
  const at = (minutes: number, seconds = 0) =>
    new Date(last.getTime() + minutes * 60_000 + seconds * 1000);

  it.each([
    ["used within the timeout", at(29, 59), false],
    ["exactly at the timeout", at(30), false],
    ["past the timeout", at(30, 1), true],
  ] as const)("%s", (_name, now, expired) => {
    expect(idleExpired(last, now, 30)).toBe(expired);
  });

  it.each([
    ["under a minute later", at(0, 59), false],
    ["a minute later", at(1), true],
  ] as const)("records activity %s", (_name, now, due) => {
    expect(activityDue(last, now)).toBe(due);
  });
});
