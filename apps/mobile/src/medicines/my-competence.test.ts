import { describe, expect, it } from "vitest";
import { phoneCompetence } from "./my-competence";

const rates = { competenceRefreshMonths: 12 };
const at = new Date("2026-11-08T10:00:00Z");

describe("hazard HZ-119 the phone knows the member's own medicines competence before a dose", () => {
  it.each([
    ["a sign-off this year", [{ id: "a", observed_on: "2026-03-01", withdrawn: 0 }], "current"],
    [
      "a sign-off over a year ago",
      [{ id: "a", observed_on: "2025-10-01", withdrawn: 0 }],
      "expired",
    ],
    ["no sign-off", [], "not_held"],
    [
      "a withdrawn sign-off only",
      [{ id: "a", observed_on: "2026-03-01", withdrawn: 1 }],
      "not_held",
    ],
    [
      "an old sign-off and a newer one",
      [
        { id: "a", observed_on: "2024-01-01", withdrawn: 0 },
        { id: "b", observed_on: "2026-06-01", withdrawn: 0 },
      ],
      "current",
    ],
    [
      "a newer sign-off withdrawn, leaving an expired one",
      [
        { id: "a", observed_on: "2025-01-01", withdrawn: 0 },
        { id: "b", observed_on: "2026-06-01", withdrawn: 1 },
      ],
      "expired",
    ],
  ] as const)("%s", (_case, rows, state) => {
    expect(phoneCompetence(rows, at, rates)).toBe(state);
  });

  it("is unknown without the rate table, so nothing is judged on a guess", () => {
    expect(phoneCompetence([], at, null)).toBe("unknown");
  });
});
