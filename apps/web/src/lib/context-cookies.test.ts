import { describe, expect, it } from "vitest";
import { contextCookieOptions, isUuid, selectLocation, selectTenant } from "./context-cookies";

const A = "0194d000-0000-7000-8000-000000000001";
const B = "0194d000-0000-7000-8000-000000000002";
const C = "0194d000-0000-7000-8000-000000000003";
const memberships = [
  { tenantId: A, tenantName: "Harbour Example Care" },
  { tenantId: B, tenantName: "Sample Homecare" },
];

describe("selectTenant", () => {
  it.each([
    ["no memberships", A, [], { kind: "none" }],
    [
      "cookie names a membership",
      B,
      memberships,
      { kind: "selected", tenantId: B, fromCookie: true },
    ],
    ["no cookie, several memberships", undefined, memberships, { kind: "choose" }],
    ["stale cookie, several memberships", C, memberships, { kind: "choose" }],
    ["empty cookie, several memberships", "", memberships, { kind: "choose" }],
    [
      "no cookie, one membership",
      undefined,
      memberships.slice(0, 1),
      { kind: "selected", tenantId: A, fromCookie: false },
    ],
    [
      "stale cookie, one membership",
      C,
      memberships.slice(0, 1),
      { kind: "selected", tenantId: A, fromCookie: false },
    ],
  ] as const)("%s", (_name, cookie, items, expected) => {
    expect(selectTenant(cookie, items)).toEqual(expected);
  });
});

describe("selectLocation", () => {
  const locations = [{ id: A }, { id: B }];
  it("keeps a location the person can see", () => {
    expect(selectLocation(B, locations)).toBe(B);
  });
  it("falls back to all locations for a missing, stale or foreign location", () => {
    expect(selectLocation(undefined, locations)).toBeNull();
    expect(selectLocation(null, locations)).toBeNull();
    expect(selectLocation(C, locations)).toBeNull();
    expect(selectLocation(A, [])).toBeNull();
  });
});

describe("contextCookieOptions", () => {
  it("makes the tenant cookie httpOnly and leaves the location readable", () => {
    expect(contextCookieOptions("tenant", true)).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
    });
    expect(contextCookieOptions("location", false)).toMatchObject({
      httpOnly: false,
      secure: false,
    });
  });
});

describe("isUuid", () => {
  it.each([
    [A, true],
    ["not-a-uuid", false],
    [`${A}; Path=/`, false],
    [42, false],
    [null, false],
  ])("%s is %s", (value, expected) => {
    expect(isUuid(value)).toBe(expected);
  });
});
