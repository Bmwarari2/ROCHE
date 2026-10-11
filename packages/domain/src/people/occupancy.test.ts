import { describe, expect, it } from "vitest";
import {
  type BedMoveRequest,
  type BedOccupancy,
  bedOccupantOn,
  checkOccupancyHistory,
  moveHistory,
  personBedOn,
  planBedMove,
  planBedRelease,
  type RoomView,
  roomLabelOn,
} from "./occupancy";

const ROOMS: RoomView[] = [
  { id: "r1", label: "Room 1", beds: 1, status: "available" },
  { id: "r2", label: "Room 2", beds: 2, status: "available" },
  { id: "r3", label: "Room 3", beds: 1, status: "out_of_service" },
  { id: "r4", label: "Room 4", beds: 1, status: "available" },
];

const ADA = "person-ada";
const BEN = "person-ben";

const history: BedOccupancy[] = [
  { id: "p1", personId: ADA, roomId: "r1", bed: 1, from: "2026-09-01", to: "2026-10-01" },
  { id: "p2", personId: ADA, roomId: "r2", bed: 1, from: "2026-10-01", to: null },
  { id: "p3", personId: BEN, roomId: "r2", bed: 2, from: "2026-09-15", to: null },
];

const TODAY = "2026-10-11";

describe("occupancy history", () => {
  it("accepts a clean history with same-day hand-overs", () => {
    const handOver: BedOccupancy = {
      id: "p4",
      personId: BEN,
      roomId: "r1",
      bed: 1,
      from: "2026-10-01",
      to: "2026-10-05",
    };
    expect(
      checkOccupancyHistory([...history.filter((p) => p.id !== "p3"), handOver], ROOMS),
    ).toEqual([]);
  });

  it.each<[string, BedOccupancy, string]>([
    [
      "hazard HZ-001 two people in one bed on the same day",
      { id: "x", personId: BEN, roomId: "r1", bed: 1, from: "2026-09-30", to: "2026-10-02" },
      "bed_double_booked",
    ],
    [
      "one person in two beds at once",
      { id: "x", personId: ADA, roomId: "r4", bed: 1, from: "2026-10-05", to: null },
      "person_in_two_beds",
    ],
    [
      "a period that ends before it starts",
      { id: "x", personId: BEN, roomId: "r4", bed: 1, from: "2026-10-05", to: "2026-10-05" },
      "ends_before_start",
    ],
    [
      "a bed the room does not have",
      { id: "x", personId: BEN, roomId: "r1", bed: 2, from: "2026-08-01", to: "2026-08-02" },
      "no_such_bed",
    ],
    [
      "an impossible date",
      { id: "x", personId: BEN, roomId: "r4", bed: 1, from: "2026-02-30", to: null },
      "invalid_date",
    ],
  ])("finds %s", (_label, extra, kind) => {
    const problems = checkOccupancyHistory([...history, extra], ROOMS);
    expect(problems.map((p) => p.kind)).toContain(kind);
  });

  it("answers who is in a bed and where a person is on a date", () => {
    expect(bedOccupantOn(history, "r1", 1, "2026-09-30")).toBe(ADA);
    expect(bedOccupantOn(history, "r1", 1, "2026-10-01")).toBeNull();
    expect(bedOccupantOn(history, "r2", 1, "2026-10-01")).toBe(ADA);
    expect(personBedOn(history, ADA, "2026-08-31")).toBeNull();
    expect(personBedOn(history, ADA, TODAY)?.id).toBe("p2");
  });

  it("hazard HZ-001 labels the room shown on the header from the history", () => {
    expect(roomLabelOn(history, ROOMS, ADA, "2026-09-10")).toBe("Room 1");
    expect(roomLabelOn(history, ROOMS, ADA, TODAY)).toBe("Room 2, bed 1");
    expect(roomLabelOn(history, ROOMS, "nobody", TODAY)).toBeNull();
    expect(roomLabelOn(history, [], ADA, TODAY)).toBeNull();
  });

  it("lists a person's moves in date order", () => {
    expect(moveHistory([...history].reverse(), ADA).map((p) => p.id)).toEqual(["p1", "p2"]);
    const sameDay: BedOccupancy[] = [
      { id: "b", personId: ADA, roomId: "r1", bed: 1, from: "2026-09-01", to: "2026-09-02" },
      { id: "a", personId: ADA, roomId: "r4", bed: 1, from: "2026-09-01", to: "2026-09-02" },
    ];
    expect(moveHistory(sameDay, ADA).map((p) => p.id)).toEqual(["a", "b"]);
  });
});

describe("planning a move", () => {
  const move = (overrides: Partial<BedMoveRequest>): BedMoveRequest => ({
    personId: ADA,
    toRoomId: "r4",
    toBed: 1,
    on: TODAY,
    reason: "Closer to the lounge",
    ...overrides,
  });

  it("closes the current bed and opens the new one on the move day", () => {
    expect(planBedMove(history, ROOMS, move({}), TODAY)).toEqual({
      ok: true,
      close: { periodId: "p2", to: TODAY },
      open: { personId: ADA, roomId: "r4", bed: 1, from: TODAY, to: null },
      backdated: false,
    });
  });

  it("admits a person with no current bed", () => {
    expect(planBedMove(history, ROOMS, move({ personId: "person-cara" }), TODAY)).toMatchObject({
      ok: true,
      close: null,
    });
  });

  it("flags a move recorded after the day it happened", () => {
    expect(planBedMove(history, ROOMS, move({ on: "2026-10-08" }), TODAY)).toMatchObject({
      ok: true,
      backdated: true,
    });
  });

  it.each<[string, Partial<BedMoveRequest>, string]>([
    ["an impossible date", { on: "2026-13-01" }, "invalid_date"],
    ["a move in the future", { on: "2026-10-12" }, "move_in_future"],
    ["a bed the room does not have", { toBed: 3, toRoomId: "r2" }, "no_such_bed"],
    ["a room that does not exist", { toRoomId: "r9" }, "no_such_bed"],
    ["a room out of service", { toRoomId: "r3" }, "room_unavailable"],
    ["no reason", { reason: " " }, "reason_required"],
    ["the bed the person is already in", { toRoomId: "r2", toBed: 1 }, "same_bed"],
    ["a date before the current bed", { on: "2026-09-20" }, "before_current_start"],
    [
      "the day the person moved into the current bed",
      { on: "2026-10-01" },
      "same_day_as_current_start",
    ],
    ["hazard HZ-001 a bed someone else occupies", { toRoomId: "r2", toBed: 2 }, "bed_occupied"],
  ])("refuses %s", (_label, overrides, problem) => {
    expect(planBedMove(history, ROOMS, move(overrides), TODAY)).toMatchObject({
      ok: false,
      problem,
    });
  });

  it("refuses a backdated move into a bed someone occupied later", () => {
    const left: BedOccupancy[] = [
      ...history,
      { id: "p5", personId: BEN, roomId: "r4", bed: 1, from: "2026-10-03", to: "2026-10-06" },
    ];
    expect(planBedMove(left, ROOMS, move({ on: "2026-10-02" }), TODAY)).toMatchObject({
      ok: false,
      problem: "bed_occupied",
    });
    expect(planBedMove(left, ROOMS, move({ on: "2026-10-06" }), TODAY)).toMatchObject({ ok: true });
  });
});

describe("releasing a bed", () => {
  it("ends the open period on the day the person leaves", () => {
    expect(planBedRelease(history, ADA, TODAY)).toEqual({ periodId: "p2", to: TODAY });
  });

  it("keeps a day in the bed for someone who leaves on the day they arrived", () => {
    expect(planBedRelease(history, ADA, "2026-10-01")).toEqual({
      periodId: "p2",
      to: "2026-10-02",
    });
  });

  it("does nothing without an open period or with a bad date", () => {
    expect(planBedRelease(history, "nobody", TODAY)).toBeNull();
    expect(planBedRelease(history, ADA, "2026-09-01")).toBeNull();
    expect(planBedRelease(history, ADA, "not a date")).toBeNull();
  });
});
