// @vitest-environment jsdom
import type { RetentionDue } from "@harbour/contracts";
import axe from "axe-core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RetentionReport } from "./RetentionReport";

/**
 * The retention report's states (retention sweeps slice 5): the journey reaches only "off" on the
 * seeded database (the flag has no screen), so on with no report yet, a report, and the refusal
 * for a role narrower than the organisation are each read in words and checked with axe-core.
 */
async function violations() {
  const results = await axe.run(document.body, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  return results.violations.map((v) => v.id);
}

const render = (due: RetentionDue | null) => {
  document.body.innerHTML = `<main><h1>Records retention</h1>${renderToStaticMarkup(
    <RetentionReport due={due} />,
  )}</main>`;
  return document.body.textContent ?? "";
};

const ZERO = {
  due: 0,
  held: 0,
  retain: 0,
  no_trigger_yet: 0,
  tenant_policy: 0,
  never_offered: 0,
  not_evaluated: 0,
};
const NOTHING_DESTROYED = "This report only counts. Nothing has been destroyed.";

describe("records due for destruction", () => {
  it("says the report is off, that it destroys nothing and who can turn it on", async () => {
    const text = render({ mode: "off", report: null });
    expect(text).toContain(NOTHING_DESTROYED);
    expect(text).toContain("Report off");
    expect(text).toContain("Ask Thapsus Care support to turn it on.");
    expect(await violations()).toEqual([]);
  });

  it("says when the first report comes once it is on", async () => {
    const text = render({ mode: "report", report: null });
    expect(text).toContain("Report on");
    expect(text).toContain("The report runs every night");
    expect(await violations()).toEqual([]);
  });

  it("shows the counts per kind of record, the totals and the time in UK time", async () => {
    const text = render({
      mode: "report",
      report: {
        id: "0194d000-0000-7000-8000-0000000000aa",
        asOf: "2026-07-08T01:29:00.000Z",
        durationMs: 900,
        tablesRead: 2,
        tablesSkipped: 1,
        totals: { ...ZERO, due: 3, held: 1, retain: 4, not_evaluated: 6 },
        lines: [
          {
            table: "care_note",
            recordClass: "care_record",
            reason: null,
            counts: { ...ZERO, due: 3, held: 1, retain: 4 },
          },
          {
            table: "incident_person",
            recordClass: null,
            reason: "follows_parent",
            counts: { ...ZERO, not_evaluated: 6 },
          },
        ],
      },
    });
    expect(text).toContain(NOTHING_DESTROYED);
    // 01:29 UTC in July is 02:29 in the UK.
    expect(text).toContain("Counted on 08/07/2026 02:29 (UK time)");
    expect(text).toContain("Due for destruction3 records");
    expect(text).toContain("Total14 records");
    const rows = [...document.querySelectorAll("tbody tr")].map((r) =>
      [...r.children].map((c) => c.textContent),
    );
    expect(rows).toEqual([
      ["Care records", "3", "1", "4", "0", "0", "8"],
      ["Not read by kind yet", "0", "0", "0", "0", "6", "6"],
    ]);
    expect(text).toContain("2 tables read, 1 table counted without reading its dates.");
    expect(await violations()).toEqual([]);
  });

  it("tells a reader whose role is narrower than the organisation why it is not shown", async () => {
    const text = render(null);
    expect(text).toContain(
      "only someone whose records retention role covers the whole organisation",
    );
    expect(await violations()).toEqual([]);
  });
});
