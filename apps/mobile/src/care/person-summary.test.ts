import { describe, expect, it } from "vitest";
import {
  type AdvanceCareRow,
  iddsiFlags,
  resuscitationDetails,
  resuscitationFlag,
  toAdvanceCareStates,
} from "./person-summary";

const TODAY = "2026-10-11";

const record = (overrides: Partial<AdvanceCareRow> = {}): AdvanceCareRow => ({
  id: "acr-1",
  kind: "dnacpr",
  status: "active",
  cpr_decision: "do_not_attempt_cpr",
  clinician_name: "Dr Ivy Example",
  clinician_role: "GP",
  completed_on: "2026-03-02",
  review_due_on: "2027-03-02",
  ...overrides,
});

describe("hazard HZ-015 resuscitation status in the header", () => {
  it("reads 'not recorded' with a warning when no decision is on the device, never blank", () => {
    const { flag } = resuscitationFlag([], TODAY);
    expect(flag).toEqual({
      key: "resuscitation",
      tone: "warning",
      icon: "circle-help",
      label: "Resuscitation: not recorded",
      accessibilityLabel: "Resuscitation decision not recorded.",
    });
  });

  it("shows a DNACPR decision as a word and an icon, with where it comes from", () => {
    const { flag } = resuscitationFlag([record()], TODAY);
    expect(flag.label).toBe("Resuscitation: do not attempt CPR");
    expect(flag.icon).toBe("heart-off");
    expect(flag.tone).toBe("danger");
    expect(flag.accessibilityLabel).toBe(
      "Resuscitation decision: do not attempt CPR. DNACPR form completed 02/03/2026. Clinician: Dr Ivy Example, GP.",
    );
  });

  it("shows a ReSPECT recommendation to attempt CPR", () => {
    const { flag } = resuscitationFlag(
      [record({ kind: "respect", cpr_decision: "attempt_cpr" })],
      TODAY,
    );
    expect(flag).toMatchObject({ label: "Resuscitation: attempt CPR", icon: "heart-pulse" });
  });

  it("keeps a decision whose review is overdue, and says the review is overdue", () => {
    const { flag, status } = resuscitationFlag([record({ review_due_on: "2026-09-01" })], TODAY);
    expect(flag.label).toBe("Resuscitation: do not attempt CPR");
    expect(status.reviewOverdue).toBe(true);
    expect(flag.accessibilityLabel).toContain("Review overdue since 01/09/2026.");
  });

  it("flags records in force that disagree so staff check the documents", () => {
    const { flag } = resuscitationFlag(
      [
        record({ id: "a", completed_on: "2026-03-02" }),
        record({
          id: "b",
          kind: "respect",
          cpr_decision: "attempt_cpr",
          completed_on: "2026-01-02",
        }),
      ],
      TODAY,
    );
    expect(flag).toMatchObject({
      label: "Resuscitation: records disagree",
      tone: "danger",
      icon: "triangle-alert",
    });
  });

  it("ignores withdrawn records and rows it cannot read, rather than guessing", () => {
    expect(resuscitationFlag([record({ status: "withdrawn" })], TODAY).flag.label).toBe(
      "Resuscitation: not recorded",
    );
    expect(
      toAdvanceCareStates([record({ kind: "something" }), record({ completed_on: null })]),
    ).toEqual([]);
  });

  it("has no detail lines when nothing is recorded", () => {
    expect(resuscitationDetails(resuscitationFlag([], TODAY).status)).toEqual([]);
  });
});

describe("hazard HZ-016 prescribed IDDSI levels in the header", () => {
  it("shows food and drink levels with number, name and colour", () => {
    expect(
      iddsiFlags({ iddsi_food_level: "5", iddsi_drink_level: "2" }).map((f) => f.label),
    ).toEqual(["Food: Level 5 Minced and moist (orange)", "Drinks: Level 2 Mildly thick (pink)"]);
  });

  it("shows nothing when no level is prescribed, and an unknown code as recorded", () => {
    expect(iddsiFlags(null)).toEqual([]);
    expect(
      iddsiFlags({ iddsi_food_level: "9", iddsi_drink_level: null }).map((f) => f.label),
    ).toEqual(["Food: 9"]);
  });
});
