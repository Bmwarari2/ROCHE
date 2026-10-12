import { calculateNews2, NEWS2_REFERENCE_VECTORS, VALIDATED_TOOLS } from "@harbour/domain";
import { createElement } from "react";
import { Linking } from "react-native";
import { describe, expect, it } from "vitest";
import { type StoredNews2, toStoredNews2 } from "../care/charts";
import type { EntryItem } from "../care/entry-view";
import { t } from "../i18n/t";
import { render } from "../test-support/render";
import { ChartEntries } from "./ChartEntries";
import { News2Panel } from "./News2Panel";

/**
 * The NEWS2 panel (HZ-012, HZ-014; clinical review C6) and an empty chart (C9), rendered: what a
 * carer reads, not what a source file contains.
 */

function storedFor(name: string): StoredNews2 {
  const vector = NEWS2_REFERENCE_VECTORS.find((v) => v.name === name);
  if (!vector) throw new Error(`no vector ${name}`);
  const outcome = calculateNews2(vector.input);
  if (!outcome.ok) throw new Error(outcome.message);
  return toStoredNews2(outcome.result);
}

describe("hazard HZ-012 the NEWS2 panel shows its workings and the published response (C6)", () => {
  it("draws the score, the RCP wording, every parameter's points, the formula, bands, policy and source", async () => {
    const news2 = storedFor("total 13");
    const view = await render(createElement(News2Panel, { news2 }));
    const texts = view.texts();
    expect(texts).toContain(t("mobile.news2.title", { score: 13 }));
    expect(texts).toContain(t("mobile.news2.risk", { risk: news2.clinicalRisk }));
    expect(texts).toContain(t("mobile.news2.response", { response: news2.response }));
    expect(texts).toContain(t("mobile.news2.monitoring", { monitoring: news2.monitoring }));
    expect(texts).toContain(t("mobile.news2.redScore"));
    // Every parameter's points, so the arithmetic can be checked by hand.
    expect(news2.workings).toHaveLength(7);
    for (const w of news2.workings) {
      expect(texts).toContain(
        t("mobile.news2.working", { item: w.item, value: w.value, points: w.points }),
      );
    }
    // RCP chart 4's clinical response, word for word.
    expect(news2.clinicalResponse.length).toBeGreaterThan(0);
    for (const line of news2.clinicalResponse) {
      expect(texts).toContain(t("mobile.news2.clinicalResponseLine", { line }));
    }
    expect(texts).toContain(t("mobile.news2.formula"));
    expect(texts).toContain(t("mobile.news2.bands"));
    expect(texts).toContain(t("mobile.news2.policy"));
    expect(texts).toContain(t("mobile.news2.source", { version: news2.toolVersion }));
    // A raised score is announced at once.
    expect(view.find("news2-result")?.props.accessibilityLiveRegion).toBe("assertive");
  });

  it("opens the published source", async () => {
    const view = await render(createElement(News2Panel, { news2: storedFor("total 13") }));
    const opened = (Linking as unknown as { opened: string[] }).opened;
    opened.length = 0;
    await view.press("news2-source-link");
    expect(opened).toEqual([VALIDATED_TOOLS.news2.url]);
  });

  it("shows a score of 0 without the red-score line, announced politely", async () => {
    const view = await render(
      createElement(News2Panel, { news2: storedFor("all readings in the normal range") }),
    );
    expect(view.texts()).toContain(t("mobile.news2.title", { score: 0 }));
    expect(view.texts()).not.toContain(t("mobile.news2.redScore"));
    expect(view.find("news2-result")?.props.accessibilityLiveRegion).toBe("polite");
  });
});

describe("hazard HZ-028 an empty chart still says how many days the device keeps (C9)", () => {
  it("says there are no entries on this device, and how many days it keeps", async () => {
    const view = await render(createElement(ChartEntries, { items: [], windowDays: 7 }));
    expect(view.texts()).toContain(t("mobile.chart.noEntries"));
    expect(view.texts()).toContain("Entries from the last 7 days are kept on this device.");
  });

  it("leaves the days out until the figure is known", async () => {
    const view = await render(
      createElement(ChartEntries, { items: [] as EntryItem[], windowDays: null }),
    );
    expect(view.texts()).toContain(t("mobile.chart.noEntries"));
    expect(view.find("chart-window")).toBeNull();
  });
});
