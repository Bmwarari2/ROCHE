import { describe, expect, it } from "vitest";
import { readRateTable, tableOperationsRates } from "../../test/rate-table";
import type { ResuscitationStatus } from "../care/advance-care";
import { RateNotFoundError } from "../platform/rates";
import { builtinRole } from "../platform/roles";
import {
  assembleDowntimePack,
  DOWNTIME_BACK_ENTRY_INSTRUCTION,
  DOWNTIME_PACK_SECTIONS,
  type DowntimePack,
  type DowntimePackInput,
  type DowntimePersonInput,
  type DowntimeSectionKey,
  downtimePackFreshness,
  downtimePageHeader,
  FIRE_FILE_EVACUATION_PORT,
  PAPER_MAR_MEDICINES_PORT,
} from "./downtime-pack";
import { OPERATIONS_RATE_KEYS, type OperationsRateName, resolveOperationsRates } from "./rates";

/** Nightly downtime pack (operations.md section 4 rules 1 to 4). Hazard HZ-021 (and HZ-001, HZ-007, HZ-015, HZ-016). */

const rates = tableOperationsRates();
const HOUR = 3_600_000;
const LOCATION = "location-harbour-house";
// 01:00 on 11 October 2026 in UK summer time.
const AS_AT = new Date("2026-10-11T00:00:00Z");
const GENERATED = new Date("2026-10-11T00:05:00Z");

const NOT_RECORDED_RESUS: ResuscitationStatus = {
  status: "not_recorded",
  conflicting: false,
  recordId: null,
  kind: null,
  completedOn: null,
  clinicianName: null,
  clinicianRole: null,
  reviewDueOn: null,
  reviewOverdue: false,
};

const DNACPR: ResuscitationStatus = {
  status: "do_not_attempt_cpr",
  conflicting: false,
  recordId: "acr-1",
  kind: "respect",
  completedOn: "2026-06-01",
  clinicianName: "Dr Example",
  clinicianRole: "GP",
  reviewDueOn: "2027-06-01",
  reviewOverdue: false,
};

function src<T>(personId: string, data: T) {
  return { personId, asOf: AS_AT, data };
}

function person(id: string, o: Partial<DowntimePersonInput> = {}): DowntimePersonInput {
  return {
    personId: id,
    locationId: LOCATION,
    status: "active",
    givenName: "Ada",
    familyName: "Example",
    preferredName: "Addie",
    dateOfBirth: "1938-04-02",
    nhsNumber: "9990000018",
    roomLabel: "Room 2",
    photo: src(id, { documentId: "doc-photo", takenOn: "2026-09-01" }),
    allergies: src(id, {
      status: "has_allergies",
      allergies: [
        { substance: "Plasters", reaction: "Rash", severity: "mild" },
        { substance: "Penicillin", reaction: "Anaphylaxis", severity: "severe" },
      ],
    }),
    resuscitation: src(id, DNACPR),
    eatingAndDrinking: src(id, { foodLevel: "6", drinkLevel: "0", notes: " Small portions " }),
    communication: src(id, {
      status: "recorded",
      needs: [{ code: "000000", display: "Uses a hearing aid", preferredFormat: "in_person" }],
    }),
    evacuation: src(id, { status: "held_elsewhere", where: "the person's PEEP in the fire file" }),
    medicinesDue: src(id, { status: "held_elsewhere", where: "the paper MAR chart" }),
    contacts: [
      {
        personId: id,
        name: "Ben Example",
        relationship: "son",
        role: "next_of_kin",
        phone: "01632 960000",
      },
    ],
    carePlan: src(id, {
      publishedVersion: 3,
      sections: [
        { domain: "skin", need: " Fragile skin on heels ", contingency: " Call the nurse " },
        { domain: "mobility", need: "Walks with a frame", contingency: null },
        { domain: "sleep", need: "  ", contingency: null },
      ],
    }),
    risks: src(id, [
      {
        title: "Falls",
        hazard: "Falls at night",
        controls: "Sensor mat",
        band: null,
        reviewDueOn: "2026-11-01",
      },
    ]),
    ...o,
  };
}

function input(
  people: DowntimePersonInput[],
  o: Partial<DowntimePackInput> = {},
): DowntimePackInput {
  return {
    packId: "dp-1",
    locationId: LOCATION,
    locationName: "Harbour House",
    generatedAt: GENERATED,
    asAt: AS_AT,
    people,
    ...o,
  };
}

function pack(people: DowntimePersonInput[], o: Partial<DowntimePackInput> = {}): DowntimePack {
  const result = assembleDowntimePack(input(people, o), rates);
  if (!result.ok) throw new Error(result.message);
  return result.pack;
}

function onlyPage(p: DowntimePersonInput) {
  const page = pack([p]).pages[0];
  if (!page) throw new Error("no page");
  return page;
}

const status = (page: ReturnType<typeof onlyPage>, key: DowntimeSectionKey) =>
  page.sections.find((s) => s.key === key)?.status;

describe("downtime figures come from the rate table", () => {
  it("resolves every operations key", () => {
    for (const name of Object.keys(OPERATIONS_RATE_KEYS) as OperationsRateName[]) {
      expect(rates[name]).toBeGreaterThan(0);
    }
  });

  it("fails loudly when a figure is missing rather than guessing", () => {
    const rows = readRateTable().filter(
      (r) => r.key !== OPERATIONS_RATE_KEYS.downtimePackValidHours,
    );
    expect(() => resolveOperationsRates(rows, "england", "2026-10-11", null)).toThrow(
      RateNotFoundError,
    );
  });
});

describe("downtime permissions", () => {
  it.each([
    ["registered_manager", true, true],
    ["deputy_manager", true, true],
    ["clinical_lead", true, true],
    ["team_leader", true, true],
    ["care_worker", false, false],
    ["agency_worker", false, false],
    ["catering", false, false],
    ["inspector", false, false],
  ] as const)("%s reads the pack: %s, manages outages: %s", (role, read, manage) => {
    const permissions = builtinRole(role)?.permissions ?? [];
    expect(permissions.includes("operations.downtime.read")).toBe(read);
    expect(permissions.includes("operations.downtime.manage")).toBe(manage);
  });
});

describe("hazard HZ-021 the downtime pack has a page with every section for every person receiving care at the location", () => {
  it("selects the master prompt's content, safety-critical sections first", () => {
    expect(DOWNTIME_PACK_SECTIONS.map((s) => [s.key, s.critical])).toEqual([
      ["identity", true],
      ["allergies", true],
      ["resuscitation", true],
      ["eating_and_drinking", true],
      ["communication", true],
      ["evacuation", true],
      ["medicines_due", true],
      ["contacts", false],
      ["care_plan", false],
      ["risks", false],
    ]);
  });

  it("prints a page for everyone receiving care, including people away from the home", () => {
    const result = pack([
      person("p-active"),
      person("p-leave", { status: "on_leave", roomLabel: "Room 3" }),
      person("p-hospital", { status: "in_hospital", roomLabel: "Room 4" }),
      person("p-discharged", { status: "discharged" }),
      person("p-died", { status: "deceased" }),
      person("p-elsewhere", { locationId: "location-other" }),
    ]);
    expect(result.pages.map((p) => [p.personId, p.away])).toEqual([
      ["p-active", null],
      ["p-leave", "On leave"],
      ["p-hospital", "In hospital"],
    ]);
    expect(result.excluded).toEqual([
      { personId: "p-discharged", reason: "not_receiving_care" },
      { personId: "p-died", reason: "not_receiving_care" },
      { personId: "p-elsewhere", reason: "other_location" },
    ]);
    for (const page of result.pages) {
      expect(page.sections.map((s) => s.key)).toEqual(DOWNTIME_PACK_SECTIONS.map((s) => s.key));
    }
  });

  it("never leaves out a person whose record is incomplete", () => {
    const sparse = person("p-sparse", {
      photo: null,
      dateOfBirth: null,
      allergies: src("p-sparse", { status: "unknown" }),
      resuscitation: src("p-sparse", NOT_RECORDED_RESUS),
      eatingAndDrinking: null,
      communication: src("p-sparse", { status: "not_recorded" }),
      contacts: [],
      carePlan: null,
      risks: src("p-sparse", []),
    });
    const page = onlyPage(sparse);
    expect(page.missingCritical).toEqual([
      "identity",
      "allergies",
      "resuscitation",
      "eating_and_drinking",
      "communication",
    ]);
    expect(page.warnings.map((w) => w.kind)).toContain("date_of_birth_not_recorded");
    expect(status(page, "contacts")).toBe("not_recorded");
    expect(status(page, "care_plan")).toBe("not_recorded");
    expect(status(page, "risks")).toBe("not_recorded");
  });

  it("orders pages by room naturally, then by name, with no room last", () => {
    const result = pack([
      person("p-10", { roomLabel: "Room 10" }),
      person("p-none", { roomLabel: null }),
      person("p-2b", { roomLabel: "Room 2", familyName: "Zephyr" }),
      person("p-2a", { roomLabel: "Room 2", familyName: "Abbot" }),
    ]);
    expect(result.pages.map((p) => p.personId)).toEqual(["p-2a", "p-2b", "p-10", "p-none"]);
  });

  it("works out when the pack stops being in date from the rate table", () => {
    const result = pack([person("p-1")]);
    expect(result.validUntil.getTime() - result.asAt.getTime()).toBe(
      rates.downtimePackValidHours * HOUR,
    );
  });
});

describe("hazard HZ-021 missing safety-critical information reads not recorded, never blank", () => {
  it.each<[string, Partial<DowntimePersonInput>, DowntimeSectionKey]>([
    ["hazard HZ-001 no photo", { photo: null }, "identity"],
    [
      "hazard HZ-007 allergy status unknown",
      { allergies: src("p-1", { status: "unknown" }) },
      "allergies",
    ],
    [
      "hazard HZ-007 allergies said to exist but none listed",
      { allergies: src("p-1", { status: "has_allergies", allergies: [] }) },
      "allergies",
    ],
    [
      "hazard HZ-015 no resuscitation decision",
      { resuscitation: src("p-1", NOT_RECORDED_RESUS) },
      "resuscitation",
    ],
    ["hazard HZ-016 no IDDSI record", { eatingAndDrinking: null }, "eating_and_drinking"],
    [
      "hazard HZ-016 an IDDSI record with no levels",
      { eatingAndDrinking: src("p-1", { foodLevel: null, drinkLevel: null, notes: "x" }) },
      "eating_and_drinking",
    ],
    [
      "communication needs never assessed",
      { communication: src("p-1", { status: "not_recorded" }) },
      "communication",
    ],
    [
      "communication needs recorded as an empty list",
      { communication: src("p-1", { status: "recorded", needs: [] }) },
      "communication",
    ],
  ])("%s", (_label, overrides, key) => {
    const page = onlyPage(person("p-1", overrides));
    expect(page.missingCritical).toEqual([key]);
    const section = page.sections.find((s) => s.key === key);
    expect(section?.status).toBe("not_recorded");
    expect(section?.note?.length).toBeGreaterThan(10);
    expect(page.warnings[0]).toMatchObject({ kind: "critical_not_recorded", section: key });
  });

  it("accepts positive statements of none", () => {
    const at = new Date("2026-09-01T10:00:00Z");
    const page = onlyPage(
      person("p-1", {
        allergies: src("p-1", { status: "no_known_allergies", recordedBy: "n-1", recordedAt: at }),
        communication: src("p-1", {
          status: "none_identified",
          confirmedBy: "n-1",
          confirmedAt: at,
        }),
      }),
    );
    expect(page.missingCritical).toEqual([]);
  });
});

describe("pack content", () => {
  it("hazard HZ-007 lists the most severe allergies first", () => {
    expect(onlyPage(person("p-1")).content.allergies).toMatchObject({
      status: "has_allergies",
      allergies: [{ substance: "Penicillin" }, { substance: "Plasters" }],
    });
  });

  it("hazard HZ-016 shows IDDSI levels with number, name and colour", () => {
    expect(onlyPage(person("p-1")).content.eatingAndDrinking).toEqual({
      food: "Level 6 Soft and bite-sized (blue)",
      drink: "Level 0 Thin (white)",
      notes: "Small portions",
    });
    const drinkOnly = onlyPage(
      person("p-1", {
        eatingAndDrinking: src("p-1", { foodLevel: null, drinkLevel: "2", notes: " " }),
      }),
    );
    expect(drinkOnly.content.eatingAndDrinking).toEqual({
      food: null,
      drink: "Level 2 Mildly thick (pink)",
      notes: null,
    });
  });

  it("hazard HZ-024 summarises the active care plan by need, in the plan's domain order", () => {
    expect(onlyPage(person("p-1")).content.carePlan).toEqual([
      { domain: "mobility", label: "Mobility", need: "Walks with a frame", contingency: null },
      {
        domain: "skin",
        label: "Skin",
        need: "Fragile skin on heels",
        contingency: "Call the nurse",
      },
    ]);
  });

  it("names the person family name first, with a preferred name only when it differs", () => {
    expect(onlyPage(person("p-1")).displayName).toBe("Example, Ada (Addie)");
    expect(onlyPage(person("p-1", { preferredName: "Ada" })).displayName).toBe("Example, Ada");
    expect(onlyPage(person("p-1", { preferredName: null })).displayName).toBe("Example, Ada");
  });

  it("points to the paper MAR and the fire file until medicines and PEEPs are in Harbour", async () => {
    const medicines = await PAPER_MAR_MEDICINES_PORT.medicinesDue("p-1", AS_AT, GENERATED);
    const evacuation = await FIRE_FILE_EVACUATION_PORT.evacuationPlan("p-1");
    const page = onlyPage(
      person("p-1", {
        medicinesDue: src("p-1", medicines),
        evacuation: src("p-1", evacuation),
      }),
    );
    const medicinesSection = page.sections.find((s) => s.key === "medicines_due");
    const peepSection = page.sections.find((s) => s.key === "evacuation");
    expect(medicinesSection).toMatchObject({
      status: "held_elsewhere",
      note: "Not kept in Harbour yet. Use the paper MAR chart.",
    });
    expect(peepSection).toMatchObject({
      status: "held_elsewhere",
      note: "Not kept in Harbour yet. Use the person's PEEP in the fire file.",
    });
    expect(page.missingCritical).toEqual([]);
  });

  it("shows a recorded PEEP when the fire safety module supplies one", () => {
    const page = onlyPage(
      person("p-1", {
        evacuation: src("p-1", {
          status: "recorded",
          summary: "Two staff and an evacuation chair",
          equipment: ["Evacuation chair"],
          staffNeeded: 2,
        }),
      }),
    );
    expect(status(page, "evacuation")).toBe("included");
  });

  it("hazard HZ-003 lists medicines due while the pack is in use, in time order, time-critical first", () => {
    const at = (hours: number) => new Date(AS_AT.getTime() + hours * HOUR);
    const dose = (name: string, hours: number, timeCritical = false) => ({
      name,
      dose: "1 tablet",
      route: "oral",
      dueAt: at(hours),
      timeCritical,
    });
    const page = onlyPage(
      person("p-1", {
        medicinesDue: src("p-1", {
          status: "due",
          items: [
            dose("Before the pack", -1),
            dose("Paracetamol", 7),
            dose("Co-careldopa", 7, true),
            dose("Senna", 3),
            dose("After the pack", rates.downtimePackValidHours),
          ],
        }),
      }),
    );
    const due = page.content.medicinesDue;
    expect(due?.status === "due" && due.items.map((m) => m.name)).toEqual([
      "Senna",
      "Co-careldopa",
      "Paracetamol",
    ]);
    const none = onlyPage(
      person("p-1", {
        medicinesDue: src("p-1", { status: "due", items: [dose("Later", 99)] }),
      }),
    );
    expect(none.content.medicinesDue).toEqual({ status: "none_due" });
    expect(status(none, "medicines_due")).toBe("included");
  });
});

describe("hazard HZ-015 resuscitation status on the downtime pack", () => {
  it("shows conflicting resuscitation records as a warning", () => {
    const page = onlyPage(
      person("p-1", { resuscitation: src("p-1", { ...DNACPR, conflicting: true }) }),
    );
    expect(page.warnings).toContainEqual(
      expect.objectContaining({ kind: "resuscitation_conflict", section: "resuscitation" }),
    );
    expect(status(page, "resuscitation")).toBe("included");
  });

  it("notes a decision past its review date without hiding it", () => {
    const page = onlyPage(
      person("p-1", { resuscitation: src("p-1", { ...DNACPR, reviewOverdue: true }) }),
    );
    expect(page.warnings.map((w) => w.kind)).toEqual(["resuscitation_review_overdue"]);
    expect(page.content.resuscitation?.status).toBe("do_not_attempt_cpr");
  });

  it("puts safety-critical gaps first on the front sheet", () => {
    const result = pack([
      person("p-1", { resuscitation: src("p-1", { ...DNACPR, reviewOverdue: true }) }),
      person("p-2", { roomLabel: "Room 5", photo: null }),
    ]);
    expect(result.warnings.map((w) => w.kind)).toEqual([
      "critical_not_recorded",
      "resuscitation_review_overdue",
    ]);
  });
});

describe("hazard HZ-001 information from another person's record is withheld, never printed", () => {
  const other = "p-other";
  it.each<[DowntimeSectionKey, Partial<DowntimePersonInput>]>([
    ["identity", { photo: src(other, { documentId: "doc-x", takenOn: "2026-01-01" }) }],
    ["allergies", { allergies: src(other, { status: "unknown" }) }],
    ["resuscitation", { resuscitation: src(other, DNACPR) }],
    [
      "eating_and_drinking",
      { eatingAndDrinking: src(other, { foodLevel: "4", drinkLevel: "2", notes: null }) },
    ],
    ["communication", { communication: src(other, { status: "not_recorded" }) }],
    ["evacuation", { evacuation: src(other, { status: "held_elsewhere", where: "x" }) }],
    ["medicines_due", { medicinesDue: src(other, { status: "none_due" }) }],
    ["care_plan", { carePlan: src(other, { publishedVersion: 1, sections: [] }) }],
    ["risks", { risks: src(other, []) }],
  ])("withholds %s", (key, overrides) => {
    const page = onlyPage(person("p-1", overrides));
    const section = page.sections.find((s) => s.key === key);
    expect(section?.status).toBe("withheld");
    expect(section?.note).toMatch(/did not match the person/);
    expect(page.warnings).toContainEqual(
      expect.objectContaining({ kind: "section_withheld", section: key }),
    );
  });

  it("drops another person's contact but keeps the person's own", () => {
    const own = person("p-1").contacts[0];
    if (!own) throw new Error("fixture");
    const page = onlyPage(
      person("p-1", { contacts: [own, { ...own, personId: other, name: "Cara Other" }] }),
    );
    expect(page.content.contacts.map((c) => c.name)).toEqual(["Ben Example"]);
    expect(status(page, "contacts")).toBe("included");
    expect(page.warnings).toContainEqual(
      expect.objectContaining({ kind: "section_withheld", section: "contacts" }),
    );
  });

  it("keeps a withheld photo and allergies off the page", () => {
    const page = onlyPage(
      person("p-1", {
        photo: src(other, { documentId: "doc-x", takenOn: "2026-01-01" }),
        allergies: src(other, { status: "no_known_allergies", recordedBy: "n", recordedAt: AS_AT }),
      }),
    );
    expect(page.content.photo).toBeNull();
    expect(page.content.allergies).toEqual({ status: "unknown" });
  });
});

describe("refusals", () => {
  it.each<[string, Partial<DowntimePackInput>, string]>([
    [
      "information newer than the pack",
      { asAt: new Date(GENERATED.getTime() + 60_000) },
      "as_at_after_generation",
    ],
    ["no location name", { locationName: "  " }, "location_name_missing"],
  ])("refuses %s", (_label, overrides, problem) => {
    expect(assembleDowntimePack(input([person("p-1")], overrides), rates)).toMatchObject({
      ok: false,
      problem,
    });
  });
});

describe("hazard HZ-021 every page says when its information is from and whether it is out of date", () => {
  const result = pack([person("p-1")]);

  it("states the information's time and when to stop using it while in date", () => {
    const freshness = downtimePackFreshness(result, new Date(AS_AT.getTime() + 5 * HOUR));
    expect(freshness.state).toBe("current");
    expect(freshness.hoursOld).toBe(5);
    expect(freshness.notice).toContain("Information as at 11/10/2026 01:00");
    expect(freshness.notice).toContain("Use until 12/10/2026 01:00");
  });

  it.each([
    ["at the moment it expires", 0],
    ["an hour after it expires", 1],
    ["two days later", 48],
  ])("says out of date in words %s", (_label, hoursAfter) => {
    const at = new Date(result.validUntil.getTime() + hoursAfter * HOUR);
    const freshness = downtimePackFreshness(result, at);
    expect(freshness.state).toBe("out_of_date");
    expect(freshness.notice).toMatch(/^Out of date: this information is from 11\/10\/2026 01:00/);
    expect(freshness.notice).toContain("check allergies, resuscitation status and diet");
  });

  it("puts the freshness words, the back-entry instruction and the print time on every page", () => {
    const printed = new Date(result.validUntil.getTime() + 2 * HOUR);
    const header = downtimePageHeader(result, printed);
    expect(header.outOfDate).toBe(true);
    expect(header.lines[0]).toBe("Downtime pack for Harbour House");
    expect(header.lines[1]).toMatch(/^Out of date/);
    expect(header.lines[2]).toBe("Made 11/10/2026 01:05. Printed or shown 12/10/2026 03:00.");
    expect(header.lines[3]).toBe(DOWNTIME_BACK_ENTRY_INSTRUCTION);
    expect(downtimePageHeader(result, GENERATED).outOfDate).toBe(false);
  });

  it("marks a pack built on a kiosk from an old sync as out of date from the start", () => {
    const staleSync = new Date(GENERATED.getTime() - (rates.downtimePackValidHours + 6) * HOUR);
    const kiosk = pack([person("p-1")], { asAt: staleSync });
    expect(downtimePackFreshness(kiosk, GENERATED).state).toBe("out_of_date");
    expect(downtimePackFreshness(kiosk, GENERATED).hoursOld).toBe(rates.downtimePackValidHours + 6);
  });

  it("never reports a negative age when the viewing device's clock is behind", () => {
    expect(downtimePackFreshness(result, new Date(AS_AT.getTime() - HOUR)).hoursOld).toBe(0);
  });
});
