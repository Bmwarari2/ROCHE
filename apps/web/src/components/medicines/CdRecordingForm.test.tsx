// @vitest-environment jsdom
import axe from "axe-core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/cd-recording", () => ({ setCdRecording: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const { CdRecordingForm } = await import("./CdRecordingForm");

async function violations() {
  const results = await axe.run(document.body, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  return results.violations.map((v) => v.id);
}

const render = (enabled: boolean) => {
  document.body.innerHTML = `<main><h1>Controlled drug recording</h1>${renderToStaticMarkup(
    <CdRecordingForm locationId="0194d000-0000-7000-8000-000000000001" enabled={enabled} />,
  )}</main>`;
  return document.body.textContent ?? "";
};

describe("hazard HZ-115 hazard HZ-008 which register is the record at a home, in words (H-1518)", () => {
  it("says the paper register is the record, and asks for each step before turning recording on", async () => {
    const text = render(false);
    expect(text).toContain("The paper register is the record");
    expect(text).toContain("counted, witnessed and closed now");
    expect(text).toContain("before the next dose");
    expect(text).toContain("records controlled drugs");
    expect(document.querySelectorAll('input[type="checkbox"]:checked')).toHaveLength(0);
    expect(text).toContain("Turn on controlled drug recording");
    expect(await violations()).toEqual([]);
  });

  it("says Thapsus Care's register is the record, and asks why and for the paper register to restart before turning it off", async () => {
    const text = render(true);
    expect(text).toContain("Thapsus Care's register is the record");
    expect(text).toContain("Why recording is being turned off");
    expect(text).toContain("the paper register is restarted with each balance");
    expect(text).toContain("Turn off and go back to the paper register");
    expect(await violations()).toEqual([]);
  });
});
