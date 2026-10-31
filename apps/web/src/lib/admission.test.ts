import type {
  AdmissionDecisionItem,
  BedBoard,
  BedOccupancyItem,
  KeyIssueOut,
  PersonStatus,
  PreAdmissionView,
  PropertyItemOut,
  WelcomeChecklist,
} from "@harbour/contracts";
import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  admissionReadiness,
  assessmentProgress,
  assessmentSections,
  checklistChip,
  checklistItems,
  checklistProgress,
  currentDecision,
  decisionChip,
  freeBeds,
  isPreAdmissionStage,
  keyChip,
  keysView,
  mayMoveRoom,
  mayRecordPropertyIn,
  mayRecordPropertyOut,
  mayTickChecklist,
  moveHistoryView,
  needsWitness,
  personStatusChip,
  preAdmissionShown,
  propertyChip,
  propertyOpen,
  propertyView,
  readBedChoice,
  readConditions,
  readMedicineRows,
  readQuantity,
  returnCapacities,
  sectionChip,
  splitPreAdmission,
  travelsWithPerson,
  valuableCategory,
  whoDid,
} from "./admission";

/**
 * The admission and property helpers (people.md rules 1 and 4 to 7; PEOP-005, PEOP-007). Table
 * driven where they mirror a rule the API applies again; named with the hazard they help control.
 */

const t = createTranslator("en-GB");
const ME = "0194d000-0000-7000-8000-000000000302";
const OTHER = "0194d000-0000-7000-8000-000000000303";
const ROOM = (n: number) => `0194d000-0000-7000-8400-${n.toString(16).padStart(12, "0")}`;

describe("who sees enquiries and pre-admission", () => {
  it.each<[string, string[], boolean]>([
    [
      "a Registered Manager",
      ["people.person.read", "people.enquiry.manage", "people.admission.manage"],
      true,
    ],
    ["a nurse who writes the sections", ["people.person.read", "care.plan.write"], true],
    ["a care worker", ["people.person.read", "care.note.write"], false],
    ["someone managing enquiries who cannot read records", ["people.enquiry.manage"], false],
  ])("%s: %s", (_who, permissions, shown) => {
    expect(preAdmissionShown(permissions)).toBe(shown);
  });

  it("keeps people not yet admitted off the residents' list and splits open from closed", () => {
    const statuses: PersonStatus[] = [
      "enquiry",
      "pre_admission",
      "not_admitted",
      "active",
      "discharged",
    ];
    expect(statuses.filter(isPreAdmissionStage)).toEqual([
      "enquiry",
      "pre_admission",
      "not_admitted",
    ]);
    const people = statuses.map((status, n) => ({ id: String(n), status }));
    const { open, closed } = splitPreAdmission(people);
    expect(open.map((p) => p.status)).toEqual(["enquiry", "pre_admission"]);
    expect(closed.map((p) => p.status)).toEqual(["not_admitted"]);
  });

  it.each<PersonStatus>([
    "enquiry",
    "pre_admission",
    "active",
    "on_leave",
    "in_hospital",
    "discharged",
    "deceased",
    "archived",
    "not_admitted",
  ])("names the status %s in words, with an icon", (status) => {
    const chip = personStatusChip(status);
    expect(chip.icon).toBeTruthy();
    expect(t("people.status.label", { status })).not.toBe(status);
  });
});

const definitions: PreAdmissionView["definitions"] = [
  {
    key: "allergies",
    title: "Allergies",
    required: true,
    allowNotApplicable: false,
    hazardIds: ["HZ-007"],
  },
  { key: "equipment", title: "Equipment", required: true, allowNotApplicable: true, hazardIds: [] },
  {
    key: "medicines",
    title: "Medicines",
    required: true,
    allowNotApplicable: false,
    hazardIds: [],
  },
  {
    key: "hospital_passport",
    title: "Passport",
    required: false,
    allowNotApplicable: true,
    hazardIds: [],
  },
];

const view = (sections: object, outstanding: { key: string; problem: string }[] = []) =>
  ({
    definitions,
    assessment: {
      id: "a",
      personId: "p",
      serviceId: null,
      placementTypeSought: null,
      status: "in_progress",
      sections,
      informationSources: [],
      personInvolvement: null,
      assessorTenantUserId: null,
      completeness: {
        complete: false,
        outstanding,
        sourcesMissing: true,
        involvementMissing: true,
        lastCompletedAt: null,
      },
      version: 3,
    },
  }) as PreAdmissionView;

const done = (status: string, extra: object = {}) => ({
  status,
  notes: "Found",
  notApplicableReason: null,
  medicines: null,
  completedBy: ME,
  completedAt: "2026-10-30T10:00:00Z",
  ...extra,
});

describe("the pre-admission assessment (rule 4)", () => {
  it("hazard HZ-007 never shows a required section with nothing recorded as calm", () => {
    const sections = assessmentSections(
      view({ equipment: done("not_applicable", { notApplicableReason: "None needed" }) }, [
        { key: "allergies", problem: "not_started" },
      ]),
    );
    const allergies = sections.find((s) => s.key === "allergies");
    expect(allergies).toMatchObject({ state: "not_started", problem: "not_started" });
    expect(allergies && sectionChip(allergies)).toBe("notRecorded");
    const passport = sections.find((s) => s.key === "hospital_passport");
    expect(passport && sectionChip(passport)).toBe("neutral");
    const equipment = sections.find((s) => s.key === "equipment");
    expect(equipment).toMatchObject({
      state: "not_applicable",
      notApplicableReason: "None needed",
    });
    expect(equipment && sectionChip(equipment)).toBe("notApplicable");
  });

  it.each<[string, object, string]>([
    ["done", done("complete"), "complete"],
    ["still being found out", { status: "in_progress", notes: "Asking the GP" }, "in_progress"],
    ["marked done without who and when", { status: "complete", completedAt: null }, "in_progress"],
  ])("reads a section %s", (_label, section, state) => {
    const [allergies] = assessmentSections(view({ allergies: section }));
    expect(allergies?.state).toBe(state);
  });

  it("counts required sections done, not optional ones", () => {
    const sections = assessmentSections(
      view({
        allergies: done("complete"),
        equipment: done("not_applicable", { notApplicableReason: "None" }),
        hospital_passport: done("complete"),
      }),
    );
    expect(assessmentProgress(sections)).toEqual({ done: 2, required: 3 });
  });

  it("reads the medicines rows: blank rows dropped, half-filled rows named by number", () => {
    const row = (name: string, dose = "5 mg", route = "Mouth", frequency = "Daily") => ({
      name,
      dose,
      route,
      frequency,
      timeCritical: false,
    });
    expect(
      readMedicineRows([row("Levodopa"), row("", "", "", ""), row("Paracetamol", "")]),
    ).toEqual({
      medicines: [row("Levodopa")],
      incomplete: [3],
    });
  });

  it("shows nothing when the person has no assessment", () => {
    const sections = assessmentSections({ definitions, assessment: null });
    expect(sections.every((s) => s.state === "not_started")).toBe(true);
  });
});

const decision = (overrides: Partial<AdmissionDecisionItem> = {}): AdmissionDecisionItem => ({
  id: "d1",
  personId: "p",
  assessmentId: "a",
  canMeetNeeds: "yes",
  admit: true,
  reasons: "The nursing unit can meet every need found.",
  plannedAdmissionOn: null,
  trialEndsOn: null,
  decidedBy: ME,
  decidedAt: "2026-10-30T10:00:00Z",
  toldWho: null,
  toldAt: null,
  supersedesId: null,
  correctionReason: null,
  superseded: false,
  conditions: [],
  ...overrides,
});

const condition = (metAt: string | null) => ({
  id: `c${metAt ?? "open"}`,
  position: 0,
  condition: "Pressure-relieving mattress in place",
  metBy: metAt ? ME : null,
  metAt,
  version: 1,
});

describe("the decision to admit (rule 5)", () => {
  it.each<[string, AdmissionDecisionItem | null, ReturnType<typeof admissionReadiness>]>([
    ["no decision", null, { ready: false, reason: "no_decision" }],
    [
      "a decision that the home cannot meet needs",
      decision({ canMeetNeeds: "no", admit: false }),
      { ready: false, reason: "decision_declined" },
    ],
    [
      "a condition not yet met",
      decision({ canMeetNeeds: "yes_with_conditions", conditions: [condition(null)] }),
      { ready: false, reason: "conditions_not_met" },
    ],
    [
      "every condition met",
      decision({
        canMeetNeeds: "yes_with_conditions",
        conditions: [condition("2026-10-30T11:00:00Z")],
      }),
      { ready: true },
    ],
    ["a positive decision with no conditions", decision(), { ready: true }],
  ])("admission waits on %s", (_label, input, expected) => {
    expect(admissionReadiness(input)).toEqual(expected);
  });

  it("takes the latest decision not replaced as the one in force, the rest newest first", () => {
    const first = decision({ id: "d1", decidedAt: "2026-10-28T10:00:00Z", superseded: true });
    const second = decision({
      id: "d2",
      decidedAt: "2026-10-30T10:00:00Z",
      supersedesId: "d1",
      canMeetNeeds: "no",
      admit: false,
    });
    const { current, earlier } = currentDecision([first, second]);
    expect(current?.id).toBe("d2");
    expect(earlier.map((d) => d.id)).toEqual(["d1"]);
  });

  it("says each answer with an icon and a word", () => {
    expect(decisionChip("yes").status).toBe("done");
    expect(decisionChip("yes_with_conditions").status).toBe("due");
    expect(decisionChip("no").status).toBe("neutral");
    expect(t("people.decision.answer", { answer: "no" })).toBe("Cannot meet needs");
  });

  it("drops blank conditions and trims the rest", () => {
    expect(readConditions(["  Mattress  ", "", "   ", "Hoist training"])).toEqual([
      "Mattress",
      "Hoist training",
    ]);
  });
});

const board: BedBoard = {
  locationId: "l",
  date: "2026-10-31",
  rooms: [
    {
      roomId: ROOM(1),
      label: "1",
      unitName: "Oak",
      status: "available",
      beds: [
        { bed: 1, occupied: true, personId: "someone", name: "Ada Example", since: "2026-09-01" },
      ],
    },
    {
      roomId: ROOM(2),
      label: "2",
      unitName: "Oak",
      status: "available",
      beds: [
        { bed: 1, occupied: false, personId: null, name: null, since: null },
        { bed: 2, occupied: true, personId: null, name: null, since: "2026-09-01" },
      ],
    },
    {
      roomId: ROOM(3),
      label: "3",
      unitName: "Oak",
      status: "awaiting_clearance",
      beds: [{ bed: 1, occupied: false, personId: null, name: null, since: null }],
    },
    {
      roomId: ROOM(31),
      label: "31",
      unitName: "Willow",
      status: "available",
      beds: [{ bed: 1, occupied: false, personId: null, name: null, since: null }],
    },
  ],
};

describe("rooms, beds and moves (rule 6)", () => {
  it("hazard HZ-001 offers only free beds in rooms in use, grouped by unit", () => {
    const groups = freeBeds(board);
    expect(groups.map((g) => g.unit)).toEqual(["Oak", "Willow"]);
    expect(groups.flatMap((g) => g.beds.map((b) => b.value))).toEqual([
      `${ROOM(2)}:1`,
      `${ROOM(31)}:1`,
    ]);
    // A shared room says which bed; an occupant outside access is still occupied (HZ-011).
    expect(groups[0]?.beds[0]?.shared).toBe(true);
    expect(groups[1]?.beds[0]?.shared).toBe(false);
  });

  it.each<[unknown, ReturnType<typeof readBedChoice>]>([
    [`${ROOM(2)}:1`, { roomId: ROOM(2), bed: 1 }],
    [`${ROOM(2)}:0`, null],
    [`${ROOM(2)}:21`, null],
    ["not-a-room:1", null],
    [`${ROOM(2)}:1:2`, null],
    [null, null],
  ])("reads the bed chosen from %s", (value, expected) => {
    expect(readBedChoice(value)).toEqual(expected);
  });

  it("lists the bed history newest first, the open period as current", () => {
    const period = (id: string, from: string, to: string | null): BedOccupancyItem => ({
      id,
      personId: "p",
      roomId: ROOM(1),
      roomLabel: "1",
      bed: 1,
      from,
      to,
      reason: "Admission",
      backdated: false,
      recordedBy: ME,
      recordedAt: `${from}T10:00:00Z`,
    });
    const view = moveHistoryView([
      period("a", "2026-10-01", "2026-10-20"),
      period("b", "2026-10-20", null),
    ]);
    expect(view.map((v) => [v.item.id, v.current])).toEqual([
      ["b", true],
      ["a", false],
    ]);
  });

  it.each<[PersonStatus, boolean, boolean]>([
    ["active", true, true],
    ["on_leave", true, true],
    ["in_hospital", false, true],
    ["pre_admission", false, false],
    ["discharged", false, false],
    ["deceased", false, false],
  ])("a person %s: room move %s, checklist %s", (status, move, checklist) => {
    expect(mayMoveRoom(status)).toBe(move);
    expect(mayTickChecklist(status)).toBe(checklist);
  });
});

const checklist: WelcomeChecklist = {
  placementId: "pl",
  items: [
    {
      key: "call_bell_explained",
      title: "Call bell explained",
      required: true,
      safetyCritical: false,
      allowNotApplicable: true,
      status: "pending",
      reason: null,
      doneBy: null,
      doneAt: null,
      version: 1,
    },
    {
      key: "allergies_confirmed",
      title: "Allergies confirmed",
      required: true,
      safetyCritical: true,
      allowNotApplicable: false,
      status: "done",
      reason: null,
      doneBy: ME,
      doneAt: "2026-10-30T10:00:00Z",
      version: 2,
    },
    {
      key: "about_me_started",
      title: "About Me started",
      required: false,
      safetyCritical: false,
      allowNotApplicable: true,
      status: "pending",
      reason: null,
      doneBy: null,
      doneAt: null,
      version: 1,
    },
  ],
  complete: false,
  outstanding: ["call_bell_explained"],
  safetyCriticalOutstanding: [],
  invalid: [],
};

describe("the welcome checklist", () => {
  it("lists safety-critical items first and counts required ones", () => {
    expect(checklistItems(checklist).map((i) => i.key)).toEqual([
      "allergies_confirmed",
      "call_bell_explained",
      "about_me_started",
    ]);
    expect(checklistProgress(checklist)).toEqual({ done: 1, required: 2 });
  });

  it.each<[string, "pending" | "done" | "not_applicable", boolean, string]>([
    ["a required item to do", "pending", true, "due"],
    ["an optional item to do", "pending", false, "neutral"],
    ["a done item", "done", true, "done"],
    ["an item that does not apply", "not_applicable", true, "notApplicable"],
  ])("shows %s", (_label, status, required, chip) => {
    expect(checklistChip({ status, required })).toBe(chip);
  });
});

const item = (overrides: Partial<PropertyItemOut> = {}): PropertyItemOut => ({
  id: "i1",
  personId: "p",
  description: "Gold ring",
  category: "jewellery",
  quantity: 1,
  valuable: true,
  photoDocumentIds: [],
  receivedOn: "2026-10-30",
  recordedBy: ME,
  acknowledgement: {
    signer: "person",
    name: "Ivy Example",
    unableReason: null,
    signedAt: "2026-10-30T10:00:00Z",
  },
  witnessedBy: OTHER,
  status: "held",
  hospitalTransferId: null,
  returned: null,
  disposed: null,
  lost: null,
  version: 1,
  ...overrides,
});

describe("property, valuables and keys (rule 7)", () => {
  it.each<
    [
      string,
      {
        category: string;
        valuable: boolean;
        signer: "person" | "representative" | "unable_to_sign" | null;
      },
      boolean,
    ]
  >([
    ["jewellery", { category: "jewellery", valuable: false, signer: "person" }, true],
    ["a watch", { category: "watch", valuable: false, signer: "person" }, true],
    ["electronics", { category: "electronics", valuable: false, signer: "representative" }, true],
    ["documents", { category: "documents", valuable: false, signer: "person" }, true],
    [
      "a painting marked valuable",
      { category: "ornament_or_picture", valuable: true, signer: "person" },
      true,
    ],
    [
      "clothing nobody could sign for",
      { category: "clothing", valuable: false, signer: "unable_to_sign" },
      true,
    ],
    ["clothing signed for", { category: "clothing", valuable: false, signer: "person" }, false],
  ])("a second member of staff witnesses %s: %s", (_label, input, expected) => {
    expect(needsWitness(input)).toBe(expected);
  });

  it("always treats the valuable categories as valuables", () => {
    expect(["jewellery", "watch", "electronics", "documents"].every(valuableCategory)).toBe(true);
    expect(valuableCategory("clothing")).toBe(false);
  });

  it("offers glasses, hearing aids, dentures and walking aids for the hospital", () => {
    expect(["sensory_aid", "dentures", "mobility_aid"].every(travelsWithPerson)).toBe(true);
    expect(travelsWithPerson("jewellery")).toBe(false);
  });

  it("returns property after a death only to the personal representative", () => {
    expect(returnCapacities("deceased")).toEqual(["personal_representative"]);
    expect(returnCapacities("active")).toContain("person");
  });

  it.each<[PersonStatus, boolean, boolean]>([
    ["active", true, true],
    ["in_hospital", true, true],
    ["discharged", false, true],
    ["deceased", false, true],
    ["pre_admission", false, false],
    ["archived", false, false],
  ])("a person %s: items in %s, items back %s", (status, into, out) => {
    expect(mayRecordPropertyIn(status)).toBe(into);
    expect(mayRecordPropertyOut(status)).toBe(out);
  });

  it("closes each item once: held or away items can leave, closed ones cannot", () => {
    expect(propertyOpen({ status: "held" })).toBe(true);
    expect(propertyOpen({ status: "sent_with_person" })).toBe(true);
    expect(
      ["returned", "disposed", "lost"].map((status) => propertyOpen({ status } as PropertyItemOut)),
    ).toEqual([false, false, false]);
  });

  it("lists held items first, then closed ones, newest first", () => {
    const { open, closed } = propertyView([
      item({ id: "old", receivedOn: "2026-10-01" }),
      item({ id: "gone", status: "returned", receivedOn: "2026-10-31" }),
      item({ id: "new", receivedOn: "2026-10-30" }),
    ]);
    expect(open.map((i) => i.id)).toEqual(["new", "old"]);
    expect(closed.map((i) => i.id)).toEqual(["gone"]);
  });

  it("says each item's status in words, lost as a warning", () => {
    expect(propertyChip("lost").status).toBe("overdue");
    expect(propertyChip("returned").status).toBe("done");
    expect(t("people.property.status", { status: "sent_with_person" })).toBe(
      "Away with the person",
    );
  });

  it.each<[unknown, number | null]>([
    ["1", 1],
    [" 12 ", 12],
    ["0", null],
    ["1.5", null],
    ["-2", null],
    ["10001", null],
    ["", null],
    [null, null],
  ])("reads the count %s", (value, expected) => {
    expect(readQuantity(value)).toBe(expected);
  });

  it("lists keys still out first: they keep an exit open", () => {
    const key = (id: string, issuedOn: string, returnedOn: string | null): KeyIssueOut => ({
      id,
      personId: "p",
      label: `Key ${id}`,
      issuedOn,
      issuedTo: "person",
      returnedOn,
      reportedLostOn: null,
      outstanding: returnedOn === null,
      version: 1,
    });
    expect(
      keysView([key("a", "2026-10-31", "2026-10-31"), key("b", "2026-10-01", null)]).map(
        (k) => k.id,
      ),
    ).toEqual(["b", "a"]);
    expect(keyChip({ returnedOn: null, reportedLostOn: "2026-10-31" })).toEqual({
      status: "overdue",
      state: "lost",
    });
    expect(keyChip({ returnedOn: null, reportedLostOn: null }).state).toBe("out");
  });
});

describe("who did it", () => {
  it("says you, a colleague, or someone, never an id", () => {
    expect(whoDid(ME, ME)).toBe("you");
    expect(whoDid(OTHER, ME)).toBe("colleague");
    expect(whoDid(null, ME)).toBe("unknown");
    expect(t("people.room.recorded", { when: "31/10/2026 10:00", by: "colleague" })).toBe(
      "Recorded 31/10/2026 10:00 by a colleague",
    );
  });
});
