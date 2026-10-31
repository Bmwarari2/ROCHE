import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { FieldError } from "../care/entries";
import { type RoundTaskRow, roundEmpty, roundHeader, roundItem } from "../care/round-view";
import { render } from "../test-support/render";
import { RoundHeaderCard } from "./RoundHeaderCard";
import { RoundTaskCard } from "./RoundTaskCard";

/**
 * The round's task card and header, rendered: what a carer reads and presses (screens gate items
 * (b), (d) and (f); HZ-024, HZ-028, HZ-029). Invented people and tasks only.
 */

const NOW = new Date("2026-10-11T10:00:00.000Z");
const row = (overrides: Partial<RoundTaskRow> = {}): RoundTaskRow => ({
  id: "task-1",
  tenant_id: "tenant-a",
  person_id: "person-ada",
  location_id: "loc-north",
  title: "Reposition",
  status: "open",
  due_at: "2026-10-11T10:30:00.000Z",
  window_start: "2026-10-11T09:30:00.000Z",
  window_end: "2026-10-11T11:30:00.000Z",
  priority: "routine",
  evidence_required: 0,
  required_permission: "care.note.write",
  assignee_tenant_user_id: null,
  version: 3,
  queued_transition: null,
  from_earlier_plan: 0,
  preferred_name: "Ada",
  given_name: "Adaline",
  family_name: "Example",
  person_location_id: "loc-north",
  evidence_waiting: 0,
  evidence_refused: 0,
  communication_needs: null,
  ...overrides,
});

function card(
  overrides: Partial<RoundTaskRow> = {},
  answer: FieldError | null = null,
  manager = false,
) {
  const marks: Array<[string, string]> = [];
  const evidence: string[] = [];
  const element = createElement(RoundTaskCard, {
    item: roundItem(row(overrides), NOW),
    manager,
    onMark: async (to, reason) => {
      marks.push([to, reason]);
      return answer;
    },
    onRecordEvidence: (item) => evidence.push(item.id),
  });
  return { element, marks, evidence };
}

describe("a task on the round, rendered", () => {
  it("shows the task, the person, when it is due and its status as a word", async () => {
    const view = await render(card({ from_earlier_plan: 1 }).element);
    const texts = view.texts();
    expect(texts).toEqual(
      expect.arrayContaining([
        "Reposition",
        "Ada Example",
        "Due 11/10/2026 at 11:30",
        "Due now",
        "From an earlier plan: check the current plan",
      ]),
    );
    expect(view.find("round-task-1-status")?.props.accessibilityLabel).toBe("Due now");
  });

  it("flags urgent and the person's communication needs, each an icon and a word", async () => {
    const needs = JSON.stringify([{ code: "bsl", display: "British Sign Language" }]);
    const view = await render(card({ priority: "urgent", communication_needs: needs }).element);
    expect(view.find("round-task-1-urgent")).toBeTruthy();
    expect(view.find("round-task-1-communication")).toBeTruthy();
    expect(view.texts()).toEqual(expect.arrayContaining(["Urgent", "Communication need"]));
  });

  it("counts the characters left in a reason rather than cutting it off", async () => {
    const view = await render(card().element);
    await view.press("round-task-1-not-done");
    expect(view.find("round-task-1-reason")?.props.maxLength).toBeUndefined();
    await view.typeInto("round-task-1-reason", "Asleep");
    expect(view.texts()).toContain("You have 494 characters remaining");
  });

  it("marks it done with one press", async () => {
    const { element, marks } = card();
    const view = await render(element);
    await view.press("round-task-1-done");
    expect(marks).toEqual([["done", ""]]);
  });

  it("asks why before saving it as not done", async () => {
    const { element, marks } = card();
    const view = await render(element);
    await view.press("round-task-1-not-done");
    expect(marks).toEqual([]);
    expect(view.texts()).toContain("Why was it not done?");
    await view.typeInto("round-task-1-reason", "Asleep, will turn at 14:00");
    await view.press("round-task-1-save");
    expect(marks).toEqual([["skipped", "Asleep, will turn at 14:00"]]);
  });

  it.each([
    [false, "You cannot mark this task on this phone. Tell the person in charge of this shift."],
    [
      true,
      "You cannot mark this task on this phone. You can check and change the task in Harbour on the web.",
    ],
  ])("says why it was not saved, and who to tell (manager: %s)", async (manager, words) => {
    const view = await render(card({}, { key: "mobile.round.notYours" }, manager).element);
    await view.press("round-task-1-done");
    expect(view.find("round-task-1-problem")?.props.accessibilityRole).toBe("alert");
    expect(view.texts()).toContain(words);
  });

  it("hazard HZ-029 offers the entry a task needs, never a tap", async () => {
    const { element, evidence } = card({ evidence_required: 1 });
    const view = await render(element);
    expect(view.find("round-task-1-done")).toBeNull();
    await view.press("round-task-1-evidence");
    expect(evidence).toEqual(["task-1"]);
  });

  it("hazard HZ-029 offers nothing while its evidence or its move waits to upload (gate item (f))", async () => {
    for (const overrides of [
      { evidence_required: 1, evidence_waiting: 1 },
      {
        status: "done",
        queued_transition: JSON.stringify({
          id: "move-1",
          to: "done",
          reason: null,
          version: 3,
          by: "user-carer",
          at: "2026-10-11T09:55:00.000Z",
          tenantId: "tenant-a",
          personId: "person-ada",
          dueAt: "2026-10-11T10:30:00.000Z",
          title: "Reposition",
        }),
      },
    ]) {
      const view = await render(card(overrides).element);
      expect(view.texts()).toContain("Waiting to upload");
      for (const id of ["done", "not-done", "evidence"]) {
        expect(view.find(`round-task-1-${id}`)).toBeNull();
      }
      view.unmount();
    }
  });
});

describe("hazard HZ-028 the round's header, rendered (gate item (d))", () => {
  it("says what the phone holds and from when, and in place of an empty list never says nothing is due", async () => {
    const header = roundHeader({ now: NOW, windowDays: 3, lastSyncedAt: NOW, demo: false });
    const view = await render(
      createElement(RoundHeaderCard, {
        header,
        empty: roundEmpty({ lastSyncedAt: NOW, demo: false }),
      }),
    );
    const texts = view.texts();
    expect(texts).toContain(header.holds);
    expect(texts).toContain(header.synced);
    expect(texts).toContain(header.incomplete);
    expect(texts).toContain("No tasks on this phone");
    expect(texts.join(" ")).toMatch(/does not mean nothing is due/);
  });
});
