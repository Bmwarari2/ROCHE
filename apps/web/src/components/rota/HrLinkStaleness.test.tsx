// @vitest-environment jsdom
import axe from "axe-core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HrLinkStaleness } from "./HrLinkStaleness";

/**
 * The HR platform's staleness note on rota screens (integrations.md section 11.5 rule 9; hazard
 * HZ-133): said in words with an icon and the time, as an alert; nothing when the link is off or
 * fresh. Checked with axe-core.
 */
type State = {
  linked: boolean;
  stale: boolean;
  lastGoodSyncAt: string | null;
  limitMinutes: number;
};
const apiWith = (data: State | undefined, status = data ? 200 : 403) =>
  ({
    GET: async () => ({ data, response: new Response(null, { status }) }),
  }) as never;

async function render(data: State | undefined, status?: number) {
  const element = await HrLinkStaleness({ api: apiWith(data, status) });
  document.body.innerHTML = `<main><h1>Rota</h1>${element ? renderToStaticMarkup(element) : ""}</main>`;
  return document.body;
}

async function violations() {
  const results = await axe.run(document.body, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  return results.violations.map((v) => v.id);
}

describe("hazard HZ-133 the rota says when the HR platform's data is out of date (rule 9)", () => {
  it("says so in words, with the time and an icon, as part of the page (no live region)", async () => {
    const body = await render({
      linked: true,
      stale: true,
      lastGoodSyncAt: "2026-11-06T09:30:00Z",
      limitMinutes: 15,
    });
    const text = body.textContent ?? "";
    expect(text).toContain("Staff data from the HR platform may be out of date");
    expect(text).toContain("06/11/2026");
    expect(text).toContain(
      "Harbour has not had leave, sickness and staff changes from the HR platform since the time below",
    );
    expect(body.querySelector("[role=alert]")).toBeNull();
    expect(body.querySelector("svg")).not.toBeNull();
    expect(body.querySelector("time")?.getAttribute("datetime")).toBe("2026-11-06T09:30:00Z");
    expect(await violations()).toEqual([]);
  });

  it("says so when there has never been a good sync", async () => {
    const body = await render({
      linked: true,
      stale: true,
      lastGoodSyncAt: null,
      limitMinutes: 15,
    });
    expect(body.textContent).toContain("has not had leave, sickness and staff changes");
  });

  it.each([
    ["the link is off", { linked: false, stale: false, lastGoodSyncAt: null, limitMinutes: 15 }],
    [
      "the data is fresh",
      { linked: true, stale: false, lastGoodSyncAt: "2026-11-06T09:30:00Z", limitMinutes: 15 },
    ],
    ["there is no link to read (403)", undefined],
  ] as const)("shows nothing when %s", async (_, data) => {
    const body = await render(data);
    expect(body.textContent).not.toContain("may be out of date");
  });

  it("shows the note when the check itself fails, since the data may be least reliable then", async () => {
    const body = await render(undefined, 503);
    expect(body.textContent).toContain("could not check when it last had staff changes");
    expect(await violations()).toEqual([]);
  });

  it.each([
    ["a summer evening (BST)", "2026-07-01T23:30:00Z", "02/07/2026"],
    ["the night the clocks go back", "2026-10-25T00:30:00Z", "25/10/2026"],
    ["the night the clocks go forward", "2026-03-29T01:30:00Z", "29/03/2026"],
  ])("says the time once, in UK time, on %s", async (_, at, day) => {
    const body = await render({ linked: true, stale: true, lastGoodSyncAt: at, limitMinutes: 15 });
    const time = body.querySelector("time");
    expect(time?.getAttribute("datetime")).toBe(at);
    expect(time?.textContent).toContain(day);
    expect((body.textContent ?? "").match(/\d{2}\/\d{2}\/\d{4}/g)).toHaveLength(1);
  });
});
