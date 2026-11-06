import { DEMO } from "@harbour/db/seed";
import type { DmdProductFacts, DmdProductRef, MedicinesCompetence } from "@harbour/domain";

/**
 * The two inputs the medicines rules take from outside the medicines module (medicines.md
 * section 3; slice 16), each behind a port so the module never joins another's tables:
 *
 * - **Competence** (workforce, slice 17; ADR-0085): the signed-in member's medicines competence
 *   at the time of the action, read on the server, never from the request or the device. Until
 *   the workforce port exists, production uses `unavailableCompetence`, which answers `not_held`
 *   for everyone, so a second check or a completion is refused rather than allowed on a guess.
 * - **dm+d facts** (slice 10; ADR-0080): the routes and dose units dm+d permits for a product.
 *   Until the reference data lands, production uses `unavailableDmd`, which knows no product, so
 *   nothing is transcribed without dm+d. Development and tests use the fixture.
 *
 * Both adapters satisfy one contract (`apps/api/test/medicines.test.ts`, "the ports fail closed"): they answer for
 * the tenant and member asked, and fail closed.
 */

export interface MedicinesCompetencePort {
  forMember(tenantId: string, tenantUserId: string, at: Date): Promise<MedicinesCompetence>;
}

export interface DmdFactsPort {
  /**
   * What dm+d says about a product, including its dm+d name (which the record stores in place of
   * any name the request sent), or null when the reference data does not hold it.
   */
  facts(
    product: Pick<DmdProductRef, "vmpId" | "ampId">,
  ): Promise<(DmdProductFacts & { readonly name: string }) | null>;
  /**
   * Products whose dm+d name contains every word of `query` (case ignored), at most `limit`, by
   * name: for choosing a product when transcribing (slice 52). VMPs only until slice 10.
   */
  search(query: string, limit: number): Promise<DmdSearchHit[]>;
  /** Whether the reference data is loaded at all (so a refusal can say why). */
  readonly loaded: boolean;
}

export interface DmdSearchHit extends DmdProductFacts {
  readonly vmpId: string;
  readonly name: string;
}

export interface MedicinesPorts {
  competence: MedicinesCompetencePort;
  dmd: DmdFactsPort;
}

/** No workforce competence source yet: nobody is competent, so nothing is checked on a guess. */
export const unavailableCompetence: MedicinesCompetencePort = {
  forMember: async () => "not_held",
};

/** No dm+d reference data yet: no product is known, so nothing is transcribed. */
export const unavailableDmd: DmdFactsPort = {
  facts: async () => null,
  search: async () => [],
  loaded: false,
};

/** A competence source for development and tests: what each member holds, `not_held` otherwise. */
export function fixedCompetence(
  held: ReadonlyMap<string, MedicinesCompetence> = new Map(),
): MedicinesCompetencePort & { held: Map<string, MedicinesCompetence> } {
  const map = new Map(held);
  return {
    held: map,
    forMember: async (tenantId, tenantUserId) =>
      map.get(`${tenantId}:${tenantUserId}`) ?? "not_held",
  };
}

const ORAL = { code: "26643006", name: "Oral" };
const SUBCUTANEOUS = { code: "34206005", name: "Subcutaneous" };
const TABLET = { code: "428673006", name: "tablet" };
const MG = { code: "258684004", name: "mg" };
const ML = { code: "258773002", name: "ml" };
const UNIT = { code: "767525000", name: "unit" };

/**
 * A small invented subset of dm+d for development, tests and the demo tenant, keyed by VMP. The
 * identifiers have the SNOMED CT shape and a valid Verhoeff check digit, in a range real dm+d does
 * not use for these products; slice 10 replaces this with the reference tables.
 */
export const FIXTURE_DMD: ReadonlyMap<string, DmdProductFacts & { readonly name: string }> =
  new Map([
    [
      "90000011000001104",
      {
        name: "Paracetamol 500mg tablets",
        permittedRoutes: [ORAL],
        permittedDoseUnits: [TABLET, MG],
      },
    ],
    [
      "90000041000001103",
      {
        name: "Ibuprofen 200mg tablets",
        permittedRoutes: [ORAL],
        permittedDoseUnits: [TABLET, MG],
      },
    ],
    [
      "90000051000001100",
      {
        name: "Lactulose 3.35g/5ml oral solution",
        permittedRoutes: [ORAL],
        permittedDoseUnits: [ML],
      },
    ],
    [
      "90000061000001102",
      {
        name: "Insulin glargine 100units/ml solution for injection",
        permittedRoutes: [SUBCUTANEOUS],
        permittedDoseUnits: [UNIT],
      },
    ],
  ]);

export const fixtureDmd: DmdFactsPort = {
  loaded: true,
  search: async (query, limit) => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return [...FIXTURE_DMD.entries()]
      .filter(([, f]) => words.every((w) => f.name.toLowerCase().includes(w)))
      .sort(([, a], [, b]) => a.name.localeCompare(b.name))
      .slice(0, limit)
      .map(([vmpId, f]) => ({
        vmpId,
        name: f.name,
        permittedRoutes: f.permittedRoutes,
        permittedDoseUnits: f.permittedDoseUnits,
      }));
  },
  facts: async (product) => {
    // The fixture holds no AMPs, so a branded product it cannot vouch for is unknown.
    if (product.ampId) return null;
    const facts = FIXTURE_DMD.get(product.vmpId);
    return facts
      ? {
          name: facts.name,
          permittedRoutes: facts.permittedRoutes,
          permittedDoseUnits: facts.permittedDoseUnits,
        }
      : null;
  },
};

/**
 * The fixtures stand in only when `MEDICINES_FIXTURES` is on, which production refuses; otherwise
 * the ports fail closed until the real sources exist.
 */
export function createMedicinesPorts(fixtures: boolean): MedicinesPorts {
  return fixtures
    ? { competence: fixedCompetence(demoCompetence()), dmd: fixtureDmd }
    : { competence: unavailableCompetence, dmd: unavailableDmd };
}

/**
 * With the fixtures on (never in production), the invented demo owner, manager and nurse hold
 * current medicines competence, so the local journeys can check and complete (slice 52). Every
 * other member holds none until the workforce port exists.
 */
function demoCompetence(): ReadonlyMap<string, MedicinesCompetence> {
  return new Map(
    (["owner", "manager", "nurse"] as const).map((key) => [
      `${DEMO.tenantId}:${DEMO.users[key].id}`,
      "current" as const,
    ]),
  );
}
