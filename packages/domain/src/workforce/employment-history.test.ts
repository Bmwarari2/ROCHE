import { describe, expect, it } from "vitest";
import { employmentGaps, type HistoryPeriod } from "./employment-history";

describe("employment history gaps by month (workforce.md rule 4)", () => {
  it.each<[string, HistoryPeriod[], { from: string; to: string; months: number }[]]>([
    ["continuous work, still in the job", [{ from: "2020-01", to: null, kind: "employment" }], []],
    [
      "a one-month gap",
      [
        { from: "2020-01", to: "2023-05", kind: "employment" },
        { from: "2023-07", to: null, kind: "employment" },
      ],
      [{ from: "2023-06", to: "2023-06", months: 1 }],
    ],
    [
      "overlapping jobs and education",
      [
        { from: "2020-01", to: "2022-12", kind: "education" },
        { from: "2022-06", to: null, kind: "employment" },
      ],
      [],
    ],
    [
      "an explained gap",
      [
        { from: "2020-01", to: "2021-12", kind: "employment" },
        {
          from: "2022-01",
          to: "2022-08",
          kind: "explained_gap",
          explanation: "Caring for a relative",
        },
        { from: "2022-09", to: null, kind: "employment" },
      ],
      [],
    ],
    [
      "a gap 'explained' with no words",
      [
        { from: "2020-01", to: "2021-12", kind: "employment" },
        { from: "2022-01", to: "2022-03", kind: "explained_gap", explanation: "  " },
        { from: "2022-04", to: null, kind: "employment" },
      ],
      [{ from: "2022-01", to: "2022-03", months: 3 }],
    ],
    [
      "nothing since the last job up to the application",
      [{ from: "2020-01", to: "2026-06", kind: "employment" }],
      [{ from: "2026-07", to: "2026-10", months: 4 }],
    ],
    [
      "a gap at the start of the history",
      [{ from: "2020-04", to: null, kind: "employment" }],
      [{ from: "2020-01", to: "2020-03", months: 3 }],
    ],
  ])("%s", (_, periods, gaps) => {
    expect(employmentGaps(periods, "2020-01", "2026-10")).toEqual(gaps);
  });

  it("finds nothing when the application is before the history starts", () => {
    expect(employmentGaps([], "2026-10", "2026-01")).toEqual([]);
  });
});
