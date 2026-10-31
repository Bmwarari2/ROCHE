import { HANDOVER_SUMMARY_KEYS } from "@harbour/domain";
import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import { handoverItemWords } from "./handover-summary";

const t = createTranslator("en-GB");

const item = (
  kind: string,
  summary: { key: string; params: Record<string, string | number> } | null,
) => ({ kind, summary }) as never;

describe("hazard HZ-018 the web shows each handover item's own summary (H-269)", () => {
  it.each<[string, string, Record<string, string | number>, string]>([
    ["a fall from an incident", "fall", { source: "incident" }, "Fall, reported as an incident"],
    [
      "a NEWS2 score",
      "news2",
      { scored: "yes", score: 6, band: "medium" },
      "NEWS2 score 6, medium clinical risk",
    ],
    [
      "a task not done with its reason",
      "skipped_task",
      {
        status: "skipped",
        title: "Turn",
        planAction: "Reposition every 4 hours",
        reason: "Asleep",
      },
      "Not done: Reposition every 4 hours. Reason: Asleep",
    ],
    [
      "a task not done with no reason",
      "skipped_task",
      { status: "cancelled", title: "Turn" },
      "Cancelled: Turn. No reason given.",
    ],
    [
      "a refused drink",
      "refusal",
      { source: "observation", chart: "fluid_intake" },
      "Refused: a drink",
    ],
  ])("words %s", (_label, kind, params, words) => {
    const key = HANDOVER_SUMMARY_KEYS[kind as keyof typeof HANDOVER_SUMMARY_KEYS];
    expect(handoverItemWords(item(kind, { key, params }), t)).toBe(words);
  });

  it("words a body-map mark with its type, area and side", () => {
    const words = handoverItemWords(
      item("body_map_mark", {
        key: HANDOVER_SUMMARY_KEYS.body_map_mark,
        params: { markType: "bruise", view: "front", region: "shoulder", side: "left" },
      }),
      t,
    );
    expect(words).toBe("Body map: Bruise on Shoulder, the person's left");
  });

  it.each([
    ["no summary (compiled before summaries)", null],
    ["a key this build does not know", { key: "handover.summary.new", params: {} }],
  ])("words an item with %s by its kind, never blank or a raw key", (_label, summary) => {
    expect(handoverItemWords(item("overdue_task", summary), t)).toBe("Overdue task");
  });

  it("words every summary key from the web catalogue, even with no parameters", () => {
    for (const key of Object.values(HANDOVER_SUMMARY_KEYS)) {
      // An item of each kind with its key but no parameters is still worded, never left blank.
      const kind = Object.entries(HANDOVER_SUMMARY_KEYS).find(([, k]) => k === key)?.[0] ?? "";
      const words = handoverItemWords(item(kind, { key, params: {} }), t);
      expect(words, key).not.toBe("");
      expect(words, key).not.toContain("handover.summary");
    }
  });
});
