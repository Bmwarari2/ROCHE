import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import { addDays, addMonths } from "./dates";
import { resolveWorkforceRates } from "./rates";
import { intervalMonths, nextMeeting, type SupervisionRecord } from "./supervision";

const rates = resolveWorkforceRates(readRateTable(), "england", "2026-10-31", null);
const STARTED = "2026-01-12";

describe("supervision and appraisal (workforce.md rule 7)", () => {
  it.each([
    [6, 2],
    [4, 3],
    [1, 12],
    [12, 1],
    [24, 1],
  ])("%i a year means one every %i months", (perYear, months) => {
    expect(intervalMonths(perYear)).toBe(months);
  });

  it("refuses a number a year of zero", () => {
    expect(() => intervalMonths(0)).toThrow(RangeError);
  });

  it("is due one interval after the start date when none has been held", () => {
    const due = addMonths(STARTED, intervalMonths(rates.supervisionsPerYear));
    expect(
      nextMeeting("supervision", [], STARTED, rates.supervisionsPerYear, "2026-01-20"),
    ).toEqual({
      kind: "supervision",
      dueOn: due,
      state: "upcoming",
    });
  });

  it("is due one interval after the last held, never counting spot checks", () => {
    const records: SupervisionRecord[] = [
      { kind: "supervision", heldOn: "2026-05-04" },
      { kind: "spot_check", heldOn: "2026-09-01" },
      { kind: "appraisal", heldOn: "2026-02-01" },
    ];
    const due = addMonths("2026-05-04", intervalMonths(rates.supervisionsPerYear));
    expect(nextMeeting("supervision", records, STARTED, rates.supervisionsPerYear, due).state).toBe(
      "due",
    );
    expect(
      nextMeeting("supervision", records, STARTED, rates.supervisionsPerYear, addDays(due, 1))
        .state,
    ).toBe("overdue");
    expect(
      nextMeeting("appraisal", records, STARTED, rates.appraisalsPerYear, "2026-10-31").dueOn,
    ).toBe(addMonths("2026-02-01", intervalMonths(rates.appraisalsPerYear)));
  });

  it("shows as due within a window before the date", () => {
    const due = addMonths(STARTED, intervalMonths(rates.supervisionsPerYear));
    expect(
      nextMeeting("supervision", [], STARTED, rates.supervisionsPerYear, addDays(due, -7), 7).state,
    ).toBe("due");
    expect(
      nextMeeting("supervision", [], STARTED, rates.supervisionsPerYear, addDays(due, -8), 7).state,
    ).toBe("upcoming");
  });
});
