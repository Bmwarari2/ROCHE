import { describe, expect, it } from "vitest";
import { readRateTable, tableOperationsRates } from "../../test/rate-table";
import type { AdvanceCareRecordState } from "../care/advance-care";
import { RateNotFoundError } from "../platform/rates";
import { builtinRole } from "../platform/roles";
import {
  assembleDowntimePack,
  DEFAULT_PAPER_MAR_LOCATION,
  DEFAULT_PEEP_LOCATION,
  DOWNTIME_BACK_ENTRY_INSTRUCTION,
  DOWNTIME_PACK_SECTIONS,
  type DowntimeFreshnessContext,
  type DowntimePack,
  type DowntimePackInput,
  type DowntimePersonInput,
  type DowntimeSectionKey,
  downtimePackFreshness,
  downtimePageHeader,
  fireFileEvacuationPort,
  paperMarMedicinesPort,
  RESUSCITATION_CONFLICT_NOTE,
  type ScheduledDose,
} from "./downtime-pack";
import { OPERATIONS_RATE_KEYS, type OperationsRateName, resolveOperationsRates } from "./rates";

/**
 * Nightly downtime pack (operations.md section 4 rules 1 to 8). Hazard HZ-021, with HZ-001, HZ-003,
 * HZ-007, HZ-015, HZ-016 and HZ-024 for the sections they cover.
 */

const rates = tableOperationsRates();
const HOUR = 3_600_000;
const LOCATION = "location-harbour-house";
// 01:00 on 11 October 2026 in UK summer time.
const AS_AT = new Date("2026-10-11T00:00:00Z");
const GENERATED = new Date("2026-10-11T00:05:00Z");
const NO_OUTAGE: DowntimeFreshnessContext = {
  outage: null,
  clockDriftMinutes: rates.clockDriftMinutes,
};

function advance(o: Partial<AdvanceCareRecordState> = {}): AdvanceCareRecordState {
  return {
    id: "acr-1",
    kind: "respect",
    status: "active",
    cprDecision: "do_not_attempt_cpr",
    completedOn: "2026-06-01",
    clinicianName: "Dr Example",
    clinicianRole: "GP",
    reviewDueOn: "2027-06-01",
    ...o,
  };
}

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
    resuscitation: src(id, [advance()]),
    eatingAndDrinking: src(id, { foodLevel: "6", drinkLevel: "0", notes: " Small portions " }),
    communication: src(id, {
      status: "recorded",
      needs: [{ code: "000000", display: "Uses a hearing aid", preferredFormat: "in_person" }],
    }),
    evacuation: src(id, { status: "held_elsewhere", where: DEFAULT_PEEP_LOCATION }),
    medicinesDue: src(id, { status: "held_elsewhere", where: DEFAULT_PAPER_MAR_LOCATION }),
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

const section = (page: ReturnType<typeof onlyPage>, key: DowntimeSectionKey) =>
  page.sections.find((s) => s.key === key);
const status = (page: ReturnType<typeof onlyPage>, key: DowntimeSectionKey) =>
  section(page, key)?.status;

describe("downtime figures come from the rate table", () => {
  it("resolves every operations key", () => {
    for (const name of Object.keys(OPERATIONS_RATE_KEYS) as OperationsRateName[]) {
      expect(rates[name]).toBeGreaterThan(0);
    }
  });

  it("keeps a pack in date for longer than the nightly interval, so one failed night still leaves a pack", () => {
    expect(rates.downtimePackValidHours).toBeGreaterThan(24);
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
      ["iddsi_food", true],
      ["iddsi_drink", true],
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
      resuscitation: src("p-sparse", []),
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
      "iddsi_food",
      "iddsi_drink",
      "communication",
    ]);
    expect(page.warnings.slice(0, 6).map((w) => w.section)).toEqual(page.missingCritical);
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
  it.each<[string, Partial<DowntimePersonInput>, DowntimeSectionKey[]]>([
    ["hazard HZ-001 no photo", { photo: null }, ["identity"]],
    [
      "hazard HZ-007 allergy status unknown",
      { allergies: src("p-1", { status: "unknown" }) },
      ["allergies"],
    ],
    [
      "hazard HZ-007 allergies said to exist but none listed",
      { allergies: src("p-1", { status: "has_allergies", allergies: [] }) },
      ["allergies"],
    ],
    [
      "hazard HZ-015 no resuscitation decision",
      { resuscitation: src("p-1", []) },
      ["resuscitation"],
    ],
    [
      "hazard HZ-015 only withdrawn or superseded decisions",
      {
        resuscitation: src("p-1", [
          advance({ status: "withdrawn" }),
          advance({ id: "acr-2", status: "superseded" }),
          advance({ id: "acr-3", kind: "adrt", cprDecision: null }),
        ]),
      },
      ["resuscitation"],
    ],
    ["hazard HZ-016 no IDDSI record", { eatingAndDrinking: null }, ["iddsi_food", "iddsi_drink"]],
    [
      "hazard HZ-016 a food level but no drink level",
      { eatingAndDrinking: src("p-1", { foodLevel: "5", drinkLevel: null, notes: null }) },
      ["iddsi_drink"],
    ],
    [
      "hazard HZ-016 a drink level but no food level",
      { eatingAndDrinking: src("p-1", { foodLevel: " ", drinkLevel: "2", notes: null }) },
      ["iddsi_food"],
    ],
    [
      "communication needs never assessed",
      { communication: src("p-1", { status: "not_recorded" }) },
      ["communication"],
    ],
    [
      "communication needs recorded as an empty list",
      { communication: src("p-1", { status: "recorded", needs: [] }) },
      ["communication"],
    ],
  ])("%s", (_label, overrides, keys) => {
    const page = onlyPage(person("p-1", overrides));
    expect(page.missingCritical).toEqual(keys);
    for (const key of keys) {
      expect(section(page, key)?.status).toBe("not_recorded");
      expect(section(page, key)?.note?.length).toBeGreaterThan(10);
    }
    expect(page.warnings.slice(0, keys.length)).toEqual(
      keys.map((key) => expect.objectContaining({ kind: "critical_not_recorded", section: key })),
    );
  });

  it("hazard HZ-016 tells staff to check before giving food or drink when a level is missing", () => {
    const page = onlyPage(
      person("p-1", {
        eatingAndDrinking: src("p-1", { foodLevel: "5", drinkLevel: null, notes: null }),
      }),
    );
    expect(section(page, "iddsi_drink")?.note).toBe(
      "IDDSI drink level not recorded. Check with the nurse in charge before giving any drink.",
    );
    expect(page.content.eatingAndDrinking).toEqual({
      food: "Level 5 Minced and moist (orange)",
      drink: null,
      notes: null,
    });
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

describe("hazard HZ-016 an unreadable IDDSI code says check the record and never stops the pack", () => {
  it.each<[string, { foodLevel: string | null; drinkLevel: string | null }, DowntimeSectionKey]>([
    ["a food code that is not a level", { foodLevel: "8", drinkLevel: "0" }, "iddsi_food"],
    ["a drink code that is not a level", { foodLevel: "6", drinkLevel: "thick" }, "iddsi_drink"],
  ])("%s", (_label, levels, key) => {
    const result = pack([
      person("p-1", { eatingAndDrinking: src("p-1", { ...levels, notes: null }) }),
      person("p-2", { roomLabel: "Room 3" }),
    ]);
    expect(result.pages).toHaveLength(2);
    const page = result.pages[0];
    if (!page) throw new Error("no page");
    expect(section(page, key)).toMatchObject({
      status: "unreadable",
      note: "This could not be read from the record. Check the record before giving food or drink.",
    });
    expect(page.warnings).toContainEqual(
      expect.objectContaining({ kind: "unreadable_value", section: key }),
    );
  });
});

describe("pack content", () => {
  it("hazard HZ-007 lists the most severe allergies first, with unknown severity among the severe", () => {
    const page = onlyPage(
      person("p-1", {
        allergies: src("p-1", {
          status: "has_allergies",
          allergies: [
            { substance: "Plasters", reaction: "Rash", severity: "mild" },
            { substance: "Latex", reaction: null, severity: "unknown" },
            { substance: "Ibuprofen", reaction: "Wheeze", severity: "moderate" },
            { substance: "Penicillin", reaction: "Anaphylaxis", severity: "severe" },
          ],
        }),
      }),
    );
    const allergies = page.content.allergies;
    expect(
      allergies.status === "has_allergies" && allergies.allergies.map((a) => a.substance),
    ).toEqual(["Latex", "Penicillin", "Ibuprofen", "Plasters"]);
  });

  it("hazard HZ-016 shows IDDSI levels with number, name and colour", () => {
    expect(onlyPage(person("p-1")).content.eatingAndDrinking).toEqual({
      food: "Level 6 Soft and bite-sized (blue)",
      drink: "Level 0 Thin (white)",
      notes: "Small portions",
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

  it("points to the location's own MAR and PEEP places until medicines and PEEPs are in Harbour", async () => {
    const medicinesPort = paperMarMedicinesPort(" the MAR folder in the clinical room ");
    const peepPort = fireFileEvacuationPort("the red fire grab bag at reception");
    const page = onlyPage(
      person("p-1", {
        medicinesDue: src("p-1", await medicinesPort.medicinesDue("p-1", AS_AT, GENERATED)),
        evacuation: src("p-1", await peepPort.evacuationPlan("p-1")),
      }),
    );
    expect(section(page, "medicines_due")).toMatchObject({
      status: "held_elsewhere",
      note: "Not kept in Harbour yet. Use the MAR folder in the clinical room.",
    });
    expect(section(page, "evacuation")).toMatchObject({
      status: "held_elsewhere",
      note: "Not kept in Harbour yet. Use the red fire grab bag at reception.",
    });
    expect(page.missingCritical).toEqual([]);
  });

  it("refuses a placeholder with no place set", () => {
    expect(() => paperMarMedicinesPort("  ")).toThrow("Set where the paper MAR is kept");
    expect(() => fireFileEvacuationPort("")).toThrow("Set where the PEEPs are kept");
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

  it("hazard HZ-003 lists doses still due while the pack is in use, in time order, time-critical first, never doses already given", () => {
    const at = (hours: number) => new Date(AS_AT.getTime() + hours * HOUR);
    const dose = (name: string, hours: number, o: Partial<ScheduledDose> = {}): ScheduledDose => ({
      name,
      dose: "1 tablet",
      route: "oral",
      dueAt: at(hours),
      timeCritical: false,
      status: "due",
      givenAt: null,
      ...o,
    });
    const page = onlyPage(
      person("p-1", {
        medicinesDue: src("p-1", {
          status: "recorded",
          scheduled: [
            dose("Before the pack", -1),
            dose("Paracetamol", 7),
            dose("Co-careldopa", 7, { timeCritical: true }),
            dose("Senna", 3),
            dose("Already given", 4, { status: "given", givenAt: at(4) }),
            dose("Refused", 5, { status: "not_given" }),
            dose("After the pack", rates.downtimePackValidHours),
          ],
          prn: [
            {
              name: "Paracetamol",
              dose: "1 g",
              route: "oral",
              reason: "Pain",
              lastGivenAt: at(-2),
            },
          ],
        }),
      }),
    );
    const due = page.content.medicinesDue;
    expect(due?.status === "recorded" && due.due.map((m) => m.name)).toEqual([
      "Senna",
      "Co-careldopa",
      "Paracetamol",
    ]);
    expect(due?.status === "recorded" && due.prn[0]?.lastGivenAt).toEqual(at(-2));
    expect(status(page, "medicines_due")).toBe("included");
  });
});

describe("hazard HZ-015 resuscitation status on the downtime pack", () => {
  it("prints the decision in force", () => {
    const page = onlyPage(person("p-1"));
    expect(status(page, "resuscitation")).toBe("included");
    expect(page.content.resuscitation.map((r) => [r.kind, r.decision])).toEqual([
      ["respect", "do_not_attempt_cpr"],
    ]);
  });

  it("marks a conflict between ReSPECT and DNACPR in the section itself, and prints every record in force", () => {
    const page = onlyPage(
      person("p-1", {
        resuscitation: src("p-1", [
          advance({ id: "acr-respect", kind: "respect", cprDecision: "attempt_cpr" }),
          advance({
            id: "acr-dnacpr",
            kind: "dnacpr",
            cprDecision: "do_not_attempt_cpr",
            completedOn: "2026-09-20",
          }),
          advance({ id: "acr-old", status: "withdrawn", cprDecision: "attempt_cpr" }),
        ]),
      }),
    );
    expect(section(page, "resuscitation")).toMatchObject({
      status: "conflicting",
      note: RESUSCITATION_CONFLICT_NOTE,
    });
    expect(page.content.resuscitation.map((r) => [r.recordId, r.kind, r.decision])).toEqual([
      ["acr-dnacpr", "dnacpr", "do_not_attempt_cpr"],
      ["acr-respect", "respect", "attempt_cpr"],
    ]);
    expect(page.warnings).toContainEqual(
      expect.objectContaining({ kind: "resuscitation_conflict", section: "resuscitation" }),
    );
  });

  it("prints two records that agree without a conflict", () => {
    const page = onlyPage(
      person("p-1", {
        resuscitation: src("p-1", [
          advance(),
          advance({ id: "acr-2", kind: "dnacpr", completedOn: "2026-08-01" }),
        ]),
      }),
    );
    expect(status(page, "resuscitation")).toBe("included");
    expect(page.content.resuscitation).toHaveLength(2);
  });

  it("notes a decision past its review date without hiding it", () => {
    const page = onlyPage(
      person("p-1", { resuscitation: src("p-1", [advance({ reviewDueOn: "2026-10-10" })]) }),
    );
    expect(page.warnings.map((w) => w.kind)).toEqual(["resuscitation_review_overdue"]);
    expect(page.content.resuscitation[0]?.reviewOverdue).toBe(true);
    expect(status(page, "resuscitation")).toBe("included");
  });

  it("puts safety-critical gaps and conflicts first on the front sheet", () => {
    const result = pack([
      person("p-1", { resuscitation: src("p-1", [advance({ reviewDueOn: "2026-01-01" })]) }),
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
  it.each<[DowntimeSectionKey[], Partial<DowntimePersonInput>]>([
    [["identity"], { photo: src(other, { documentId: "doc-x", takenOn: "2026-01-01" }) }],
    [["allergies"], { allergies: src(other, { status: "unknown" }) }],
    [["resuscitation"], { resuscitation: src(other, [advance()]) }],
    [
      ["iddsi_food", "iddsi_drink"],
      { eatingAndDrinking: src(other, { foodLevel: "4", drinkLevel: "2", notes: null }) },
    ],
    [["communication"], { communication: src(other, { status: "not_recorded" }) }],
    [["evacuation"], { evacuation: src(other, { status: "held_elsewhere", where: "x" }) }],
    [["medicines_due"], { medicinesDue: src(other, { status: "held_elsewhere", where: "x" }) }],
    [["care_plan"], { carePlan: src(other, { publishedVersion: 1, sections: [] }) }],
    [["risks"], { risks: src(other, []) }],
  ])("withholds %s", (keys, overrides) => {
    const page = onlyPage(person("p-1", overrides));
    for (const key of keys) {
      expect(section(page, key)?.status).toBe("withheld");
      expect(section(page, key)?.note).toMatch(/did not match the person/);
      expect(page.warnings).toContainEqual(
        expect.objectContaining({ kind: "section_withheld", section: key }),
      );
    }
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

  it("keeps a withheld photo, allergies and resuscitation decisions off the page", () => {
    const page = onlyPage(
      person("p-1", {
        photo: src(other, { documentId: "doc-x", takenOn: "2026-01-01" }),
        allergies: src(other, { status: "no_known_allergies", recordedBy: "n", recordedAt: AS_AT }),
        resuscitation: src(other, [advance()]),
      }),
    );
    expect(page.content.photo).toBeNull();
    expect(page.content.allergies).toEqual({ status: "unknown" });
    expect(page.content.resuscitation).toEqual([]);
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
    const freshness = downtimePackFreshness(
      result,
      new Date(AS_AT.getTime() + 5 * HOUR),
      NO_OUTAGE,
    );
    expect(freshness.state).toBe("current");
    expect(freshness.hoursOld).toBe(5);
    expect(freshness.notice).toContain("Information as at 11/10/2026 01:00");
    expect(freshness.notice).toContain("Use until 12/10/2026 13:00");
  });

  it.each([
    ["at the moment it expires", 0],
    ["an hour after it expires", 1],
    ["two days later", 48],
  ])("says out of date in words %s", (_label, hoursAfter) => {
    const at = new Date(result.validUntil.getTime() + hoursAfter * HOUR);
    const freshness = downtimePackFreshness(result, at, NO_OUTAGE);
    expect(freshness.state).toBe("out_of_date");
    expect(freshness.notice).toMatch(/^Out of date: this information is from 11\/10\/2026 01:00/);
    expect(freshness.notice).toContain("check allergies, resuscitation status and diet");
  });

  it("during a declared outage says it is the latest available and that anything since is on paper", () => {
    const during: DowntimeFreshnessContext = {
      outage: { startedAt: new Date(AS_AT.getTime() + 30 * HOUR) },
      clockDriftMinutes: rates.clockDriftMinutes,
    };
    for (const hoursAfter of [31, rates.downtimePackValidHours + 5]) {
      const freshness = downtimePackFreshness(
        result,
        new Date(AS_AT.getTime() + hoursAfter * HOUR),
        during,
      );
      expect(freshness.state).toBe("outage");
      expect(freshness.notice).toBe(
        "Latest available pack: information as at 11/10/2026 01:00. Anything recorded since 11/10/2026 01:00 is on paper or not shown here: check the downtime forms and ask the nurse in charge about changes.",
      );
    }
  });

  it("flags a device clock behind the pack instead of calling it current", () => {
    const behind = new Date(AS_AT.getTime() - (rates.clockDriftMinutes + 1) * 60_000);
    const freshness = downtimePackFreshness(result, behind, NO_OUTAGE);
    expect(freshness.state).toBe("clock_behind");
    expect(freshness.hoursOld).toBe(0);
    expect(freshness.notice).toMatch(/^Check this device's clock/);
    const slightlyBehind = new Date(AS_AT.getTime() - (rates.clockDriftMinutes - 1) * 60_000);
    expect(downtimePackFreshness(result, slightlyBehind, NO_OUTAGE).state).toBe("current");
  });

  it("puts the freshness words, the back-entry instruction and the print time on every page", () => {
    const printed = new Date(result.validUntil.getTime() + 2 * HOUR);
    const header = downtimePageHeader(result, printed, NO_OUTAGE);
    expect(header.state).toBe("out_of_date");
    expect(header.lines[0]).toBe("Downtime pack for Harbour House");
    expect(header.lines[1]).toMatch(/^Out of date/);
    expect(header.lines[2]).toBe("Made 11/10/2026 01:05. Printed or shown 12/10/2026 15:00.");
    expect(header.lines[3]).toBe(DOWNTIME_BACK_ENTRY_INSTRUCTION);
    expect(downtimePageHeader(result, GENERATED, NO_OUTAGE).state).toBe("current");
  });

  it("marks a pack built on a kiosk from an old sync as out of date from the start", () => {
    const staleSync = new Date(GENERATED.getTime() - (rates.downtimePackValidHours + 6) * HOUR);
    const kiosk = pack([person("p-1")], { asAt: staleSync });
    expect(downtimePackFreshness(kiosk, GENERATED, NO_OUTAGE).state).toBe("out_of_date");
    expect(downtimePackFreshness(kiosk, GENERATED, NO_OUTAGE).hoursOld).toBe(
      rates.downtimePackValidHours + 6,
    );
  });
});
