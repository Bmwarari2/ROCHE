import { describe, expect, it } from "vitest";
import { capsuleVmp, DMD, dmdAmpp, gtin, LOOKUPS, release } from "../../test/dmd-fixtures";
import {
  checkDmdRelease,
  DMD_PROBLEMS_KEPT,
  DMD_SEARCH_LIMITS,
  type DmdAmp,
  type DmdAmpp,
  type DmdGtin,
  type DmdLookupEntry,
  type DmdReleaseContent,
  type DmdReleaseProblemCode,
  type DmdVmp,
  type DmdVmpp,
  type DmdVtm,
  dmdDoseUnitCodes,
  dmdGtinKey,
  dmdLookupKey,
  dmdProductFacts,
  dmdReleaseDateFromName,
  dmdReleaseFreshness,
  dmdReleaseOrder,
  dmdSearchQuery,
  isGtin,
  toGtin14,
} from "./dmd-release";

/**
 * dm+d reference data rules (integrations.md section 11 rules 2 to 7; ADR-0080; HZ-113), table
 * driven: the checks a release passes before anything is written, the order releases load in, the
 * out-of-date warning, GTINs and the search a person types.
 */

describe("hazard HZ-113 a release is checked whole before it loads (rule 2)", () => {
  it("accepts a whole release", () => {
    expect(checkDmdRelease(release())).toEqual({ ok: true, problems: [], problemCount: 0 });
  });

  const base = release();
  const [vtmA, vtmB] = base.vtms as [DmdVtm, DmdVtm];
  const [, vmpB] = base.vmps as [DmdVmp, DmdVmp];
  const [ampA, ...ampRest] = base.amps as [DmdAmp, ...DmdAmp[]];
  const [vmppA, vmppB] = base.vmpps as [DmdVmpp, DmdVmpp];
  const [, ...amppRest] = base.ampps as [DmdAmpp, ...DmdAmpp[]];
  const [gtinA] = base.gtins as [DmdGtin];
  const [lookupA] = LOOKUPS as [DmdLookupEntry];
  const cases: [string, Partial<DmdReleaseContent>, DmdReleaseProblemCode][] = [
    ["no name", { name: " " }, "bad_release"],
    ["an impossible date", { releasedOn: "2026-02-30" }, "bad_release"],
    ["a file with no records", { vtms: [] }, "no_records"],
    ["no GTINs", { gtins: [] }, "no_records"],
    [
      "a lookup of an unknown kind",
      {
        lookups: [
          ...LOOKUPS,
          { kind: "flavour" as never, code: "1", description: "x", previousCode: null },
        ],
      },
      "unknown_code",
    ],
    ["a lookup twice", { lookups: [...LOOKUPS, lookupA] }, "duplicate_id"],
    [
      "a lookup with no name",
      {
        lookups: [...LOOKUPS, { kind: "route", code: "77", description: " ", previousCode: null }],
      },
      "empty_name",
    ],
    [
      "an identifier with a wrong check digit",
      { vtms: [{ ...vtmA, id: "91000011000001108" }, vtmB] },
      "bad_id",
    ],
    ["a concept twice", { amps: [...base.amps, ampA] }, "duplicate_id"],
    ["a concept with no name", { vmps: [capsuleVmp({ name: "" }), vmpB] }, "empty_name"],
    [
      "a VMP naming a VTM the release lacks",
      { vmps: [capsuleVmp({ vtmId: "91000031000001101" }), vmpB] },
      "missing_reference",
    ],
    [
      "a VMP naming itself as its previous identifier",
      { vmps: [capsuleVmp({ previousId: DMD.vmp }), vmpB] },
      "bad_id",
    ],
    [
      "a VMP with a form not in the lookups",
      { vmps: [capsuleVmp({ formCode: "91000451000001104" }), vmpB] },
      "unknown_code",
    ],
    [
      "a VMP with a route not in the lookups",
      { vmps: [capsuleVmp({ routeCodes: ["91000471000001106"] }), vmpB] },
      "unknown_code",
    ],
    [
      "a VMP with a strength unit not in the lookups",
      { vmps: [capsuleVmp({ strengthUomCodes: ["91000421000001107"] }), vmpB] },
      "unknown_code",
    ],
    [
      "a VMP with a controlled drug category not in the lookups",
      { vmps: [capsuleVmp({ controlDrugCategoryCode: "9002" }), vmpB] },
      "unknown_code",
    ],
    [
      "a unit dose form size that is not a number",
      { vmps: [capsuleVmp({ udfs: "one" }), vmpB] },
      "bad_quantity",
    ],
    [
      "an AMP naming a VMP the release lacks",
      {
        amps: [{ ...ampA, vmpId: "91000071000001104" }, ...ampRest],
      },
      "missing_reference",
    ],
    [
      "an AMP with a licensed route not in the lookups",
      {
        amps: [{ ...ampA, licensedRouteCodes: ["1"] }, ...ampRest],
      },
      "unknown_code",
    ],
    [
      "a VMPP naming a VMP the release lacks",
      {
        vmpps: [{ ...vmppA, vmpId: "91000071000001104" }, vmppB],
      },
      "missing_reference",
    ],
    [
      "a VMPP with a quantity that is not a number",
      { vmpps: [{ ...vmppA, quantity: "28 caps" }, vmppB] },
      "bad_quantity",
    ],
    [
      "an AMPP naming an AMP the release lacks",
      {
        ampps: [dmdAmpp(DMD.ampp, "91000171000001100", DMD.vmpp), ...amppRest],
      },
      "missing_reference",
    ],
    [
      "an AMPP whose AMP and VMPP name different VMPs",
      {
        ampps: [dmdAmpp(DMD.ampp, DMD.amp, DMD.vmpp2), ...amppRest],
      },
      "pack_mismatch",
    ],
    [
      "an AMPP with a legal category not in the lookups",
      {
        ampps: [
          { ...dmdAmpp(DMD.ampp, DMD.amp, DMD.vmpp), legalCategoryCode: "9999" },
          ...amppRest,
        ],
      },
      "unknown_code",
    ],
    [
      "an AMPP discontinued on an impossible date",
      {
        ampps: [
          {
            ...dmdAmpp(DMD.ampp, DMD.amp, DMD.vmpp),
            discontinued: true,
            discontinuedOn: "2026-13-01",
          },
          ...amppRest,
        ],
      },
      "bad_date",
    ],
    [
      "a GTIN naming a pack the release lacks",
      { gtins: [...base.gtins, gtin("91000331000001104", DMD.gtinOld)] },
      "missing_reference",
    ],
    [
      "a GTIN with a wrong check digit",
      { gtins: [...base.gtins, gtin(DMD.ampp, "02001234500013")] },
      "bad_gtin",
    ],
    [
      "a GTIN not padded to 14 digits",
      { gtins: [...base.gtins, gtin(DMD.ampp, "2001234500081")] },
      "bad_gtin",
    ],
    [
      "a GTIN that ends before it starts",
      {
        gtins: [
          ...base.gtins,
          gtin(DMD.ampp, DMD.gtinOld, { startDate: "2026-01-02", endDate: "2026-01-01" }),
        ],
      },
      "bad_date",
    ],
    [
      "a GTIN with an impossible start",
      { gtins: [...base.gtins, gtin(DMD.ampp, DMD.gtinOld, { startDate: "2026-02-29" })] },
      "bad_date",
    ],
    ["a GTIN mapping twice", { gtins: [...base.gtins, gtinA] }, "duplicate_id"],
  ];

  it.each(cases)("refuses %s", (_, over, code) => {
    const check = checkDmdRelease(release(over));
    expect(check.ok).toBe(false);
    expect(check.problems.map((p) => p.code)).toContain(code);
    expect(check.problemCount).toBeGreaterThanOrEqual(check.problems.length);
  });

  it("keeps the first problems and counts the rest", () => {
    const gtins = Array.from({ length: DMD_PROBLEMS_KEPT + 10 }, (_, i) =>
      gtin(DMD.ampp, DMD.gtin, { startDate: `2020-01-${String((i % 28) + 1).padStart(2, "0")}` }),
    ).map((g, i) => ({ ...g, gtin: i % 2 === 0 ? "0" : g.gtin }));
    const check = checkDmdRelease(release({ gtins }));
    expect(check.problems).toHaveLength(DMD_PROBLEMS_KEPT);
    expect(check.problemCount).toBeGreaterThan(DMD_PROBLEMS_KEPT);
  });

  it("names identifiers only in its messages", () => {
    const check = checkDmdRelease(release({ gtins: [gtin("91000331000001104", DMD.gtin)] }));
    expect(check.problems[0]).toMatchObject({
      code: "missing_reference",
      file: "gtin",
      id: "91000331000001104",
    });
    expect(check.problems[0]?.message).toContain("91000331000001104");
  });
});

describe("hazard HZ-113 releases never go backwards and load once (rule 3)", () => {
  const loaded = [
    { name: "nhsbsa_dmd_10.1.0_20261005000001", releasedOn: "2026-10-05" },
    { name: "nhsbsa_dmd_10.1.0_20261026000001", releasedOn: "2026-10-26" },
  ];
  it.each([
    ["the first release", [], "nhsbsa_dmd_10.1.0_20261005000001", "2026-10-05", "load"],
    ["a newer release", loaded, "nhsbsa_dmd_10.1.0_20261102000001", "2026-11-02", "load"],
    [
      "a re-issue on the same date",
      loaded,
      "nhsbsa_dmd_10.1.1_20261026000002",
      "2026-10-26",
      "load",
    ],
    [
      "the release in use again",
      loaded,
      "nhsbsa_dmd_10.1.0_20261026000001",
      "2026-10-26",
      "already_loaded",
    ],
    [
      "an earlier release again",
      loaded,
      "nhsbsa_dmd_10.1.0_20261005000001",
      "2026-10-05",
      "already_loaded",
    ],
    [
      "an older release",
      loaded,
      "nhsbsa_dmd_10.0.9_20261012000001",
      "2026-10-12",
      "older_than_current",
    ],
  ] as const)("%s: %s", (_, history, name, releasedOn, expected) => {
    expect(dmdReleaseOrder({ name, releasedOn }, history)).toBe(expected);
  });

  it.each([
    ["nhsbsa_dmd_10.1.0_20261026000001", "2026-10-26"],
    ["fixture_dmd_1.0.0_20261005000001", "2026-10-05"],
    ["nhsbsa_dmd_10.1.0_20261326000001", null],
    ["nhsbsa_dmd_10.1.0", null],
    ["release-2026-10-26", null],
  ])("reads the date in %s as %s", (name, date) => {
    expect(dmdReleaseDateFromName(name)).toBe(date);
  });
});

describe("hazard HZ-113 out of date is said, never hidden (rule 5)", () => {
  it.each([
    ["no release", null, "2026-10-31", 35, "none", null],
    ["a release from today", "2026-10-31", "2026-10-31", 35, "current", 0],
    ["one day before the limit", "2026-09-27", "2026-10-31", 35, "current", 34],
    ["at the limit", "2026-09-26", "2026-10-31", 35, "current", 35],
    ["one day past the limit", "2026-09-25", "2026-10-31", 35, "out_of_date", 36],
    ["across the clock change", "2026-03-20", "2026-04-25", 35, "out_of_date", 36],
  ] as const)("%s", (_, releasedOn, today, limit, status, age) => {
    const freshness = dmdReleaseFreshness(
      releasedOn === null ? null : { releasedOn },
      today,
      limit,
    );
    expect(freshness.status).toBe(status);
    expect(freshness.ageDays).toBe(age);
  });

  it("says the release date as screens write it, and what to do when out of date", () => {
    expect(dmdReleaseFreshness({ releasedOn: "2026-10-26" }, "2026-10-31", 35).message).toBe(
      "dm+d release dated 26/10/2026.",
    );
    const stale = dmdReleaseFreshness({ releasedOn: "2026-08-01" }, "2026-10-31", 35).message;
    expect(stale).toContain("out of date");
    expect(stale).toContain("01/08/2026");
    expect(stale).toContain("Check the product against the pack");
    expect(dmdReleaseFreshness(null, "2026-10-31", 35).message).toContain("No dm+d release");
  });
});

describe("hazard HZ-113 GTINs (rule 7)", () => {
  it.each([
    ["2001234500012", true, "02001234500012"],
    ["02001234500012", true, "02001234500012"],
    ["2001 2345 0001 2", true, "02001234500012"],
    ["2001234500013", false, null],
    ["96385074", true, "00000096385074"],
    ["036000291452", true, "00036000291452"],
    ["12345", false, null],
    ["200123450001x", false, null],
    ["", false, null],
    ["000000000000000", false, null],
  ])("%s is valid: %s, as GTIN-14 %s", (value, valid, gtin14) => {
    expect(isGtin(value.replace(/\s+/g, ""))).toBe(valid);
    expect(toGtin14(value)).toBe(gtin14);
  });

  it("keys a mapping by pack, GTIN and start, and a lookup by kind and code", () => {
    expect(dmdGtinKey(gtin(DMD.ampp, DMD.gtin))).toBe(`${DMD.ampp}:${DMD.gtin}:2020-01-01`);
    expect(dmdLookupKey({ kind: "route", code: DMD.routeOral })).toBe(`route:${DMD.routeOral}`);
  });
});

describe("hazard HZ-113 the search a person types (rule 6)", () => {
  it.each([
    ["exampl 250", { kind: "text", terms: ["exampl", "250"], tsQuery: "exampl:* & 250:*" }],
    ["  Testoprofen  200MG ", { kind: "text", terms: ["testoprofen", "200mg"] }],
    ["Fixturol 5mg/5ml", { kind: "text", terms: ["fixturol", "5mg", "5ml"] }],
    ["exampl exampl", { kind: "text", terms: ["exampl"] }],
    ["91000051000001106", { kind: "code", id: "91000051000001106" }],
    ["500", { kind: "text", terms: ["500"] }],
  ] as const)("reads %j", (raw, query) => {
    const check = dmdSearchQuery(raw);
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.query).toMatchObject(query);
  });

  it.each([
    ["", "empty"],
    ["   ", "empty"],
    ["ab", "too_short"],
    ["a b", "too_short"],
    ["--", "too_short"],
    ["x".repeat(DMD_SEARCH_LIMITS.maxQueryLength + 1), "too_long"],
    ["a b c d e f g h i", "too_long"],
    ["91000051000001107", "invalid_code"],
    ["123456", "invalid_code"],
  ] as const)("refuses %j as %s, never falling back to a near match", (raw, problem) => {
    const check = dmdSearchQuery(raw);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.problem).toBe(problem);
      expect(check.message.length).toBeGreaterThan(10);
    }
  });
});

describe("hazard HZ-005 the units and routes dm+d gives for a product (medicines.md rule 2)", () => {
  const names = new Map(LOOKUPS.map((e) => [dmdLookupKey(e), e.description]));

  it("gives the unit dose, its form size's unit and the strength units, each once", () => {
    expect(dmdDoseUnitCodes(capsuleVmp())).toEqual([DMD.uomCapsule, DMD.uomMg]);
    expect(
      dmdDoseUnitCodes(
        capsuleVmp({ unitDoseUomCode: null, udfsUomCode: null, strengthUomCodes: [] }),
      ),
    ).toEqual([]);
  });

  it("names them from the lookups, leaving out a code the lookups lack", () => {
    expect(
      dmdProductFacts(capsuleVmp({ routeCodes: [DMD.routeOral, "91000471000001106"] }), names),
    ).toEqual({
      permittedDoseUnits: [
        { code: DMD.uomCapsule, name: "capsule" },
        { code: DMD.uomMg, name: "mg" },
      ],
      permittedRoutes: [{ code: DMD.routeOral, name: "Oral" }],
    });
  });
});
