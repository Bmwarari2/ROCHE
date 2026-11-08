import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "../test-support/render";
import { SavedNoticeView } from "./SavedNoticeView";

/** Hazard HZ-001: the save confirmation as drawn, with an invented person. */
describe("hazard HZ-001 the save confirmation is drawn in words with a button to hide it", () => {
  it("draws the words, not a live region, and a Hide message button that hides it", async () => {
    const onHide = vi.fn();
    const view = await render(
      createElement(SavedNoticeView, {
        notice: {
          personId: "0199d000-0000-7000-8000-000000000a01",
          personName: "Ada Example",
          table: "care_note",
          corrected: false,
          at: Date.parse("2026-11-08T14:05:00Z"),
        },
        demo: false,
        onHide,
      }),
    );
    const texts = view.texts();
    expect(texts.some((x) => x.startsWith("Note saved for Ada Example at 14:05"))).toBe(true);
    expect(texts).toContain("Hide message");
    expect(view.find("saved-notice")?.props.accessibilityLiveRegion).toBeUndefined();
    await view.press("saved-notice-dismiss");
    expect(onHide).toHaveBeenCalledTimes(1);
  });
});
