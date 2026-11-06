import { describe, expect, it } from "vitest";
import { paneMinimums, splitLayout } from "./split-layout";

/**
 * MOB-013: two panes only on a tablet in landscape, and only while both panes fit at the reader's
 * text size; otherwise the phone's single pane (HZ-001: never a squeezed point-of-care header).
 * Sizes are real devices in points.
 */
describe("splitLayout", () => {
  it.each([
    ["phone, portrait", 393, 852, 1, "single"],
    ["phone, landscape", 852, 393, 1, "single"],
    ["large phone, landscape", 932, 430, 1, "single"],
    ["iPad mini, portrait", 744, 1133, 1, "single"],
    ["iPad mini, landscape", 1133, 744, 1, "split"],
    ["iPad 10.9 inch, landscape", 1180, 820, 1, "split"],
    ["iPad Pro 13 inch, landscape", 1376, 1032, 1, "split"],
    ["Android tablet (Pixel Tablet), landscape", 1280, 800, 1, "split"],
    ["Android tablet (Pixel Tablet), portrait", 800, 1280, 1, "single"],
    ["small Android tablet, landscape", 960, 600, 1, "split"],
    ["iPad in a narrow Split View window", 507, 820, 1, "single"],
    ["iPad 10.9 inch, landscape, 150% text", 1180, 820, 1.5, "split"],
    ["iPad 10.9 inch, landscape, 200% text", 1180, 820, 2, "single"],
    ["iPad Pro 13 inch, landscape, 200% text", 1376, 1032, 2, "split"],
    ["iPad mini, landscape, 200% text", 1133, 744, 2, "single"],
    ["small Android tablet, landscape, 200% text", 960, 600, 2, "single"],
    [
      "iPad Pro 13 inch, landscape, 310% text (largest accessibility size)",
      1376,
      1032,
      3.1,
      "single",
    ],
    ["square window", 800, 800, 1, "single"],
    ["no size yet", 0, 0, 1, "single"],
    ["impossible size", Number.NaN, 800, 1, "single"],
  ])("%s: %s", (_label, width, height, fontScale, mode) => {
    expect(splitLayout({ width, height, fontScale }).mode).toBe(mode);
  });

  it("never gives a pane less than its minimum at the text size, and uses the whole width", () => {
    for (const fontScale of [0.8, 1, 1.3, 1.5, 1.8, 2]) {
      for (let width = 600; width <= 1600; width += 7) {
        const layout = splitLayout({ width, height: 600, fontScale });
        if (layout.mode !== "split") continue;
        const min = paneMinimums(fontScale);
        expect(layout.listWidth).toBeGreaterThanOrEqual(min.list);
        expect(layout.detailWidth).toBeGreaterThanOrEqual(min.detail);
        expect(layout.listWidth + layout.detailWidth).toBe(width);
      }
    }
  });

  it("gives the list about two fifths when there is room to spare", () => {
    expect(splitLayout({ width: 1376, height: 1032 })).toEqual({
      mode: "split",
      listWidth: 523,
      detailWidth: 853,
    });
  });
});

describe("paneMinimums", () => {
  it.each([
    [1, { list: 300, detail: 420 }],
    [2, { list: 460, detail: 840 }],
    [0.85, { list: 300, detail: 420 }],
    [Number.NaN, { list: 300, detail: 420 }],
  ])("at text size %s", (fontScale, expected) => {
    expect(paneMinimums(fontScale)).toEqual(expected);
  });
});
