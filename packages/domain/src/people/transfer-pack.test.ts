import { describe, expect, it } from "vitest";
import {
  assembleHospitalTransferPack,
  checkTransferPackHandover,
  type HospitalTransferInput,
  type HospitalTransferPack,
  RETURN_FROM_HOSPITAL_CHECKS,
  returnFromHospitalChecks,
  TRANSFER_PACK_SECTIONS,
} from "./transfer-pack";

const ADA = "person-ada";
const AS_OF = new Date("2026-10-11T06:00:00Z");
const NOW = new Date("2026-10-11T09:15:00Z");

function source<T>(data: T, personId = ADA) {
  return { personId, asOf: AS_OF, data };
}

function input(overrides: Partial<HospitalTransferInput> = {}): HospitalTransferInput {
  return {
    personStatus: "active",
    identity: {
      personId: ADA,
      givenName: "Ada",
      familyName: "Example",
      preferredName: "Addie",
      dateOfBirth: "1938-04-02",
      nhsNumber: "9990000018",
      gpPracticeOdsCode: null,
    },
    generatedAt: NOW,
    generatedBy: "nurse-1",
    photo: source({ documentId: "doc-photo", takenOn: "2026-09-01" }),
    allergies: source({
      status: "has_allergies",
      allergies: [
        { substance: "Plasters", reaction: "Rash", severity: "mild" },
        { substance: "Penicillin", reaction: "Anaphylaxis", severity: "severe" },
      ],
    }),
    medicines: source({
      status: "recorded",
      source: "medicines_list",
      items: [
        {
          name: "Paracetamol 500 mg tablets",
          dose: "1 g",
          route: "oral",
          frequency: "four times a day",
          lastGivenAt: null,
          timeCritical: false,
        },
        {
          name: "Co-careldopa 25 mg/100 mg tablets",
          dose: "1 tablet",
          route: "oral",
          frequency: "08:00, 12:00, 16:00, 20:00",
          lastGivenAt: AS_OF,
          timeCritical: true,
        },
      ],
    }),
    communication: source({
      status: "recorded",
      needs: [{ code: "000000", display: "Requires hearing aid", preferredFormat: "in_person" }],
    }),
    resuscitation: source({
      status: "recorded",
      records: [
        {
          kind: "dnacpr",
          summary: "Old decision",
          clinician: "Dr Example",
          completedOn: "2025-01-01",
          reviewOn: null,
          documentId: null,
          active: false,
        },
        {
          kind: "respect",
          summary: "For ward-based care; not for CPR",
          clinician: "Dr Example",
          completedOn: "2026-06-01",
          reviewOn: "2027-06-01",
          documentId: "doc-respect",
          active: true,
        },
      ],
    }),
    aboutMe: source({ what_is_most_important_to_me: { text: "My cat, Biscuit." } }),
    reasonForTransfer: "Fall at 07:30; hip pain; unable to weight-bear.",
    baseline: source({ description: "Walks with a frame; oriented; continent.", observations: [] }),
    eatingAndDrinking: source({ foodLevel: "7EC", drinkLevel: "0", notes: null }),
    capacityAndLegal: source({ summary: "Has capacity for daily decisions.", dolsInPlace: false }),
    contacts: [
      {
        personId: ADA,
        name: "Ben Example",
        relationship: "son",
        role: "next_of_kin",
        phone: "01632 960000",
      },
    ],
    infection: source({ summary: "No known infection" }),
    property: [
      {
        id: "i1",
        description: "Hearing aid (left)",
        category: "sensory_aid",
        receivedOn: "2026-09-01",
        status: "held",
      },
      {
        id: "i2",
        description: "Walking frame",
        category: "mobility_aid",
        receivedOn: "2026-09-01",
        status: "held",
      },
      {
        id: "i3",
        description: "Wedding ring",
        category: "jewellery",
        receivedOn: "2026-09-01",
        status: "held",
      },
    ],
    sendItemIds: ["i1", "i2"],
    homeContact: { locationName: "Harbour House", phone: "01632 960001" },
    ...overrides,
  };
}

function pack(overrides: Partial<HospitalTransferInput> = {}): HospitalTransferPack {
  const result = assembleHospitalTransferPack(input(overrides));
  if (!result.ok) throw new Error(result.message);
  return result.pack;
}

describe("transfer pack sections", () => {
  it("marks the six safety-critical sections from the spec", () => {
    expect(TRANSFER_PACK_SECTIONS.filter((s) => s.critical).map((s) => s.key)).toEqual([
      "photo",
      "allergies",
      "medicines",
      "communication",
      "resuscitation",
      "about_me",
    ]);
  });

  it("produces a complete pack when everything is recorded", () => {
    const complete = pack();
    expect(complete.complete).toBe(true);
    expect(complete.missingCritical).toEqual([]);
    expect(complete.sections.every((s) => s.status === "included")).toBe(true);
    expect(complete.sections.find((s) => s.key === "allergies")?.asOf).toEqual(AS_OF);
    expect(complete.content.itemsSent.map((i) => i.id)).toEqual(["i1", "i2"]);
    expect(complete.itemsLeftBehind).toEqual([]);
  });
});

describe("hazard HZ-023 missing safety-critical information is flagged, never left blank", () => {
  it.each<[string, Partial<HospitalTransferInput>, string]>([
    ["hazard HZ-001 no photo", { photo: null }, "photo"],
    [
      "hazard HZ-007 allergy status never recorded",
      { allergies: source({ status: "unknown" }) },
      "allergies",
    ],
    [
      "hazard HZ-007 allergies said to exist but none listed",
      { allergies: source({ status: "has_allergies", allergies: [] }) },
      "allergies",
    ],
    ["no medicines list", { medicines: source({ status: "not_recorded" }) }, "medicines"],
    [
      "a medicines list with nothing on it",
      { medicines: source({ status: "recorded", source: "emar", items: [] }) },
      "medicines",
    ],
    [
      "communication needs never assessed",
      { communication: source({ status: "not_recorded" }) },
      "communication",
    ],
    [
      "communication needs recorded as an empty list",
      { communication: source({ status: "recorded", needs: [] }) },
      "communication",
    ],
    [
      "hazard HZ-015 no resuscitation record",
      { resuscitation: source({ status: "not_recorded" }) },
      "resuscitation",
    ],
    [
      "hazard HZ-015 only a withdrawn resuscitation record",
      {
        resuscitation: source({
          status: "recorded",
          records: [
            {
              kind: "dnacpr",
              summary: "Withdrawn",
              clinician: "Dr Example",
              completedOn: "2025-01-01",
              reviewOn: null,
              documentId: null,
              active: false,
            },
          ],
        }),
      },
      "resuscitation",
    ],
    ["no About Me", { aboutMe: null }, "about_me"],
    [
      "an About Me with nothing in it",
      { aboutMe: source({ my_wellness: { text: " " } }) },
      "about_me",
    ],
  ])("%s", (_label, overrides, key) => {
    const incomplete = pack(overrides);
    expect(incomplete.missingCritical).toEqual([key]);
    expect(incomplete.complete).toBe(false);
    expect(incomplete.sections.find((s) => s.key === key)?.status).toBe("not_recorded");
  });

  it("flags missing expected sections without treating them as critical", () => {
    const result = pack({
      reasonForTransfer: "  ",
      baseline: null,
      eatingAndDrinking: null,
      capacityAndLegal: null,
      contacts: [],
      infection: null,
      homeContact: null,
    });
    expect(result.missingCritical).toEqual([]);
    expect(result.missingExpected).toEqual([
      "reason_for_transfer",
      "baseline",
      "eating_and_drinking",
      "capacity_and_legal",
      "contacts",
      "infection",
      "home_contact",
    ]);
    expect(result.complete).toBe(false);
  });

  it("accepts positively recorded 'none' statements", () => {
    const at = new Date("2026-09-01T10:00:00Z");
    const result = pack({
      allergies: source({ status: "no_known_allergies", recordedBy: "nurse-1", recordedAt: at }),
      medicines: source({ status: "none", confirmedBy: "nurse-1", confirmedAt: at }),
      communication: source({ status: "none_identified", confirmedBy: "nurse-1", confirmedAt: at }),
      resuscitation: source({
        status: "no_decision_in_place",
        confirmedBy: "nurse-1",
        confirmedAt: at,
      }),
    });
    expect(result.missingCritical).toEqual([]);
  });
});

describe("pack content", () => {
  it("hazard HZ-007 lists the most severe allergies first", () => {
    const result = pack();
    expect(result.content.allergies).toMatchObject({
      status: "has_allergies",
      allergies: [{ substance: "Penicillin" }, { substance: "Plasters" }],
    });
  });

  it("lists time-critical medicines first", () => {
    const medicines = pack().content.medicines;
    expect(medicines.status === "recorded" && medicines.items.map((m) => m.timeCritical)).toEqual([
      true,
      false,
    ]);
  });

  it("hazard HZ-015 prints only the active resuscitation record", () => {
    const resuscitation = pack().content.resuscitation;
    expect(resuscitation).toMatchObject({
      status: "recorded",
      records: [{ kind: "respect", active: true }],
    });
    expect(resuscitation.status === "recorded" && resuscitation.records).toHaveLength(1);
  });

  it("names belongings that usually travel but are not being sent", () => {
    const result = pack({ sendItemIds: ["i2"] });
    expect(result.itemsLeftBehind.map((i) => i.id)).toEqual(["i1"]);
  });

  it("summarises About Me and trims the reason", () => {
    const result = pack({ reasonForTransfer: "  Fall  " });
    expect(result.content.reasonForTransfer).toBe("Fall");
    expect(result.content.aboutMe?.summary.filled).toEqual(["what_is_most_important_to_me"]);
  });
});

describe("refusals", () => {
  it.each<[string, Partial<HospitalTransferInput>, string]>([
    ["a discharged person", { personStatus: "discharged" }, "not_receiving_care"],
    ["a person still at enquiry", { personStatus: "enquiry" }, "not_receiving_care"],
    [
      "no date of birth",
      { identity: { ...input().identity, dateOfBirth: null } },
      "identity_incomplete",
    ],
    [
      "no family name",
      { identity: { ...input().identity, familyName: " " } },
      "identity_incomplete",
    ],
  ])("refuses %s", (_label, overrides, problem) => {
    expect(assembleHospitalTransferPack(input(overrides))).toMatchObject({ ok: false, problem });
  });

  it("hazard HZ-001 refuses a pack whose sections belong to someone else", () => {
    const result = assembleHospitalTransferPack(
      input({
        allergies: source(
          { status: "no_known_allergies", recordedBy: "n", recordedAt: AS_OF },
          "person-ben",
        ),
        resuscitation: source({ status: "not_recorded" }, "person-ben"),
        contacts: [
          {
            personId: "person-ben",
            name: "Cara Example",
            relationship: null,
            role: "next_of_kin",
            phone: null,
          },
        ],
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      problem: "wrong_person",
      sections: ["allergies", "resuscitation", "contacts"],
    });
  });

  it("makes a pack for someone already in hospital (to update it)", () => {
    expect(assembleHospitalTransferPack(input({ personStatus: "in_hospital" })).ok).toBe(true);
  });
});

describe("hand-over of the pack", () => {
  const ack = {
    by: "nurse-1",
    at: NOW,
    reason: "Emergency; allergies being confirmed with the GP",
  };

  it("records a complete pack without acknowledgement", () => {
    expect(checkTransferPackHandover(pack(), null)).toEqual({ ok: true, incomplete: false });
    expect(checkTransferPackHandover(pack({ infection: null }), null)).toEqual({
      ok: true,
      incomplete: true,
    });
  });

  it("hazard HZ-023 needs a named acknowledgement and reason when critical sections are missing", () => {
    const incomplete = pack({ allergies: source({ status: "unknown" }) });
    expect(checkTransferPackHandover(incomplete, null)).toMatchObject({
      ok: false,
      problem: "acknowledgement_required",
      missingCritical: ["allergies"],
    });
    expect(checkTransferPackHandover(incomplete, { ...ack, reason: "urgent" })).toMatchObject({
      ok: false,
      problem: "reason_required",
    });
    expect(checkTransferPackHandover(incomplete, ack)).toEqual({ ok: true, incomplete: true });
  });
});

describe("return from hospital", () => {
  it("hazard HZ-016 re-checks allergies, resuscitation decisions and IDDSI levels on return", () => {
    const keys = returnFromHospitalChecks([]).map((c) => c.key);
    expect(keys).toEqual(RETURN_FROM_HOSPITAL_CHECKS.map((c) => c.key));
    expect(keys).toEqual(
      expect.arrayContaining([
        "allergies_rechecked",
        "resuscitation_rechecked",
        "eating_and_drinking_rechecked",
        "medicines_reconciled",
      ]),
    );
  });

  it("adds a belongings check when items went with the person", () => {
    const keys = returnFromHospitalChecks([
      { id: "i1", category: "dentures", receivedOn: "2026-09-01", status: "sent_with_person" },
    ]).map((c) => c.key);
    expect(keys.at(-1)).toBe("belongings_returned");
  });
});

describe("eating and drinking in the pack", () => {
  it("hazard HZ-016 copies the IDDSI codes exactly, including easy to chew (7EC)", () => {
    const content = pack().content.eatingAndDrinking;
    expect(content).toEqual({ foodLevel: "7EC", drinkLevel: "0", notes: null });
    expect(pack().sections.find((s) => s.key === "eating_and_drinking")?.status).toBe("included");
  });
});
