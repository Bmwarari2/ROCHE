import { describe, expect, it } from "vitest";
import {
  type AcknowledgementRow,
  acknowledgementState,
  expectedHandover,
  type HandoverItemViewRow,
  type HandoverRow,
  handoverEmpty,
  handoverEntries,
  handoverHeader,
  handoverItems,
  handoverStatusView,
  shownItems,
} from "./handover-view";

/**
 * The handover on the phone (screens gate items (a), (d) and (e); HZ-018, HZ-028). Invented people
 * ("Ada Example") only; the shift figures are test values, not the rate table's.
 */

const SHIFTS = { england: { day: 480, night: 1200 } }; // 08:00 and 20:00, UK time.

const handover = (overrides: Partial<HandoverRow> = {}): HandoverRow => ({
  id: "h-night",
  tenant_id: "tenant-a",
  location_id: "loc-north",
  shift_name: "night",
  shift_start: "2026-10-30T20:00:00.000Z",
  shift_end: "2026-10-31T08:00:00.000Z",
  compiled_at: "2026-10-31T07:30:00.000Z",
  locked_at: "2026-10-31T08:00:00.000Z",
  ...overrides,
});

const item = (overrides: Partial<HandoverItemViewRow> = {}): HandoverItemViewRow => ({
  id: "i-1",
  handover_id: "h-night",
  item_key: "fall:src-1",
  position: 1,
  kind: "fall",
  person_id: "person-ada",
  at: "2026-10-31T03:10:00.000Z",
  late_addition: 0,
  added_at: "2026-10-31T07:30:00.000Z",
  summary: null,
  preferred_name: "Ada",
  given_name: "Adaline",
  family_name: "Example",
  communication_needs: null,
  ...overrides,
});

const ack = (overrides: Partial<AcknowledgementRow> = {}): AcknowledgementRow => ({
  handover_id: "h-night",
  item_keys: JSON.stringify(["fall:src-1"]),
  acknowledged_at: "2026-10-31T08:05:00.000Z",
  seen_token: null,
  ...overrides,
});

describe("hazard HZ-018 which handover the phone should hold (gate item (e))", () => {
  const NOW = new Date("2026-10-31T10:00:00.000Z"); // 10:00 UK time (GMT): the day shift.

  it.each([
    ["final", [handover()], "final"],
    ["not final while locked_at is empty", [handover({ locked_at: null })], "not_final"],
    ["not compiled when no handover for that shift is here", [], "not_compiled"],
    [
      "not compiled when only an older one is here",
      [handover({ id: "h-old", shift_start: "2026-10-30T08:00:00.000Z" })],
      "not_compiled",
    ],
  ] as const)("says %s", (_label, handovers, kind) => {
    expect(expectedHandover({ now: NOW, nation: "england", shifts: SHIFTS, handovers }).kind).toBe(
      kind,
    );
  });

  it.each([
    ["no pattern kept", "england", null],
    ["no pattern for the home's nation", "wales", SHIFTS],
    ["no nation for the home", null, SHIFTS],
  ] as const)("cannot tell, and never guesses, with %s", (_label, nation, shifts) => {
    expect(expectedHandover({ now: NOW, nation, shifts, handovers: [handover()] }).kind).toBe(
      "unknown",
    );
  });

  it("expects the night before, across the clock change on 25/10/2026 (a 13-hour night)", () => {
    const expected = expectedHandover({
      now: new Date("2026-10-25T10:00:00.000Z"),
      nation: "england",
      shifts: SHIFTS,
      handovers: [],
    });
    expect(expected.kind).toBe("not_compiled");
    if (expected.kind !== "not_compiled") return;
    expect(expected.shift.start.toISOString()).toBe("2026-10-24T19:00:00.000Z"); // 20:00 BST
    expect(expected.shift.end.toISOString()).toBe("2026-10-25T08:00:00.000Z"); // 08:00 GMT
  });

  it("says each state as an icon and a word, with the shift in UK time", () => {
    const view = handoverStatusView(
      expectedHandover({ now: NOW, nation: "england", shifts: SHIFTS, handovers: [] }),
    );
    expect(view.chip).toEqual({
      tone: "warning",
      icon: "triangle-alert",
      label: "Not compiled yet",
    });
    expect(view.shift).toBe("The night shift, 30/10/2026 at 20:00 to 31/10/2026 at 08:00");
    expect(view.words).toMatch(
      /^The handover for the shift that has just ended is not on this phone/,
    );
    expect(handoverStatusView({ kind: "unknown" }).chip.label).toBe("Cannot tell");
    expect(handoverStatusView({ kind: "unknown" }).shift).toBeNull();
  });
});

describe("hazard HZ-018 the handovers a home's card shows, newest first (clinical review H1, M1)", () => {
  const dayBefore = handover({
    id: "h-day",
    shift_name: "day",
    shift_start: "2026-10-30T08:00:00.000Z",
    shift_end: "2026-10-30T20:00:00.000Z",
  });
  const night = handover({ locked_at: null }); // 30/10 20:00 to 31/10 08:00, compiled at 07:30.

  it("at 07:45, before the day shift, shows the night's handover first as this shift's, not final", () => {
    const entries = handoverEntries({
      now: new Date("2026-10-31T07:45:00.000Z"),
      nation: "england",
      shifts: { england: { ...SHIFTS.england, lead: 60 } },
      handovers: [dayBefore, night],
    });
    expect(entries.map((e) => [e.role, e.handover?.id, e.status.chip.label])).toEqual([
      ["current", "h-night", "This shift, not final"],
      ["outgoing", "h-day", "Final"],
    ]);
    expect(entries[0]?.status.shift).toBe(
      "The night shift, 30/10/2026 at 20:00 to 31/10/2026 at 08:00",
    );
  });

  it.each<[string, string, number | undefined, string[]]>([
    [
      "06:00, two hours before the night ends",
      "2026-10-31T06:00:00.000Z",
      60,
      ["outgoing", "current"],
    ],
    [
      "07:00, exactly the lead before it ends",
      "2026-10-31T07:00:00.000Z",
      60,
      ["current", "outgoing"],
    ],
    ["07:59, a minute before it ends", "2026-10-31T07:59:00.000Z", 60, ["current", "outgoing"]],
    ["06:30 with a 90-minute lead", "2026-10-31T06:30:00.000Z", 90, ["current", "outgoing"]],
    [
      "07:45 with no lead on the phone",
      "2026-10-31T07:45:00.000Z",
      undefined,
      ["outgoing", "current"],
    ],
  ])(
    "hazard HZ-018 at %s shows the running shift's own handover first only within the lead time (H-420)",
    (_label, now, lead, roles) => {
      const entries = handoverEntries({
        now: new Date(now),
        nation: "england",
        shifts: { england: lead === undefined ? SHIFTS.england : { ...SHIFTS.england, lead } },
        handovers: [dayBefore, night],
      });
      expect(entries.map((e) => e.role)).toEqual(roles);
      // The handover the shift received is always shown, with its own state.
      expect(entries.find((e) => e.role === "outgoing")?.handover?.id).toBe("h-day");
    },
  );

  it.each<[string, string, string, string, string, string, string[]]>([
    // Spring: the night of 28/03 runs from 20:00 GMT to 08:00 BST (07:00Z), 11 hours.
    [
      "06:45 BST on 29/03 (clocks forward)",
      "2026-03-29T05:45:00.000Z",
      "2026-03-28T08:00:00.000Z",
      "2026-03-28T20:00:00.000Z",
      "2026-03-28T20:00:00.000Z",
      "2026-03-29T07:00:00.000Z",
      ["outgoing", "current"],
    ],
    [
      "07:15 BST on 29/03 (clocks forward)",
      "2026-03-29T06:15:00.000Z",
      "2026-03-28T08:00:00.000Z",
      "2026-03-28T20:00:00.000Z",
      "2026-03-28T20:00:00.000Z",
      "2026-03-29T07:00:00.000Z",
      ["current", "outgoing"],
    ],
    // Autumn: the night of 24/10 runs from 20:00 BST (19:00Z) to 08:00 GMT, 13 hours.
    [
      "06:45 GMT on 25/10 (clocks back)",
      "2026-10-25T06:45:00.000Z",
      "2026-10-24T07:00:00.000Z",
      "2026-10-24T19:00:00.000Z",
      "2026-10-24T19:00:00.000Z",
      "2026-10-25T08:00:00.000Z",
      ["outgoing", "current"],
    ],
    [
      "07:15 GMT on 25/10 (clocks back)",
      "2026-10-25T07:15:00.000Z",
      "2026-10-24T07:00:00.000Z",
      "2026-10-24T19:00:00.000Z",
      "2026-10-24T19:00:00.000Z",
      "2026-10-25T08:00:00.000Z",
      ["current", "outgoing"],
    ],
  ])(
    "hazard HZ-018 counts the lead back from the shift's real end at %s (H-420)",
    (_label, now, dayStart, dayEnd, nightStart, nightEnd, roles) => {
      const entries = handoverEntries({
        now: new Date(now),
        nation: "england",
        shifts: { england: { ...SHIFTS.england, lead: 60 } },
        handovers: [
          handover({ id: "h-day", shift_name: "day", shift_start: dayStart, shift_end: dayEnd }),
          handover({ shift_start: nightStart, shift_end: nightEnd, locked_at: null }),
        ],
      });
      expect(entries.map((e) => e.role)).toEqual(roles);
    },
  );

  it("after the shift change shows only the outgoing handover", () => {
    const entries = handoverEntries({
      now: new Date("2026-10-31T10:00:00.000Z"),
      nation: "england",
      shifts: SHIFTS,
      handovers: [dayBefore, night],
    });
    expect(entries.map((e) => [e.role, e.handover?.id, e.status.chip.label])).toEqual([
      ["outgoing", "h-night", "Not final"],
    ]);
  });

  it("with no pattern shows the newest handover with its own shift and state, under cannot tell", () => {
    const [entry, ...rest] = handoverEntries({
      now: new Date("2026-10-31T10:00:00.000Z"),
      nation: "england",
      shifts: null,
      handovers: [dayBefore, night],
    });
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({ role: "latest", handover: { id: "h-night" } });
    expect(entry?.status.chip.label).toBe("Cannot tell");
    expect(entry?.status.shift).toBe("The night shift, 30/10/2026 at 20:00 to 31/10/2026 at 08:00");
    expect(entry?.status.words).toMatch(/newest on this phone, and it is not final\.$/);
  });

  it("expects the night before across the spring clock change on 29/03/2026 (an 11-hour night)", () => {
    const expected = expectedHandover({
      now: new Date("2026-03-29T10:00:00.000Z"),
      nation: "england",
      shifts: SHIFTS,
      handovers: [],
    });
    if (expected.kind !== "not_compiled") throw new Error(expected.kind);
    expect(expected.shift.start.toISOString()).toBe("2026-03-28T20:00:00.000Z"); // 20:00 GMT
    expect(expected.shift.end.toISOString()).toBe("2026-03-29T07:00:00.000Z"); // 08:00 BST
  });
});

describe("hazard HZ-018 the items, worded from their summaries (gate item (a))", () => {
  it("lists items in compiled order, each worded, never blank", () => {
    const items = handoverItems(
      [
        item({ id: "i-2", item_key: "news2:src-2", position: 2, kind: "news2" }),
        item({ summary: "{not json" }),
      ],
      null,
    );
    expect(items.map((i) => i.key)).toEqual(["fall:src-1", "news2:src-2"]);
    for (const i of items) expect(i.words.trim()).not.toBe("");
    expect(items[0]?.person).toBe("Ada Example");
    expect(items[0]?.when).toBe("31/10/2026 at 03:10");
  });

  it("flags communication needs and a late addition", () => {
    const [first] = handoverItems(
      [
        item({
          communication_needs: JSON.stringify([{ display: "British Sign Language" }]),
          late_addition: 1,
        }),
      ],
      null,
    );
    expect(first).toMatchObject({
      communicationLabel: "Communication: British Sign Language",
      lateAddition: true,
    });
  });

  it("names a person not on the phone, and says their communication needs are not here either", () => {
    const [first] = handoverItems(
      [item({ preferred_name: null, given_name: null, family_name: null })],
      null,
    );
    expect(first).toMatchObject({
      person: "Person not on this phone yet",
      communicationLabel: "Communication needs not on this phone",
    });
  });

  it("marks items the reader has not acknowledged as new, and asks again", () => {
    const rows = [item(), item({ id: "i-2", item_key: "incident:src-9", position: 2 })];
    const items = handoverItems(rows, ack());
    expect(items.map((i) => i.newForReader)).toEqual([false, true]);
    expect(acknowledgementState(items, ack())).toBe("new_items");
    expect(acknowledgementState(handoverItems([item()], ack()), ack())).toBe("acknowledged");
  });

  it("treats an acknowledgement it cannot read as covering nothing", () => {
    const bad = ack({ item_keys: "{" });
    expect(handoverItems([item()], bad)[0]?.newForReader).toBe(true);
  });

  it("hazard HZ-029 says an acknowledgement made here waits to upload", () => {
    const waiting = ack({ seen_token: "abc" });
    expect(acknowledgementState(handoverItems([item()], waiting), waiting)).toBe("waiting");
    expect(acknowledgementState(handoverItems([item()], null), null)).toBe("none");
    expect(acknowledgementState([], null)).toBe("nothing_to_acknowledge");
  });

  it("acknowledges over the items shown in their compiled order", () => {
    const items = handoverItems(
      [item({ id: "i-2", item_key: "b", position: 2 }), item({ item_key: "a", position: 1 })],
      null,
    );
    expect(shownItems(items)).toEqual([
      { item_key: "a", position: 1 },
      { item_key: "b", position: 2 },
    ]);
  });
});

describe("hazard HZ-028 what the handover on this phone holds (gate item (d))", () => {
  it("says the window the token gave, in UK time, when it last synced, and that it may be incomplete (#123 clinical review, M4)", () => {
    expect(
      handoverHeader({
        now: new Date("2026-10-31T10:00:00.000Z"),
        offlineDays: ["2026-10-30", "2026-10-31", "2026-11-01"],
        lastSyncedAt: new Date("2026-10-31T09:00:00.000Z"),
        demo: false,
      }),
    ).toEqual({
      holds:
        "This phone holds the handovers for shifts ending from 30/10/2026 at 00:00 to 01/11/2026 at 23:59.",
      synced: "Last successful sync 31/10/2026 at 09:00",
      incomplete:
        "Items added since the last sync are not shown here. The whole handover is in Harbour on the web.",
    });
  });

  it("never reads an empty handover as nothing to hand over", () => {
    for (const words of [
      handoverEmpty(new Date(), false),
      handoverEmpty(null, false),
      handoverEmpty(null, true),
    ]) {
      expect(words).not.toMatch(/^Nothing (to hand over|to report)/i);
    }
    expect(handoverEmpty(new Date(), false)).toMatch(/does not mean there is nothing to hand over/);
  });
});
