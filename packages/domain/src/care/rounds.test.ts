import { describe, expect, it } from "vitest";
import { type RoundTask, roundView } from "./rounds";

const t = (iso: string) => new Date(iso);
const window = { from: t("2026-10-11T07:00:00Z"), to: t("2026-10-11T19:00:00Z") };
const now = t("2026-10-11T10:00:00Z");

const people = [
  { personId: "p10", area: "First floor", roomLabel: "Room 10" },
  { personId: "p2", area: "First floor", roomLabel: "Room 2" },
  { personId: "p1", area: "Ground floor", roomLabel: "Room 1" },
  { personId: "p-none", area: null, roomLabel: null },
];

const task = (
  id: string,
  personId: string | null,
  dueAt: string,
  extra: Partial<RoundTask> = {},
): RoundTask => ({
  id,
  personId,
  title: id,
  status: "open",
  dueAt: t(dueAt),
  windowStart: null,
  windowEnd: null,
  ...extra,
});

const tasks: RoundTask[] = [
  task("turn-10", "p10", "2026-10-11T11:00:00Z"),
  task("fluids-10", "p10", "2026-10-11T09:00:00Z"),
  task("turn-2", "p2", "2026-10-11T12:00:00Z"),
  task("carried-over", "p1", "2026-10-11T05:00:00Z"),
  task("done-earlier", "p1", "2026-10-11T05:00:00Z", { status: "done" }),
  task("window-still-open", "p1", "2026-10-11T06:00:00Z", { windowEnd: t("2026-10-11T12:00:00Z") }),
  task("next-shift", "p1", "2026-10-11T20:00:00Z"),
  task("fridge", null, "2026-10-11T08:00:00Z"),
  task("visitor-check", "p-none", "2026-10-11T13:00:00Z"),
  task("unknown-person", "p-gone", "2026-10-11T14:00:00Z"),
];

describe("roundView", () => {
  const round = roundView(tasks, people, window, now, 30);

  it("orders areas alphabetically with the unplaced last, and rooms naturally", () => {
    expect(round.map((a) => a.area)).toEqual(["First floor", "Ground floor", null]);
    expect(round[0]?.stops.map((s) => s.roomLabel)).toEqual(["Room 2", "Room 10"]);
  });

  it("orders a person's tasks by due time and gives each its state", () => {
    const room10 = round[0]?.stops.find((s) => s.personId === "p10");
    expect(room10?.tasks.map((x) => [x.id, x.state])).toEqual([
      ["fluids-10", "escalated"],
      ["turn-10", "upcoming"],
    ]);
  });

  it("carries unfinished tasks from before the round, overdue or still in their window", () => {
    const ground = round[1]?.stops[0];
    expect(ground?.tasks.map((x) => [x.id, x.state])).toEqual([
      ["carried-over", "escalated"],
      ["window-still-open", "due"],
    ]);
  });

  it("leaves out tasks due after the round", () => {
    expect(JSON.stringify(round)).not.toContain("next-shift");
  });

  it("puts tasks with no person after the people in the unplaced group", () => {
    const unplaced = round[2]?.stops ?? [];
    expect(unplaced.at(-1)?.personId).toBeNull();
    expect(unplaced.at(-1)?.tasks.map((x) => x.id)).toEqual(["fridge"]);
    expect(unplaced.map((s) => s.personId)).toContain("p-gone");
  });

  it("shows a task whose window is already open even though it falls due after the round", () => {
    const open = task("open-window", "p2", "2026-10-11T20:00:00Z", {
      windowStart: t("2026-10-11T09:00:00Z"),
    });
    const view = roundView([open], people, window, now, 30);
    expect(view[0]?.stops[0]?.tasks.map((x) => [x.id, x.state])).toEqual([["open-window", "due"]]);
  });

  it("keeps an earlier task that is still upcoming when the round is viewed before it starts", () => {
    const early = task("before-round", "p1", "2026-10-11T06:45:00Z");
    const view = roundView([early], people, window, t("2026-10-11T06:30:00Z"), 30);
    expect(view[0]?.stops[0]?.tasks.map((x) => [x.id, x.state])).toEqual([
      ["before-round", "upcoming"],
    ]);
  });

  it("is empty when nothing is due", () => {
    expect(roundView([], people, window, now, 30)).toEqual([]);
  });
});
