import { describe, expect, it } from "vitest";
import { type CompetenceRow, phoneCompetence } from "./my-competence";

const at = new Date("2026-11-08T10:00:00Z");
const row = (
  id: string,
  observed_on: string,
  valid_until: string,
  withdrawn_at: string | null = null,
): CompetenceRow => ({ id, observed_on, valid_until, withdrawn_at });

describe("hazard HZ-119 the phone knows the member's own medicines competence before a dose", () => {
  it.each([
    ["a sign-off in date", [row("a", "2026-03-01", "2027-02-28")], "current"],
    ["a sign-off past its valid-until day", [row("a", "2025-10-01", "2026-09-30")], "expired"],
    ["no sign-off", [], "not_held"],
    [
      "a withdrawn sign-off",
      [row("a", "2026-03-01", "2027-02-28", "2026-10-01T09:00:00Z")],
      "withdrawn",
    ],
    [
      "an older sign-off still in date when a newer one is withdrawn",
      [
        row("a", "2026-01-01", "2026-12-31"),
        row("b", "2026-06-01", "2027-05-31", "2026-10-01T09:00:00Z"),
      ],
      "withdrawn",
    ],
    [
      "a new sign-off after a withdrawal",
      [
        row("a", "2026-03-01", "2027-02-28", "2026-10-01T09:00:00Z"),
        row("b", "2026-10-15", "2027-10-14"),
      ],
      "current",
    ],
    ["a sign-off dated in the future", [row("a", "2026-12-01", "2027-11-30")], "not_held"],
  ] as const)("%s", (_case, rows, state) => {
    expect(phoneCompetence(rows, at)).toBe(state);
  });
});
