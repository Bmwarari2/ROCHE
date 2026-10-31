/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { portabilityApplies } from "./dsar";
import type { FlagKey } from "./feature-flags";
import {
  PROCESSING_PURPOSES,
  type ProcessingConfig,
  type ProcessingPurposeId,
  recordsOfProcessingRegister,
  tenantDataCategories,
} from "./processing-register";

const ROPA = fileURLToPath(
  new URL("../../../../docs/compliance/records-of-processing.md", import.meta.url),
);

const config = (
  features: FlagKey[] = [],
  optional: Partial<ProcessingConfig["optional"]> = {},
  sector: ProcessingConfig["sector"] = "independent",
): ProcessingConfig => ({
  sector,
  features,
  optional: { marketing: false, ai_free_text: false, ...optional },
});

describe("records of processing purposes", () => {
  it("lists the same purposes as the compliance register (Part B)", () => {
    const ids = [...readFileSync(ROPA, "utf8").matchAll(/^\| (B\d+) \|/gm)].map((m) => m[1]);
    expect(ids).toEqual(Object.keys(PROCESSING_PURPOSES));
  });

  it.each(Object.entries(PROCESSING_PURPOSES))(
    "%s never rests on consent unless it is optional",
    (_id, purpose) => {
      const usesConsent = Object.values(purpose.lawfulBasis).some((b) => b.includes("6(1)(a)"));
      expect(usesConsent).toBe(purpose.consent);
      expect(purpose.consent).toBe(purpose.title.startsWith("Optional:"));
    },
  );

  it.each<[string, ProcessingConfig, ProcessingPurposeId[]]>([
    [
      "a residential home with nothing optional",
      config(),
      ["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B14"],
    ],
    [
      "with the family portal",
      config(["module.family_portal"]),
      ["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "B14"],
    ],
    [
      "with marketing",
      config([], { marketing: true }),
      ["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B9", "B14"],
    ],
    [
      "with AI but not on free text",
      config(["module.ai"]),
      ["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B14"],
    ],
    [
      "with free text switched on but the AI module off",
      config([], { ai_free_text: true }),
      ["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B14"],
    ],
    [
      "with AI on free text",
      config(["module.ai"], { ai_free_text: true }),
      ["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B10", "B14"],
    ],
  ])("register for %s", (_label, input, ids) => {
    expect(recordsOfProcessingRegister(input).map((r) => r.id)).toEqual(ids);
  });

  it.each<[ProcessingConfig["sector"], string]>([
    ["independent", "6(1)(b)"],
    ["public", "6(1)(e)"],
  ])("uses the %s sector's lawful basis for care records", (sector, basis) => {
    const b1 = recordsOfProcessingRegister(config([], {}, sector)).find((r) => r.id === "B1");
    expect(b1?.lawfulBasis).toContain(basis);
    expect(b1?.consent).toBe(false);
  });

  it.each<ProcessingConfig["sector"]>(["independent", "public"])(
    "keeps the %s sector's care record under a legal obligation, so portability does not apply (H-612)",
    (sector) => {
      const b1 = recordsOfProcessingRegister(config([], {}, sector)).find((r) => r.id === "B1");
      expect(b1?.lawfulBasis).toMatch(
        /^Art 6\(1\)\(c\) legal obligation for keeping the care record/,
      );
      expect(b1?.lawfulBasis).toContain("Regulation 17(2)(c)");
      expect(portabilityApplies("person")).toEqual({
        applies: false,
        basis: "legal_obligation_or_public_task",
      });
    },
  );

  it.each<ProcessingConfig["sector"]>(["independent", "public"])(
    "gives complaints and compliments a purpose of their own for the %s sector (H-700)",
    (sector) => {
      const b14 = recordsOfProcessingRegister(config([], {}, sector)).find((r) => r.id === "B14");
      expect(b14?.lawfulBasis).toContain("Regulation 16");
      expect(b14?.lawfulBasis).toContain("Compliments: Art 6(1)(f)");
      expect(b14?.consent).toBe(false);
      expect(b14?.dataCategories).toEqual(["complaints"]);
    },
  );

  it.each<[string, FlagKey[], string[]]>([
    [
      "the core categories",
      [],
      [
        "audit",
        "complaints",
        "contacts",
        "health_and_care",
        "organisation_officers",
        "person_demographics",
        "regulatory_returns",
        "safeguarding",
        "staff_accounts",
      ],
    ],
    ["medicines with eMAR", ["module.emar"], ["medicines"]],
    ["visit locations with home care", ["module.domiciliary"], ["visit_location"]],
    ["portal content with the family portal", ["module.family_portal"], ["family_portal_content"]],
    ["the AI log with the AI module", ["module.ai"], ["ai_interaction_log"]],
    ["employment records with workforce", ["module.workforce"], ["staff_employment"]],
    ["residents' money with finance", ["module.finance"], ["residents_money"]],
  ])("data categories include %s", (_label, features, categories) => {
    const result = tenantDataCategories(config(features));
    expect(result).toEqual(expect.arrayContaining(categories));
    expect(result).toEqual([...new Set(result)].sort());
  });
});
