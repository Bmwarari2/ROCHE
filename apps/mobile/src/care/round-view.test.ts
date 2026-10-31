import { describe, expect, it } from "vitest";
import {
  managesTasks,
  type RoundTaskRow,
  roundEmpty,
  roundHeader,
  roundItem,
  roundItems,
  roundRefusalText,
} from "./round-view";

/**
 * The round on the phone (screens gate items (b), (d) and (f); HZ-024, HZ-028, HZ-029), worked out
 * from synced rows. Invented people ("Ada Example") and tasks only.
 */

const NOW = new Date("2026-10-11T10:00:00.000Z"); // 11:00 in UK summer time.

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
  communication_needs: null,
  person_location_id: "loc-north",
  evidence_waiting: 0,
  evidence_refused: 0,
  ...overrides,
});

const move = (to: "done" | "skipped", reason: string | null = null) =>
  JSON.stringify({
    id: "move-1",
    to,
    reason,
    version: 3,
    by: "user-carer",
    at: "2026-10-11T09:55:00.000Z",
    tenantId: "tenant-a",
    personId: "person-ada",
    locationId: "loc-north",
    dueAt: "2026-10-11T10:30:00.000Z",
    title: "Reposition",
  });

describe("what each task on the round says", () => {
  it("names the task, the person as they are known and when it is due, in UK time", () => {
    expect(roundItem(row(), NOW)).toMatchObject({
      title: "Reposition",
      person: "Ada Example",
      when: "Due 11/10/2026 at 11:30",
      timing: "due",
      action: "mark",
      notices: [],
    });
  });

  it.each([
    [
      "overdue once its window has closed",
      { window_end: "2026-10-11T09:59:00.000Z" },
      "overdue",
      "Overdue",
    ],
    ["due now inside its window", {}, "due", "Due now"],
    [
      "later before its window opens",
      {
        window_start: "2026-10-11T12:00:00.000Z",
        window_end: null,
        due_at: "2026-10-11T12:30:00.000Z",
      },
      "later",
      "Later",
    ],
    [
      "overdue by its due time when it has no window",
      { window_start: null, window_end: null, due_at: "2026-10-11T09:00:00.000Z" },
      "overdue",
      "Overdue",
    ],
  ] as const)("is %s, as an icon and a word", (_label, overrides, timing, word) => {
    const item = roundItem(row(overrides), NOW);
    expect(item.timing).toBe(timing);
    expect(item.chip.label).toBe(word);
  });

  it("hazard HZ-024 says a round is from an earlier plan (gate item (b))", () => {
    expect(roundItem(row({ from_earlier_plan: 1 }), NOW).notices).toEqual([
      "From an earlier plan: check the current plan",
    ]);
    const urgent = roundItem(row({ priority: "urgent", from_earlier_plan: 1 }), NOW);
    expect(urgent.notices).toEqual(["From an earlier plan: check the current plan"]);
    // Urgent is a flag, an icon and a word, never a colour alone.
    expect(urgent.flags).toEqual([
      { key: "urgent", icon: "triangle-alert", tone: "warning", label: "Urgent" },
    ]);
  });

  it("flags the person's communication needs, unreadable ones included (Accessible Information Standard)", () => {
    const needs = JSON.stringify([
      { code: "bsl", display: "British Sign Language", preferredFormat: null },
    ]);
    expect(roundItem(row({ communication_needs: needs }), NOW).flags).toEqual([
      {
        key: "communication",
        icon: "message-square-text",
        tone: "info",
        label: "Communication: British Sign Language",
      },
    ]);
    expect(roundItem(row({ communication_needs: "not json" }), NOW).flags[0]?.label).toBe(
      "Communication needs could not be read",
    );
    expect(roundItem(row(), NOW).flags).toEqual([]);
  });

  it("hazard HZ-006 ties an entry Harbour refused back to its task, and offers it again", () => {
    const item = roundItem(row({ evidence_required: 1, evidence_refused: 1 }), NOW);
    expect(item.action).toBe("evidence");
    expect(item.notices[0]).toMatch(/^An entry for this task was not accepted by Harbour/);
  });

  it("says it cannot tell when a plan's round has no earlier-plan flag yet (#123 clinical review, L8)", () => {
    expect(
      roundItem(row({ from_earlier_plan: null, series_id: "series-1" }), NOW).notices,
    ).toContain(
      "This phone cannot tell whether this round is from the current plan: check the current plan",
    );
    expect(roundItem(row({ from_earlier_plan: null }), NOW).notices).toEqual([]);
  });

  it("never offers a medicines task here, before eMAR (#123 clinical review, L10)", () => {
    const item = roundItem(row({ kind: "medicines.administration" }), NOW);
    expect(item.action).toBe("none");
    expect(item.notices).toContain(
      "Medicines are recorded in Harbour on the web until medicines recording is on the phone.",
    );
  });

  it("says an escalated overdue task is escalated, in words (#123 clinical review, L11)", () => {
    const item = roundItem(
      row({ window_end: "2026-10-11T09:00:00.000Z", escalation_level: 1 }),
      NOW,
    );
    expect(item.chip.label).toBe("Overdue: escalated");
  });

  it("says where to record evidence for a task about nobody", () => {
    const item = roundItem(row({ evidence_required: 1, person_id: null }), NOW);
    expect(item.notices).toContain(
      "This task is not about one person. Record it in Harbour on the web.",
    );
  });

  it("hazard HZ-029 says evidence saved here waits to upload, and offers nothing more (gate item (f))", () => {
    const item = roundItem(row({ evidence_required: 1, evidence_waiting: 1 }), NOW);
    expect(item).toMatchObject({
      action: "none",
      chip: { kind: "flag", icon: "cloud-upload", label: "Waiting to upload" },
    });
    expect(item.notices).toContain("Evidence recorded, waiting to upload. Do not record it again.");
  });

  it("asks for the entry a task needs, rather than a tap", () => {
    expect(roundItem(row({ evidence_required: 1 }), NOW).action).toBe("evidence");
  });

  it.each([
    ["done", move("done"), "Marked done on this phone. It is recorded when it uploads."],
    [
      "not done",
      move("skipped", "Asleep"),
      "Marked not done on this phone. It is recorded when it uploads. Reason given: Asleep",
    ],
  ])(
    "hazard HZ-029 says a move marked %s here waits to upload, and offers nothing more",
    (_label, queued, words) => {
      const item = roundItem(
        row({ status: queued.includes('"done"') ? "done" : "skipped", queued_transition: queued }),
        NOW,
      );
      expect(item.action).toBe("none");
      expect(item.chip.label).toBe("Waiting to upload");
      expect(item.notices).toContain(words);
    },
  );

  it("names a task put back by a session's end as a bare row from its move (#36 review round 2)", () => {
    const bare = row({
      title: null,
      due_at: null,
      window_start: null,
      window_end: null,
      version: null,
      evidence_required: null,
      required_permission: null,
      status: "done",
      queued_transition: move("done"),
    });
    expect(roundItem(bare, NOW)).toMatchObject({
      title: "Reposition",
      when: null,
      action: "none",
      chip: { label: "Waiting to upload" },
    });
    // Without a readable move, it is still named, never blank.
    expect(roundItem({ ...bare, queued_transition: null }, NOW).title).toBe("A task");
  });

  it("says a person's row is not on the phone yet rather than leave the name blank", () => {
    expect(
      roundItem(row({ preferred_name: null, given_name: null, family_name: null }), NOW).person,
    ).toBe("Person not on this phone yet");
    expect(roundItem(row({ person_id: null }), NOW).person).toBeNull();
  });

  it("lists overdue first, then due now, then later, each by due time", () => {
    const items = roundItems(
      [
        row({
          id: "later",
          window_start: "2026-10-11T12:00:00.000Z",
          window_end: null,
          due_at: "2026-10-11T12:30:00.000Z",
        }),
        row({ id: "due" }),
        row({
          id: "overdue-2",
          window_end: "2026-10-11T09:50:00.000Z",
          due_at: "2026-10-11T09:40:00.000Z",
        }),
        row({
          id: "overdue-1",
          window_end: "2026-10-11T09:00:00.000Z",
          due_at: "2026-10-11T08:40:00.000Z",
        }),
      ],
      NOW,
    );
    expect(items.map((i) => i.id)).toEqual(["overdue-1", "overdue-2", "due", "later"]);
  });
});

describe("hazard HZ-028 what the round on this phone holds, never read as nothing due (gate item (d))", () => {
  // As the API puts them in the token: tomorrow, today and the day before (UTC days).
  const days = ["2026-10-10", "2026-10-11", "2026-10-12"];

  it("says the window the token gave, when it last synced, and that it may be incomplete", () => {
    expect(
      roundHeader({
        now: NOW,
        offlineDays: days,
        lastSyncedAt: new Date("2026-10-11T09:45:00.000Z"),
        demo: false,
      }),
    ).toEqual({
      // British Summer Time: UTC days run from 01:00 to 00:59.
      holds: "This phone holds the open tasks due from 10/10/2026 at 01:00 to 13/10/2026 at 00:59.",
      synced: "Last successful sync 11/10/2026 at 10:45",
      incomplete:
        "Tasks due before then, and changes made since the last sync, are not shown here. The whole round is in Harbour on the web.",
    });
  });

  it.each([
    [
      // A sync at 23:30 UTC in BST is 00:30 UK time the next day: the token's days are still the
      // UTC ones, so the phone never claims the UK day it does not hold (#123 clinical review, M4).
      "a sync at 23:30 UTC in British Summer Time",
      ["2026-10-19", "2026-10-20", "2026-10-21"],
      "This phone holds the open tasks due from 19/10/2026 at 01:00 to 22/10/2026 at 00:59.",
    ],
    [
      "the autumn clock change, Sunday 25/10/2026",
      ["2026-10-24", "2026-10-25", "2026-10-26"],
      "This phone holds the open tasks due from 24/10/2026 at 01:00 to 26/10/2026 at 23:59.",
    ],
    [
      "the spring clock change, Sunday 29/03/2026",
      ["2026-03-28", "2026-03-29", "2026-03-30"],
      "This phone holds the open tasks due from 28/03/2026 at 00:00 to 31/03/2026 at 00:59.",
    ],
  ])("words %s from the token's days", (_label, offlineDays, holds) => {
    expect(roundHeader({ now: NOW, offlineDays, lastSyncedAt: NOW, demo: false }).holds).toBe(
      holds,
    );
  });

  it("says it does not know the days, or has never synced, rather than guess", () => {
    const header = roundHeader({ now: NOW, offlineDays: null, lastSyncedAt: null, demo: false });
    expect(header.holds).toMatch(/does not know yet which days/);
    expect(header.synced).toMatch(/^Not synced yet/);
  });

  it("words an empty round as what the phone holds, never as nothing due", () => {
    const synced = roundEmpty({ lastSyncedAt: NOW, demo: false });
    expect(synced).toMatch(/does not mean nothing is due/);
    expect(roundEmpty({ lastSyncedAt: null, demo: false })).toMatch(
      /has not received the round yet/,
    );
    for (const words of [synced, roundEmpty({ lastSyncedAt: null, demo: false })]) {
      expect(words).not.toMatch(/^Nothing (is )?due/i);
    }
  });
});

describe("who to tell when a task cannot be marked (#36 review round 2)", () => {
  it.each([
    [
      "a care worker",
      false,
      "You cannot mark this task on this phone. Tell the person in charge of this shift.",
    ],
    [
      "the person in charge, who manages tasks",
      true,
      "You cannot mark this task on this phone. You can check and change the task in Harbour on the web.",
    ],
  ])("tells %s what to do", (_label, manager, words) => {
    expect(roundRefusalText({ key: "mobile.round.notYours" }, manager)).toBe(words);
  });

  it("adds nothing to a refusal that is not about who may mark it", () => {
    expect(
      roundRefusalText({ key: "mobile.round.reasonRequired", values: { min: 3 } }, false),
    ).toBe("Say why the task was not done (3 characters or more).");
  });

  it("reads who manages tasks from their permissions", () => {
    expect(managesTasks(["care.note.write", "platform.task.manage"])).toBe(true);
    expect(managesTasks(["care.note.write"])).toBe(false);
    expect(managesTasks(undefined)).toBe(false);
  });
});
