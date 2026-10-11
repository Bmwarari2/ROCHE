import { createElement, useState } from "react";
import { describe, expect, it } from "vitest";
import type { WhenChoice } from "../care/time";
import { t } from "../i18n/t";
import { render } from "../test-support/render";
import { normalisedTime, WhenField } from "./forms";

/**
 * Hazards HZ-010 and HZ-017 (event time), clinical reviews round 3 H1 and round 4 (low): on the
 * autumn clock change the time typed happened twice, so the carer chooses BST or GMT, and each
 * option names the time it means, written as everywhere else ("01:30", never "1:30").
 */

// 25 October 2026: the clocks went back at 02:00 BST, so 01:00 to 01:59 happened twice.
const AFTER_BOTH = new Date("2026-10-25T09:00:00Z");

function Harness({ initial, now }: { readonly initial: WhenChoice; readonly now: Date }) {
  const [value, setValue] = useState<WhenChoice>(initial);
  return createElement(WhenField, {
    value,
    onChange: setValue,
    windowDays: 7,
    toleranceMinutes: 5,
    now,
  });
}

const earlier = (time: string): WhenChoice => ({ kind: "earlier", time, daysAgo: 0, zone: null });

describe("hazard HZ-010 WhenField on the autumn clock change", () => {
  it("names the time, normalised, in the question and in both options", async () => {
    const view = await render(
      createElement(Harness, { initial: earlier("1:30"), now: AFTER_BOTH }),
    );
    const texts = view.texts();
    expect(texts).toContain(t("mobile.when.zoneLabel", { time: "01:30" }));
    expect(texts).toContain("01:30 BST, before the clocks went back");
    expect(texts).toContain("01:30 GMT, after the clocks went back");
    expect(texts.some((text) => text.includes(" 1:30"))).toBe(false);
  });

  it("has no default, and records the zone chosen", async () => {
    const view = await render(
      createElement(Harness, { initial: earlier("01:30"), now: AFTER_BOTH }),
    );
    expect(view.find("when-resolved")).toBeNull();
    await view.press("when-zone-GMT");
    expect(view.texts()).toContain(
      t("mobile.when.resolved", { date: "25/10/2026", time: "01:30 GMT" }),
    );
    await view.press("when-zone-BST");
    expect(view.texts()).toContain(
      t("mobile.when.resolved", { date: "25/10/2026", time: "01:30 BST" }),
    );
  });

  it("asks nothing for a time that happened once", async () => {
    const view = await render(
      createElement(Harness, { initial: earlier("03:30"), now: AFTER_BOTH }),
    );
    expect(view.find("when-zone")).toBeNull();
    expect(view.texts()).toContain(
      t("mobile.when.resolved", { date: "25/10/2026", time: "03:30 GMT" }),
    );
  });
});

describe("normalisedTime", () => {
  it.each([
    ["1:30", "01:30"],
    ["01:30", "01:30"],
    [" 9:05 ", "09:05"],
    ["23:59", "23:59"],
    ["not a time", "not a time"],
  ])("writes %j as %j", (typed, shown) => {
    expect(normalisedTime(typed)).toBe(shown);
  });
});
