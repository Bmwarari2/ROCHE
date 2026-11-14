import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "../test-support/render";
import { ModeChooserView } from "./ModeChooserView";

/** The mode chooser right after sign-in (iOS Simulator run, 14/11/2026, finding 2). */
describe("mode chooser", () => {
  it("says demo mode in a demo build, before any care screen opens", async () => {
    const view = await render(createElement(ModeChooserView, { demo: true, onChoose: vi.fn() }));
    expect(view.find("demo-notice")).not.toBeNull();
    expect(view.texts()).toContain("Demo mode: invented people, not real records.");
  });

  it("has no demo line in a live build", async () => {
    const view = await render(createElement(ModeChooserView, { demo: false, onChoose: vi.fn() }));
    expect(view.find("demo-notice")).toBeNull();
    expect(view.texts().some((text) => text.startsWith("Demo mode"))).toBe(false);
  });

  it("offers the three modes from the catalogue and reports the one pressed", async () => {
    const onChoose = vi.fn();
    const view = await render(createElement(ModeChooserView, { demo: false, onChoose }));
    expect(view.texts()).toEqual(
      expect.arrayContaining(["Choose how you will use Thapsus Care", "Care", "Manage", "Family"]),
    );
    await view.press("mode-care");
    expect(onChoose).toHaveBeenCalledWith("care");
  });
});
