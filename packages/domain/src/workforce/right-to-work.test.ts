import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import { addDays } from "./dates";
import { resolveWorkforceRates } from "./rates";
import { checkedLate, mayWork, rightToWorkStatus } from "./right-to-work";

const window = resolveWorkforceRates(
  readRateTable(),
  "england",
  "2026-10-31",
  null,
).reminderDaysFirst;
const TODAY = "2026-10-31";

describe("right to work (workforce.md rule 2)", () => {
  it("has none with no check, or a check dated in the future", () => {
    expect(rightToWorkStatus([], TODAY, window)).toEqual({ kind: "none" });
    expect(
      rightToWorkStatus(
        [{ checkedOn: addDays(TODAY, 1), permission: "unlimited", expiresOn: null }],
        TODAY,
        window,
      ),
    ).toEqual({ kind: "none" });
  });

  it("needs no follow-up for an unlimited permission", () => {
    const status = rightToWorkStatus(
      [{ checkedOn: "2025-01-10", permission: "unlimited", expiresOn: null }],
      TODAY,
      window,
    );
    expect(status).toEqual({ kind: "valid", followUpDueOn: null });
    expect(mayWork(status)).toBe(true);
  });

  it.each([
    [window + 1, "valid", true],
    [window, "follow_up_due", true],
    [0, "follow_up_due", true],
    [-1, "lapsed", false],
  ] as const)("a time-limited permission %i days from expiry is %s", (daysLeft, kind, works) => {
    const status = rightToWorkStatus(
      [
        {
          checkedOn: "2025-01-10",
          permission: "time_limited",
          expiresOn: addDays(TODAY, daysLeft),
        },
      ],
      TODAY,
      window,
    );
    expect(status.kind).toBe(kind);
    expect(mayWork(status)).toBe(works);
  });

  it("goes by the latest check: a follow-up clears a lapse", () => {
    const status = rightToWorkStatus(
      [
        { checkedOn: "2025-01-10", permission: "time_limited", expiresOn: "2026-01-10" },
        { checkedOn: "2026-01-09", permission: "unlimited", expiresOn: null },
      ],
      TODAY,
      window,
    );
    expect(status.kind).toBe("valid");
  });

  it("treats a time-limited permission recorded without its expiry as no evidence", () => {
    expect(
      rightToWorkStatus(
        [{ checkedOn: "2025-01-10", permission: "time_limited", expiresOn: null }],
        TODAY,
        window,
      ).kind,
    ).toBe("none");
  });

  it("flags a first check made after the start date", () => {
    expect(checkedLate("2026-03-02", "2026-03-01")).toBe(true);
    expect(checkedLate("2026-03-01", "2026-03-01")).toBe(false);
  });
});
