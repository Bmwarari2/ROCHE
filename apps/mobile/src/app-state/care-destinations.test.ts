import { describe, expect, it } from "vitest";
import {
  careDestinations,
  careTabs,
  HANDOVER_PERMISSION,
  MEDICINES_PERMISSION,
  SHIFTS_PERMISSIONS,
  TRAINING_SELF,
} from "./care-destinations";

/** ADR-0138: the tab bar never holds more than five, whatever the member may do. */
describe("Care mode destinations", () => {
  const everything = [
    HANDOVER_PERMISSION,
    MEDICINES_PERMISSION,
    ...SHIFTS_PERMISSIONS,
    TRAINING_SELF,
  ];

  it("gives a member with every permission five tabs, with the rest under More", () => {
    const destinations = careDestinations(everything);
    expect(destinations).toEqual({ medicines: true, handover: true, shifts: true, training: true });
    expect(careTabs(destinations)).toEqual(["today", "round", "medicines", "people", "more"]);
  });

  it("leaves Medicines out for a member who does not give medicines", () => {
    expect(careTabs(careDestinations([]))).toEqual(["today", "round", "people", "more"]);
  });

  it("offers Shifts for either clocking or lone working", () => {
    for (const permission of SHIFTS_PERMISSIONS) {
      expect(careDestinations([permission]).shifts).toBe(true);
    }
    expect(careDestinations([]).shifts).toBe(false);
  });

  it("never gives more than five tabs", () => {
    expect(careTabs(careDestinations(everything)).length).toBeLessThanOrEqual(5);
  });
});
