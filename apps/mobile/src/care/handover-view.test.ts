import { describe, expect, it } from "vitest";
import {
  type AcknowledgementRow,
  acknowledgementState,
  expectedHandover,
  type HandoverItemViewRow,
  type HandoverRow,
  handoverEmpty,
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

  it("flags communication needs and a late addition, and names a person not on the phone", () => {
    const [first] = handoverItems(
      [
        item({
          communication_needs: JSON.stringify([{ display: "British Sign Language" }]),
          late_addition: 1,
          preferred_name: null,
          given_name: null,
          family_name: null,
        }),
      ],
      null,
    );
    expect(first).toMatchObject({
      communicationLabel: "Communication need",
      lateAddition: true,
      person: "Person not on this phone yet",
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
  it("says the days it holds from the last sync, when that was, and that it may be incomplete", () => {
    expect(
      handoverHeader({
        now: new Date("2026-10-31T10:00:00.000Z"),
        windowDays: 2,
        lastSyncedAt: new Date("2026-10-31T09:00:00.000Z"),
        demo: false,
      }),
    ).toEqual({
      holds:
        "This phone holds the handovers for shifts ending from 30/10/2026 to the end of 01/11/2026.",
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
