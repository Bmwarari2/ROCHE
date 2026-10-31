import type { HandoverItem, HandoverNoteItem } from "@harbour/contracts";
import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  currentHandover,
  groupHandover,
  handoverChips,
  handoverShown,
  itemFlags,
  itemKindChip,
  itemSourceHref,
  shiftTitle,
  youChip,
} from "./handover";

const t = createTranslator("en-GB");
const ADA = "0194d000-0000-7000-8600-000000000001";
const SOURCE = "0194d000-0000-7000-8000-00000000aaaa";

const shift = (start: string, end: string) => ({ shift: { name: "Day", start, end } });

const item = (over: Partial<HandoverItem>): HandoverItem => ({
  key: "k1",
  kind: "fall",
  personId: ADA,
  sourceType: "incident",
  sourceId: SOURCE,
  at: "2026-10-16T09:00:00Z",
  lateAddition: false,
  addedAt: "2026-10-16T09:05:00Z",
  seen: false,
  summary: null,
  ...over,
});

const note = (over: Partial<HandoverNoteItem>): HandoverNoteItem => ({
  id: "0194d000-0000-7000-8000-00000000bbbb",
  itemKey: null,
  personId: null,
  body: "Quiet afternoon",
  createdAt: "2026-10-16T15:00:00Z",
  createdBy: null,
  createdByStaff: null,
  ...over,
});

describe("the shift handover screens (care.md rule 14)", () => {
  it("is offered to those who take part in the handover", () => {
    expect(handoverShown(["care.handover.manage"])).toBe(true);
    expect(handoverShown(["people.person.read"])).toBe(false);
  });

  it("finds the handover of the shift running now", () => {
    const list = [
      { id: "now", ...shift("2026-10-16T07:00:00Z", "2026-10-16T19:00:00Z") },
      { id: "before", ...shift("2026-10-15T19:00:00Z", "2026-10-16T07:00:00Z") },
    ];
    expect(currentHandover(list, new Date("2026-10-16T12:00:00Z"))?.id).toBe("now");
    expect(currentHandover(list, new Date("2026-10-16T19:00:00Z"))).toBeNull();
  });

  it("hazard HZ-009 titles a shift with its UK times, naming the zone on a clock-change day", () => {
    expect(shiftTitle(shift("2026-10-16T07:00:00Z", "2026-10-16T19:00:00Z"), t)).toBe(
      "Day, 16/10/2026 08:00 to 16/10/2026 20:00",
    );
    expect(shiftTitle(shift("2026-10-24T23:00:00Z", "2026-10-25T08:00:00Z"), t)).toBe(
      "Day, 25/10/2026 00:00 BST to 25/10/2026 08:00 GMT",
    );
  });

  it("hazard HZ-008 says open or locked, and warns when the incoming shift has not acknowledged it", () => {
    expect(handoverChips({ open: true, unacknowledged: false }, t)).toEqual([
      { status: "info", icon: "file-pen", label: "Open for notes" },
    ]);
    expect(handoverChips({ open: false, unacknowledged: true }, t)).toEqual([
      { status: "notApplicable", icon: "circle-minus", label: "Locked" },
      { status: "overdue", icon: "circle-alert", label: "Not acknowledged by the incoming shift" },
    ]);
  });

  it("says when whether the incoming shift has read it is not known to the reader", () => {
    expect(handoverChips({ open: true, unacknowledged: null }, t)[1]).toEqual({
      status: "neutral",
      icon: "search",
      label: "Incoming shift's acknowledgement not known to you",
    });
  });

  it("hazard HZ-018 marks an item added since compiling, and one new to the reader", () => {
    expect(itemFlags({ key: "a", lateAddition: true }, new Set(["a"]), t)).toEqual([
      { status: "info", icon: "file-pen", label: "Added since it was compiled" },
      { status: "due", icon: "clock", label: "New to you" },
    ]);
    expect(itemFlags({ key: "a", lateAddition: false }, new Set(), t)).toEqual([]);
  });

  it.each([
    [{ acknowledged: false, unseenKeys: [] }, "due", "You have not acknowledged it yet"],
    [{ acknowledged: true, unseenKeys: [] }, "done", "You have acknowledged it"],
    [{ acknowledged: true, unseenKeys: ["a", "b"] }, "due", "2 items new to you"],
  ])("says where the reader stands (%o)", (you, status, label) => {
    expect(youChip(you, t)).toMatchObject({ status, label });
  });

  it.each([
    ["fall", "overdue", "triangle-alert", "Fall"],
    ["news2", "overdue", "triangle-alert", "NEWS2 needing a response"],
    ["overdue_task", "due", "clock", "Overdue task"],
    ["body_map_mark", "info", "search", "Body map mark"],
    ["refusal", "overdue", "triangle-alert", "Care refused"],
    ["something_new", "overdue", "circle-alert", "Item of a kind not known: check the record"],
  ])("says what a %s item is in an icon and words", (kind, status, icon, label) => {
    expect(itemKindChip(kind, t)).toEqual({ status, icon, label });
  });

  it.each([
    ["incident", `/incidents/${SOURCE}`],
    ["observation", `/people/${ADA}/charts`],
    ["body_map_mark", `/people/${ADA}/body-map`],
    ["care_note", `/people/${ADA}/notes`],
    ["notification", "/notifications"],
    ["task", `/people/${ADA}`],
  ] as const)("links a %s item to its record", (sourceType, href) => {
    expect(itemSourceHref(item({ sourceType }))).toBe(href);
  });

  it("links nothing for a person's record it cannot name", () => {
    expect(itemSourceHref(item({ sourceType: "care_note", personId: null }))).toBeNull();
  });

  it("hazard HZ-001 groups items by person in the order compiled, each with its notes", () => {
    const other = "0194d000-0000-7000-8600-000000000002";
    const grouped = groupHandover({
      items: [
        item({ key: "a" }),
        item({ key: "b", personId: other }),
        item({ key: "c" }),
        item({ key: "d", personId: null }),
      ],
      notes: [note({ itemKey: "c", body: "Seen by GP" }), note({})],
    });
    expect(grouped.groups.map((g) => [g.personId, g.items.map((i) => i.item.key)])).toEqual([
      [ADA, ["a", "c"]],
      [other, ["b"]],
      [null, ["d"]],
    ]);
    expect(grouped.groups[0]?.items[1]?.notes.map((n) => n.body)).toEqual(["Seen by GP"]);
    expect(grouped.generalNotes.map((n) => n.body)).toEqual(["Quiet afternoon"]);
  });
});
