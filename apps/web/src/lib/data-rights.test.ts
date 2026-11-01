import { describe, expect, it } from "vitest";
import { dataRightsShown } from "./data-rights";

describe("PLAT-022 data rights screens are offered only organisation-wide", () => {
  it.each([
    { permissions: ["quality.dsar.manage"], scope: "tenant", shown: true },
    { permissions: ["quality.dsar.manage"], scope: "locations", shown: false },
    { permissions: ["quality.dsar.manage"], scope: "assigned", shown: false },
    { permissions: ["platform.dpia.read"], scope: "tenant", shown: false },
    { permissions: [], scope: "none", shown: false },
  ] as const)("$permissions with scope $scope: $shown", ({ permissions, scope, shown }) => {
    expect(dataRightsShown({ permissions: [...permissions], scope })).toBe(shown);
  });
});
