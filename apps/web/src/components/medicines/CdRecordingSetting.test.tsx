// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/cd-recording", () => ({ setCdRecording: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const { CdRecordingSetting } = await import("./CdRecordingSetting");

const HOME = "0194d000-0000-7000-8000-000000000001";

describe("hazard HZ-115 hazard HZ-008 controlled drug recording when its state cannot be read (H-1518)", () => {
  it("says it could not check, and offers no change", () => {
    const html = renderToStaticMarkup(<CdRecordingSetting locationId={HOME} enabled={null} />);
    expect(html).toContain("could not check which register is the record here");
    expect(html).not.toContain("<form");
    expect(html).not.toContain('type="checkbox"');
  });

  it.each([
    [false, "Turn on controlled drug recording"],
    [true, "Turn off and go back to the paper register"],
  ])("offers the form when the state is read (%s)", (enabled, button) => {
    const html = renderToStaticMarkup(<CdRecordingSetting locationId={HOME} enabled={enabled} />);
    expect(html).toContain("<form");
    expect(html).toContain(button);
  });
});
