import { BestInterestsItemKey, ConsentDecisionKind, DolsStatus } from "@harbour/contracts";
import { BEST_INTERESTS_CHECKLIST, FUNCTIONAL_ELEMENT_WORDING } from "@harbour/domain";
import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  BEST_INTERESTS_ITEMS,
  capacityChip,
  checklistAnswered,
  consentChip,
  consentGivenBy,
  consentRecordChip,
  consentRecordState,
  dolsChip,
  dolsClock,
  dolsCqcLine,
  dolsReminders,
  FUNCTIONAL_ELEMENTS,
  reviewOverdue,
  staffName,
} from "./mca";

const t = createTranslator("en-GB");
const RECORD = "0194d000-0000-7000-8600-0000000000c1";
const OTHER = "0194d000-0000-7000-8600-0000000000c2";

describe("consent by decision (care.md rule 9)", () => {
  it("names every decision the API lists", () => {
    for (const decision of ConsentDecisionKind.options) {
      expect(t("care.mca.decision", { decision })).not.toBe("Other decision");
    }
  });

  it.each([
    ["valid", [], "done", "Consent in place"],
    ["refused", [], "info", "Refused"],
    ["none", ["no_record"], "notRecorded", "Not recorded"],
    ["none", ["withdrawn"], "overdue", "No valid consent"],
    ["none", ["expired"], "overdue", "No valid consent"],
    ["none", ["person_has_capacity_now"], "overdue", "No valid consent"],
  ] as const)("hazard HZ-026 shows %s %j as %s, in words", (status, problems, chip, label) => {
    expect(consentChip({ status, problems: [...problems] }, t)).toMatchObject({
      status: chip,
      label,
    });
  });

  it("hazard HZ-026 never shows an unknown status as consent in place", () => {
    const status = "maybe" as "none";
    expect(consentChip({ status, problems: [] }, t).status).toBe("overdue");
  });
});

describe("DoLS register (care.md rule 11)", () => {
  it("hazard HZ-020 gives every status the API returns an icon and a word, and warns on an unknown one", () => {
    for (const status of DolsStatus.options) {
      const chip = dolsChip(status, t);
      expect(chip.label).not.toBe("Status could not be read");
      expect(chip.icon).toBeTruthy();
    }
    expect(dolsChip("expired", t)).toMatchObject({ status: "overdue", label: "Expired" });
    expect(dolsChip("expiring", t)).toMatchObject({ status: "due", label: "Ending soon" });
    expect(dolsChip("lapsed", t)).toMatchObject({
      status: "overdue",
      label: "Status could not be read",
    });
  });

  const granted = { grantedFrom: "2026-10-05T09:00:00Z", endsAt: "2026-10-12T09:00:00Z" };

  it.each([
    [
      "an urgent authorisation ending soon",
      { ...granted, status: "expiring" as const, daysLeft: 3 },
      ["Started 05/10/2026 10:00", "Ends 12/10/2026 10:00", "3 days left"],
    ],
    [
      "its last day",
      { ...granted, status: "expiring" as const, daysLeft: 0 },
      ["Started 05/10/2026 10:00", "Ends 12/10/2026 10:00", "Last day in force"],
    ],
    [
      "one that has expired",
      { ...granted, status: "expired" as const, daysLeft: null },
      ["Started 05/10/2026 10:00", "Expired 12/10/2026 10:00"],
    ],
    [
      "one that ended early",
      { ...granted, status: "ended" as const, daysLeft: null },
      ["Started 05/10/2026 10:00", "Ended 12/10/2026 10:00"],
    ],
    [
      "one that starts later",
      { ...granted, status: "not_started" as const, daysLeft: 9 },
      ["Starts 05/10/2026 10:00", "Ends 12/10/2026 10:00"],
    ],
    [
      "a court order with no end date",
      { ...granted, endsAt: null, status: "active" as const, daysLeft: null },
      ["Started 05/10/2026 10:00", "No end date"],
    ],
    [
      "a request awaiting its outcome",
      { grantedFrom: null, endsAt: null, status: "requested" as const, daysLeft: null },
      [],
    ],
  ])("hazard HZ-020 shows the clock of %s in words and UK dates", (_name, item, lines) => {
    expect(dolsClock(item, t)).toEqual(lines);
  });

  it("hazard HZ-020 lists the expiry reminders while the authorisation is still to end", () => {
    const reminders = [
      { key: "first" as const, daysBefore: 28, dueAt: "2026-10-05T09:00:00Z" },
      { key: "second" as const, daysBefore: 7, dueAt: "2026-11-01T10:00:00Z" },
    ];
    expect(dolsReminders({ status: "active", reminders }, t)).toEqual([
      "Expiry reminder to the Registered Manager: 05/10/2026 10:00",
      "Expiry reminder to the Registered Manager: 01/11/2026 10:00",
    ]);
    expect(dolsReminders({ status: "expired", reminders }, t)).toEqual([]);
    expect(dolsReminders({ status: "ended", reminders }, t)).toEqual([]);
  });

  it("hazard HZ-020 says where the CQC notification stands, or why there is none", () => {
    const cqc = (over: object) => ({
      cqcNotification: {
        required: true,
        reason: "The outcome is known.",
        notificationId: null,
        status: null,
        dueAt: "2026-10-12T09:00:00Z",
        ...over,
      },
    });
    expect(dolsCqcLine(cqc({ status: "draft" }), t)).toBe(
      "CQC notification drafted. Due 12/10/2026 10:00.",
    );
    expect(dolsCqcLine(cqc({ status: "submitted" }), t)).toBe("CQC notification submitted.");
    expect(dolsCqcLine(cqc({}), t)).toBe(
      "CQC notification needed but not drafted. Tell the Registered Manager.",
    );
    expect(dolsCqcLine(cqc({ required: false, reason: "Not yet." }), t)).toBe("Not yet.");
  });
});

describe("consent records (care.md rule 9)", () => {
  const decisions = [
    { decision: "bed_rails" as const, status: "valid" as const, recordId: RECORD },
    { decision: "photos" as const, status: "none" as const, recordId: RECORD },
  ];
  const record = (over: Partial<Parameters<typeof consentRecordState>[0]>) => ({
    id: RECORD,
    decision: "bed_rails" as const,
    withdrawnAt: null,
    expiresAt: null,
    ...over,
  });
  const now = new Date("2026-10-12T09:00:00Z");

  it.each([
    ["the record deciding a valid consent", record({}), "in_force", "In force"],
    [
      "a record a later one replaced",
      record({ id: OTHER }),
      "replaced",
      "Replaced by a later record",
    ],
    [
      "a withdrawn record",
      record({ withdrawnAt: "2026-10-01T09:00:00Z" }),
      "withdrawn",
      "Withdrawn",
    ],
    [
      "an expired deciding record",
      record({ decision: "photos", expiresAt: "2026-10-01T09:00:00Z" }),
      "expired",
      "Expired",
    ],
    [
      "a deciding record that is not valid",
      record({ decision: "photos" }),
      "not_valid",
      "Not valid",
    ],
  ] as const)("hazard HZ-026 says where %s stands", (_name, item, state, label) => {
    const found = consentRecordState(item, decisions, now);
    expect(found).toBe(state);
    expect(consentRecordChip(found, t).label).toBe(label);
  });

  it("names the representative with their authority, or the person", () => {
    const representative = {
      kind: "lpa_health_welfare" as const,
      name: "Sam Example",
      excludedDecisions: [],
      deputyDecisions: [],
    };
    expect(consentGivenBy({ givenBy: "representative", representative }, "Else", t)).toBe(
      "Sam Example (health and welfare attorney)",
    );
    expect(consentGivenBy({ givenBy: "person", representative: null }, "Else", t)).toBe("Else");
  });

  it("names staff with their job title when there is one", () => {
    const staff = { id: RECORD, displayName: "Nell Nurse", jobTitle: "Clinical lead" };
    expect(staffName(staff, t)).toBe("Nell Nurse, Clinical lead");
    expect(staffName({ ...staff, jobTitle: null }, t)).toBe("Nell Nurse");
  });
});

describe("capacity and best interests (care.md rules 9 and 10)", () => {
  it("keeps the functional test and the section 4 checklist in the domain's order", () => {
    expect([...FUNCTIONAL_ELEMENTS]).toEqual(Object.keys(FUNCTIONAL_ELEMENT_WORDING));
    expect([...BEST_INTERESTS_ITEMS]).toEqual(BEST_INTERESTS_CHECKLIST.map((item) => item.key));
    expect([...BEST_INTERESTS_ITEMS].sort()).toEqual([...BestInterestsItemKey.options].sort());
    const items = BEST_INTERESTS_ITEMS.map((item) => t("care.mca.bi.item", { item }));
    expect(new Set(items).size).toBe(BEST_INTERESTS_ITEMS.length);
  });

  it("hazard HZ-026 shows the outcome in words, as a finding rather than an alarm", () => {
    expect(capacityChip("lacks_capacity", t)).toMatchObject({
      status: "info",
      label: "Lacks capacity for this decision",
    });
    expect(capacityChip("has_capacity", t)).toMatchObject({
      status: "neutral",
      label: "Has capacity for this decision",
    });
  });

  it("compares review dates as UK dates", () => {
    expect(reviewOverdue("2026-10-11", "2026-10-12")).toBe(true);
    expect(reviewOverdue("2026-10-12", "2026-10-12")).toBe(false);
    expect(reviewOverdue(null, "2026-10-12")).toBe(false);
  });

  it("counts the checklist items answered", () => {
    expect(
      checklistAnswered({
        checklist: {
          relevant_circumstances: { answer: "considered", note: "Asked about home." },
          life_sustaining_treatment: { answer: "not_applicable", reason: "Not treatment." },
        },
      }),
    ).toBe(2);
  });
});
