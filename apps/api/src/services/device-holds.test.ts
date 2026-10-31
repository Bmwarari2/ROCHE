import { describe, expect, it } from "vitest";
import { FLAGGED_ENTRY_REVIEW_HOURS, type FlaggedEntry, flaggedDue } from "./device-holds";

const NOW = new Date("2026-10-31T10:00:00Z");
const LATER = new Date(NOW.getTime() + FLAGGED_ENTRY_REVIEW_HOURS * 3_600_000);

const entry = (resourceType: string, completedTask?: boolean): FlaggedEntry => ({
  id: `${resourceType}-1`,
  resourceType,
  locationId: "location-1",
  ...(completedTask === undefined ? {} : { completedTask }),
});

describe("hazard HZ-040 a flagged-entry review falls due at once when a possible duplicate counts", () => {
  it.each<[string, FlaggedEntry[], Date]>([
    ["an observation", [entry("observation")], NOW],
    ["a care note that completed a scheduled task", [entry("care_note", true)], NOW],
    ["an activity that completed a scheduled task", [entry("activity_record", true)], NOW],
    ["an assessment that completed a scheduled task", [entry("assessment", true)], NOW],
    [
      "a body-map mark and a visit, one of which completed a task",
      [entry("body_map_mark"), entry("visit_log", true)],
      NOW,
    ],
    ["a care note that completed nothing", [entry("care_note", false)], LATER],
    ["a care note with no task outcome", [entry("care_note")], LATER],
    ["a body-map mark and an activity", [entry("body_map_mark"), entry("activity_record")], LATER],
  ])("hazard HZ-040 %s is due as shown (H-148)", (_label, entries, due) => {
    expect(flaggedDue(entries, NOW)).toEqual(due);
  });
});
