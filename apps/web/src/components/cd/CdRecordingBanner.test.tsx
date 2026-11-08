import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CdRecordingBanner } from "./CdRecordingBanner";

describe("hazard HZ-115 the register screens say when the paper register is the record (H-1517)", () => {
  it("says so in words, with an icon, while recording is not turned on", () => {
    const html = renderToStaticMarkup(<CdRecordingBanner on={false} />);
    expect(html).toContain("Controlled drug recording is not turned on for this home");
    expect(html).toContain("Do not record controlled drugs here");
    expect(html).toContain("<svg");
  });

  it("says nothing once recording is turned on", () => {
    expect(renderToStaticMarkup(<CdRecordingBanner on={true} />)).toBe("");
  });
});
