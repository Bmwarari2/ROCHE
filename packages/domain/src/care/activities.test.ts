import { describe, expect, it } from "vitest";
import {
  type ActivityInput,
  canWriteForPerson,
  checkActivity,
  checkVisit,
  isClosedRecord,
  type VisitInput,
} from "./activities";

/**
 * Activities and wellbeing, the Reg 9A visiting log (register row CARE-014), and read-only records
 * for people who have left (care.md section 4 rule 12).
 */

const activity = (overrides: Partial<ActivityInput> = {}): ActivityInput => ({
  format: "one_to_one",
  groupSessionId: null,
  attendance: "attended",
  engagement: "engaged_throughout",
  ...overrides,
});

describe("activity records", () => {
  it.each<[string, Partial<ActivityInput>, string | null]>([
    ["a one-to-one activity", {}, null],
    ["a group session recorded for one person", { format: "group", groupSessionId: "g1" }, null],
    ["a group activity with no session", { format: "group" }, "groupSessionId"],
    ["a one-to-one activity with a session", { groupSessionId: "g1" }, "groupSessionId"],
    ["attended with no engagement recorded", { engagement: null }, "engagement"],
    [
      "partly attended with engagement",
      { attendance: "partly_attended", engagement: "engaged_briefly" },
      null,
    ],
    ["declined, with no engagement", { attendance: "declined", engagement: null }, null],
    [
      "declined, with engagement",
      { attendance: "declined", engagement: "engaged_briefly" },
      "engagement",
    ],
    ["not able to take part", { attendance: "not_able", engagement: null }, null],
  ])("%s", (_label, overrides, field) => {
    const check = checkActivity(activity(overrides));
    expect(check.ok ? null : check.field).toBe(field);
  });
});

const NOW = new Date("2026-10-11T15:00:00Z");
const visit = (overrides: Partial<VisitInput> = {}): VisitInput => ({
  kind: "facilitated_visit",
  contactId: "c1",
  visitorName: null,
  startedAt: new Date("2026-10-11T13:00:00Z"),
  endedAt: new Date("2026-10-11T14:30:00Z"),
  restrictionsApplied: false,
  restrictionReason: null,
  ...overrides,
});

describe("Regulation 9A visiting log", () => {
  it.each<[string, Partial<VisitInput>, string | null]>([
    ["a visit from a recorded contact", {}, null],
    [
      "a visitor named in free text",
      { contactId: null, visitorName: "Neighbour, Sam Example" },
      null,
    ],
    ["a visitor with no name or contact", { contactId: null, visitorName: " " }, "visitor"],
    ["a visit out still in progress", { kind: "visit_out", endedAt: null }, null],
    ["an accompaniment to hospital", { kind: "accompaniment" }, null],
    ["an end before the start", { endedAt: new Date("2026-10-11T12:59:00Z") }, "endedAt"],
    ["an end in the future", { endedAt: new Date("2026-10-11T16:00:00Z") }, "endedAt"],
    [
      "a restriction with its reason",
      {
        restrictionsApplied: true,
        restrictionReason: "Outbreak of norovirus on the unit; visit held in the garden room.",
      },
      null,
    ],
    [
      "a restriction with no reason",
      { restrictionsApplied: true, restrictionReason: "" },
      "restrictionReason",
    ],
    [
      "a reason with no restriction",
      { restrictionReason: "Garden room only." },
      "restrictionReason",
    ],
  ])("%s", (_label, overrides, field) => {
    const check = checkVisit(visit(overrides), NOW);
    expect(check.ok ? null : check.field).toBe(field);
  });
});

describe("rule 12: people who have left are read-only except post-event records", () => {
  it.each([
    ["enquiry", false],
    ["active", false],
    ["on_leave", false],
    ["in_hospital", false],
    ["discharged", true],
    ["deceased", true],
    ["archived", true],
  ] as const)("%s is closed: %s", (status, closed) => {
    expect(isClosedRecord(status)).toBe(closed);
  });

  it.each([
    ["active", "care_record", true],
    ["in_hospital", "care_record", true],
    ["discharged", "care_record", false],
    ["deceased", "care_record", false],
    ["archived", "care_record", false],
    ["deceased", "post_event", true],
    ["discharged", "post_event", true],
    ["archived", "post_event", true],
  ] as const)("%s person, %s: writable %s", (status, kind, expected) => {
    expect(canWriteForPerson(status, kind)).toBe(expected);
  });
});
