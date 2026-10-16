import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { News2Flags } from "@/lib/charts";
import { News2Result } from "./News2Result";

const news2: News2Flags = {
  toolVersion: "2017",
  score: 7,
  band: "high",
  redScore: false,
  spo2Scale: 1,
  clinicalRisk: "High",
  response: "Emergency response",
  monitoring: "Continuous monitoring of vital signs",
  workings: { rows: [], unreadable: 0 },
};

describe("News2Result for a reading entered from paper", () => {
  it("hazard HZ-017 says an urgent reading from paper is from the time written on it, before the response", () => {
    const html = renderToStaticMarkup(
      createElement(News2Result, { news2, paperAt: "16/10/2026 09:15" }),
    );
    const said =
      "This reading is from 16/10/2026 09:15. Check it was escalated on paper, and check the person now.";
    expect(html).toContain(said);
    expect(html).toContain("data-paper-reading");
    expect(html.indexOf(said)).toBeLessThan(html.indexOf("Emergency response"));
  });

  it("says nothing of paper for a reading taken now", () => {
    const html = renderToStaticMarkup(createElement(News2Result, { news2 }));
    expect(html).not.toContain("data-paper-reading");
  });
});
