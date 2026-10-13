import { describe, expect, it } from "vitest";
import {
  adjustAccentForContrast,
  contrastRatio,
  luminance,
  meetsDualContrast,
  parseHex,
  toHex,
} from "./branding";
import {
  evaluateFlag,
  FLAGS,
  type FlagKey,
  isAiFlag,
  isFlagKey,
  remoteMaySet,
  resolveFlag,
} from "./feature-flags";
import { RateNotFoundError, type RateRow, resolveRate } from "./rates";
import { addPeriod, retentionDecision, validateTenantOverride } from "./retention";
import { checkDistinctActors } from "./separation-of-duties";

describe("branding contrast", () => {
  it.each([
    ["#ffffff", "#000000", 21],
    ["#767676", "#ffffff", 4.54],
    ["#0071e3", "#ffffff", 4.7],
  ])("contrast %s on %s is about %s", (a, b, expected) => {
    expect(contrastRatio(a, b)).toBeCloseTo(expected, 1);
  });

  it.each([
    "#0071e3",
    "#ff0000",
    "#ffff00",
    "#00ff00",
    "#000080",
    "#ffffff",
    "#000000",
    "#123456",
    "#ff69b4",
    "0071E3",
  ])("adjusts %s to reach 4.5:1 on white and on black", (input) => {
    const adjusted = adjustAccentForContrast(input);
    expect(adjusted).toMatch(/^#[0-9a-f]{6}$/);
    expect(contrastRatio(adjusted, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(adjusted, "#000000")).toBeGreaterThanOrEqual(4.5);
  });

  it("leaves a colour that already passes unchanged", () => {
    expect(meetsDualContrast("#767676")).toBe(true);
    expect(adjustAccentForContrast("#767676")).toBe("#767676");
  });

  it("keeps the hue of a saturated accent", () => {
    const [r, , b] = parseHex(adjustAccentForContrast("#ff0000"));
    expect(r).toBeGreaterThan(b);
  });

  it("round-trips hex and clamps channels", () => {
    expect(toHex(parseHex("#0a0B0c"))).toBe("#0a0b0c");
    expect(toHex([300, -5, 127.6])).toBe("#ff0080");
    expect(luminance("#000000")).toBe(0);
  });

  it("rejects malformed colours", () => {
    expect(() => parseHex("blue")).toThrow(/hex colour/);
  });
});

describe("feature flags", () => {
  const LOC = "loc-1";
  it.each([
    ["catalogue default when no rows", "module.ai", [], null, false],
    ["catalogue default on", "module.residential", [], null, true],
    [
      "tenant row overrides default",
      "module.ai",
      [{ flagKey: "module.ai", locationId: null, enabled: true }],
      null,
      true,
    ],
    [
      "location row overrides tenant row",
      "module.ai",
      [
        { flagKey: "module.ai", locationId: null, enabled: true },
        { flagKey: "module.ai", locationId: LOC, enabled: false },
      ],
      LOC,
      false,
    ],
    [
      "tenant row applies at a location without its own row",
      "module.ai",
      [{ flagKey: "module.ai", locationId: null, enabled: true }],
      LOC,
      true,
    ],
  ] as const)("%s", (_name, key, rows, location, expected) => {
    expect(evaluateFlag(key, rows, location)).toBe(expected);
  });

  it("keeps the AI module off by default (section 16)", () => {
    expect(FLAGS["module.ai"].defaultEnabled).toBe(false);
  });

  it("marks every AI flag, and none is on by default", () => {
    const keys = Object.keys(FLAGS) as FlagKey[];
    for (const key of keys.filter((k) => k.startsWith("module.ai") || k.startsWith("ai."))) {
      expect(isAiFlag(key), key).toBe(true);
    }
    for (const key of keys.filter(isAiFlag)) expect(FLAGS[key].defaultEnabled, key).toBe(false);
  });

  // The OpenFeature provider's order (apps/api/src/flags): location row, tenant row, Flagsmith
  // where it may set the flag and answered, catalogue default.
  it.each([
    ["remote sets a module marked remote", "module.workforce", [], null, true, true, "remote"],
    [
      "remote can switch a remote module off",
      "module.public_site",
      [],
      null,
      false,
      false,
      "remote",
    ],
    [
      "the tenant row wins over remote",
      "module.workforce",
      [{ flagKey: "module.workforce", locationId: null, enabled: false }],
      null,
      true,
      false,
      "tenant",
    ],
    [
      "the location row wins over remote",
      "module.workforce",
      [{ flagKey: "module.workforce", locationId: LOC, enabled: true }],
      LOC,
      false,
      true,
      "location",
    ],
    ["remote unreachable falls back", "module.workforce", [], null, undefined, false, "catalogue"],
    ["remote never switches eMAR on", "module.emar", [], null, true, false, "catalogue"],
    [
      "remote never switches residential off",
      "module.residential",
      [],
      null,
      false,
      true,
      "catalogue",
    ],
    ["remote never turns AI on", "module.ai", [], null, true, false, "catalogue"],
    [
      "only the organisation's row turns AI on",
      "module.ai",
      [{ flagKey: "module.ai", locationId: LOC, enabled: true }],
      LOC,
      false,
      true,
      "location",
    ],
    ["remote never sets a clinical tool", "care.tool.waterlow", [], null, true, false, "catalogue"],
    [
      "remote never sets a review workflow",
      "dols.post_2026_review_workflow",
      [],
      null,
      false,
      true,
      "catalogue",
    ],
    ["remote never sets the language", "locale.welsh", [], null, true, false, "catalogue"],
  ] as const)("%s", (_name, key, rows, location, remote, enabled, source) => {
    expect(resolveFlag(key, rows, location, remote)).toEqual({ enabled, source });
  });

  // #39 review M1: Flagsmith sets only the flags marked remote, never a clinical or
  // data-protection module, an AI flag or a clinical tool.
  it.each(
    (Object.keys(FLAGS) as FlagKey[]).filter(
      (k) =>
        isAiFlag(k) ||
        k.startsWith("care.tool.") ||
        [
          "module.emar",
          "module.residential",
          "module.domiciliary",
          "module.supported_living",
          "module.family_portal",
          "module.finance",
          "dols.post_2026_review_workflow",
          "locale.welsh",
        ].includes(k),
    ),
  )("never lets Flagsmith set %s", (key) => {
    expect(remoteMaySet(key)).toBe(false);
  });

  it("lets Flagsmith set only the flags marked remote", () => {
    const remote = (Object.keys(FLAGS) as FlagKey[]).filter(remoteMaySet);
    expect(remote.sort()).toEqual(["module.public_site", "module.workforce"]);
  });

  it("knows the catalogue's keys", () => {
    expect(isFlagKey("module.ai")).toBe(true);
    expect(isFlagKey("module.unknown")).toBe(false);
    expect(isFlagKey("toString")).toBe(false);
  });
});

describe("rate lookup", () => {
  const rows: RateRow[] = [
    {
      key: "nmw.hourly.21_plus",
      value: "12.21",
      unit: "GBP_per_hour",
      nation: "uk",
      validFrom: "2025-04-01",
      validTo: "2026-04-01",
      tenantId: null,
      verificationStatus: "verified",
      source: "gov.uk",
    },
    {
      key: "nmw.hourly.21_plus",
      value: "12.71",
      unit: "GBP_per_hour",
      nation: "uk",
      validFrom: "2026-04-01",
      validTo: null,
      tenantId: null,
      verificationStatus: "master-prompt",
      source: "master prompt",
    },
    {
      key: "ecm.tolerance_minutes.low",
      value: 15,
      unit: "minutes",
      nation: "all",
      validFrom: "2026-01-01",
      validTo: null,
      tenantId: null,
      verificationStatus: "master-prompt",
      source: "section 13.2",
    },
    {
      key: "ecm.tolerance_minutes.low",
      value: 20,
      unit: "minutes",
      nation: "all",
      validFrom: "2026-01-01",
      validTo: null,
      tenantId: "t1",
      verificationStatus: "tenant",
      source: "tenant policy",
    },
    {
      key: "pea.weekly",
      value: "31.80",
      unit: "GBP_per_week",
      nation: "england",
      validFrom: "2026-04-01",
      validTo: null,
      tenantId: null,
      verificationStatus: "to-verify",
      source: "circular",
    },
    {
      key: "pea.weekly",
      value: "35.00",
      unit: "GBP_per_week",
      nation: "uk",
      validFrom: "2026-04-01",
      validTo: null,
      tenantId: null,
      verificationStatus: "to-verify",
      source: "test",
    },
  ];

  it.each([
    [
      "rate in force on the day before an uprating",
      "nmw.hourly.21_plus",
      "england",
      "2026-03-31",
      null,
      12.21,
    ],
    [
      "uprated rate from the first day (valid_from inclusive)",
      "nmw.hourly.21_plus",
      "england",
      "2026-04-01",
      null,
      12.71,
    ],
    [
      "global default without an override",
      "ecm.tolerance_minutes.low",
      "england",
      "2026-10-11",
      "t2",
      15,
    ],
    ["tenant override wins", "ecm.tolerance_minutes.low", "england", "2026-10-11", "t1", 20],
    ["nation-specific row wins over uk row", "pea.weekly", "england", "2026-10-11", null, 31.8],
    ["uk row applies where no nation row exists", "pea.weekly", "wales", "2026-10-11", null, 35],
  ] as const)("%s", (_name, key, nation, on, tenant, expected) => {
    expect(resolveRate(rows, key, nation, on, tenant).value).toBe(expected);
  });

  it("flags unverified figures", () => {
    expect(resolveRate(rows, "pea.weekly", "england", "2026-10-11", null).verified).toBe(false);
    expect(
      resolveRate(rows, "ecm.tolerance_minutes.low", "england", "2026-10-11", "t1"),
    ).toMatchObject({
      verified: true,
      tenantOverride: true,
    });
  });

  it("throws when no rate is in force", () => {
    expect(() => resolveRate(rows, "nmw.hourly.21_plus", "england", "2020-01-01", null)).toThrow(
      RateNotFoundError,
    );
    expect(() => resolveRate(rows, "unknown.key", "england", "2026-10-11", null)).toThrow(
      /No rate/,
    );
  });
});

describe("retention", () => {
  const careRecord = {
    recordClass: "care_record",
    period: 8,
    unit: "years",
    trigger: "care_ended",
  } as const;
  const now = new Date("2034-06-01T00:00:00Z");

  it.each([
    [
      "within period",
      new Date("2027-01-01T00:00:00Z"),
      false,
      { status: "retain", until: new Date("2035-01-01T00:00:00Z") },
    ],
    [
      "after period",
      new Date("2025-01-01T00:00:00Z"),
      false,
      { status: "eligible_for_destruction", since: new Date("2033-01-01T00:00:00Z") },
    ],
    ["legal hold always retains", new Date("2000-01-01T00:00:00Z"), true, { status: "legal_hold" }],
  ] as const)("%s", (_name, triggerDate, legalHold, expected) => {
    expect(retentionDecision(careRecord, { triggerDate, legalHold }, now)).toEqual(expected);
  });

  it("defers to tenant policy where the schedule says so", () => {
    expect(
      retentionDecision(
        { recordClass: "cctv", period: 0, unit: "months", trigger: "tenant_policy" },
        { triggerDate: now, legalHold: false },
        now,
      ),
    ).toEqual({ status: "tenant_policy" });
  });

  it.each([
    [new Date("2024-02-29T00:00:00Z"), 1, "years", "2025-02-28"],
    [new Date("2026-01-31T00:00:00Z"), 1, "months", "2026-02-28"],
    [new Date("2026-03-15T00:00:00Z"), 6, "months", "2026-09-15"],
  ] as const)("addPeriod(%s, %s %s) = %s", (date, period, unit, expected) => {
    expect(addPeriod(date, period, unit).toISOString().slice(0, 10)).toBe(expected);
  });

  it.each([
    [{ period: 10, unit: "years" }, true],
    [{ period: 96, unit: "months" }, true],
    [{ period: 7, unit: "years" }, false],
  ] as const)("override %o accepted: %s", (override, ok) => {
    expect(validateTenantOverride(careRecord, override).ok).toBe(ok);
  });
});

describe("separation of duties", () => {
  it.each([
    ["controlled_drug_witness", "u1", "u2", true],
    ["controlled_drug_witness", "u1", "u1", false],
    ["controlled_drug_witness", "u1", null, false],
    ["incident_close", "u1", "u1", false],
    ["ledger_approval", "u1", "u3", true],
    ["residents_money_second_signature", "u1", undefined, false],
    ["dpia_sign_off", "u1", "u1", false],
    ["dpia_sign_off", "u1", "u2", true],
  ] as const)("%s by %s and %s -> %s", (rule, first, second, ok) => {
    const result = checkDistinctActors(rule, first, second);
    expect(result.ok).toBe(ok);
    if (!result.ok) expect(result.message.length).toBeGreaterThan(10);
  });
});
