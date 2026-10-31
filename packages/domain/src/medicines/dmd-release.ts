/**
 * dm+d reference data releases (integrations.md section 11; INTG-006, MEDS-001; ADR-0080; HZ-113).
 * The NHSBSA publishes dm+d as a release of XML files; Harbour loads a release whole or not at all
 * into global reference tables. These are the rules the loader applies before it writes anything,
 * and the rules every search and lookup applies to what it shows: the release must be internally
 * whole (every identifier well formed and every reference resolving), never older than the one in
 * use, and, once in use, said to be out of date when it is.
 *
 * Reference data only: no rule here works out a dose, compares ingredients or advises on a product
 * ([medical-device boundary](../../../../docs/compliance/medical-device-boundary.md)).
 */

import { searchTerms } from "../platform/search";
import { type DmdRoute, isDmdId } from "./dmd";
import type { DoseUnit } from "./dose";
import type { DmdProductFacts } from "./mar-entry";

/** The dm+d lookups Harbour keeps (from `f_lookup2`). */
export const DMD_LOOKUP_KINDS = [
  "unit_of_measure",
  "form",
  "route",
  "control_drug_category",
  "legal_category",
] as const;
export type DmdLookupKind = (typeof DMD_LOOKUP_KINDS)[number];

/** The files of a release, by the prefix of their NHSBSA file names. */
export const DMD_RELEASE_FILES = ["lookup", "vtm", "vmp", "amp", "vmpp", "ampp", "gtin"] as const;
export type DmdReleaseFile = (typeof DMD_RELEASE_FILES)[number];

export interface DmdLookupEntry {
  readonly kind: DmdLookupKind;
  readonly code: string;
  readonly description: string;
  /** The code this one replaced, when dm+d changed it (`CDPREV`). */
  readonly previousCode: string | null;
}

/** Virtual therapeutic moiety: the substance, for example "Paracetamol". */
export interface DmdVtm {
  readonly id: string;
  readonly name: string;
  readonly abbreviatedName: string | null;
  readonly invalid: boolean;
  /** The identifier this concept replaced (`VTMIDPREV`). */
  readonly previousId: string | null;
}

/** Virtual medicinal product, for example "Paracetamol 500mg tablets". */
export interface DmdVmp {
  readonly id: string;
  readonly vtmId: string | null;
  readonly name: string;
  readonly abbreviatedName: string | null;
  readonly invalid: boolean;
  /** The identifier this concept replaced (`VPIDPREV`). */
  readonly previousId: string | null;
  /** The unit a dose is counted in, for example "tablet" (`UNIT_DOSE_UOMCD`). */
  readonly unitDoseUomCode: string | null;
  /** Unit dose form size, a decimal as dm+d writes it (`UDFS`), with its unit (`UDFS_UOMCD`). */
  readonly udfs: string | null;
  readonly udfsUomCode: string | null;
  /**
   * The units the product's strengths are given in (each `STRNT_NMRTR_UOMCD`), without the
   * ingredient: Harbour keeps the unit so a dose can be written in it, never the ingredient.
   */
  readonly strengthUomCodes: readonly string[];
  readonly formCode: string | null;
  readonly routeCodes: readonly string[];
  readonly controlDrugCategoryCode: string | null;
}

/** Actual medicinal product: a supplier's or brand's product of a VMP. */
export interface DmdAmp {
  readonly id: string;
  readonly vmpId: string;
  readonly name: string;
  readonly abbreviatedName: string | null;
  /** The name with the supplier, for example "Paracetamol 500mg tablets (A Supplier Ltd)". */
  readonly description: string;
  readonly invalid: boolean;
  readonly licensedRouteCodes: readonly string[];
}

/** Virtual medicinal product pack, for example "Paracetamol 500mg tablets 32 tablet". */
export interface DmdVmpp {
  readonly id: string;
  readonly vmpId: string;
  readonly name: string;
  /** The pack quantity, a decimal as dm+d writes it (`QTYVAL`). */
  readonly quantity: string | null;
  readonly quantityUomCode: string | null;
  readonly invalid: boolean;
}

/** Actual medicinal product pack: the pack on the shelf, the one a barcode names. */
export interface DmdAmpp {
  readonly id: string;
  readonly vmppId: string;
  readonly ampId: string;
  readonly name: string;
  readonly abbreviatedName: string | null;
  readonly legalCategoryCode: string | null;
  /** dm+d marks a pack discontinued (`DISCCD`) when it is no longer made. */
  readonly discontinued: boolean;
  readonly discontinuedOn: string | null;
  readonly invalid: boolean;
}

/** A GTIN printed on an AMPP's packaging, in force from `startDate` to `endDate` (inclusive). */
export interface DmdGtin {
  readonly amppId: string;
  /** As GTIN-14 (`toGtin14`). */
  readonly gtin: string;
  readonly startDate: string;
  readonly endDate: string | null;
}

/** A release as read from its files. */
export interface DmdReleaseContent {
  readonly name: string;
  /** The release's date (YYYY-MM-DD). */
  readonly releasedOn: string;
  readonly lookups: readonly DmdLookupEntry[];
  readonly vtms: readonly DmdVtm[];
  readonly vmps: readonly DmdVmp[];
  readonly amps: readonly DmdAmp[];
  readonly vmpps: readonly DmdVmpp[];
  readonly ampps: readonly DmdAmpp[];
  readonly gtins: readonly DmdGtin[];
}

export type DmdReleaseProblemCode =
  | "file_missing"
  | "file_repeated"
  | "unreadable_xml"
  | "no_records"
  | "bad_release"
  | "bad_id"
  | "duplicate_id"
  | "missing_reference"
  | "pack_mismatch"
  | "unknown_code"
  | "bad_gtin"
  | "bad_date"
  | "bad_quantity"
  | "empty_name"
  | "older_than_current"
  | "concepts_missing"
  | "load_failed";

export interface DmdReleaseProblem {
  readonly code: DmdReleaseProblemCode;
  readonly file: DmdReleaseFile | null;
  /** The identifier the problem is about, when there is one (never personal data). */
  readonly id: string | null;
  readonly message: string;
}

/** At most this many problems are kept with a refused release; the count says how many in all. */
export const DMD_PROBLEMS_KEPT = 50;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL = /^\d{1,9}(\.\d{1,6})?$/;

/** True when a value is a real calendar date written YYYY-MM-DD. */
function isRealDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * True when a value is a GTIN of 8, 12, 13 or 14 digits with a valid GS1 check digit (the last
 * digit; weights 3 and 1 alternating from the right of the others).
 */
export function isGtin(value: string): boolean {
  if (!/^(\d{8}|\d{12,14})$/.test(value)) return false;
  const digits = [...value].map(Number);
  const check = digits.pop() as number;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    const fromRight = digits.length - 1 - i;
    sum += (digits[i] as number) * (fromRight % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10 === check;
}

/**
 * A GTIN as GTIN-14 (padded with leading zeros, as GS1 reads a GTIN-8, -12 or -13 inside a
 * GTIN-14), or null when it is not a valid GTIN. Spaces a person typed are ignored.
 */
export function toGtin14(value: string): string | null {
  const digits = value.replace(/\s+/g, "");
  return isGtin(digits) ? digits.padStart(14, "0") : null;
}

const problem = (
  code: DmdReleaseProblemCode,
  file: DmdReleaseFile | null,
  id: string | null,
  message: string,
): DmdReleaseProblem => ({ code, file, id, message });

/** Read through every check without stopping, keeping the first problems and counting the rest. */
class Problems {
  readonly kept: DmdReleaseProblem[] = [];
  count = 0;
  add(p: DmdReleaseProblem): void {
    this.count += 1;
    if (this.kept.length < DMD_PROBLEMS_KEPT) this.kept.push(p);
  }
}

export interface DmdReleaseCheck {
  readonly ok: boolean;
  /** The first `DMD_PROBLEMS_KEPT` problems. */
  readonly problems: readonly DmdReleaseProblem[];
  /** How many problems there were in all. */
  readonly problemCount: number;
}

/**
 * Checks a release before anything is written (integrations.md section 11 rule 2; HZ-113): every
 * file has records; identifiers have the dm+d (SNOMED CT concept) shape and appear once; every
 * reference resolves (VMP to VTM, AMP to VMP, VMPP to VMP, AMPP to VMPP and AMP, the AMPP's AMP
 * and VMPP naming the same VMP, GTIN to AMPP); every form, route, unit, controlled drug and legal
 * category code is in the lookups; GTINs are valid with an end date not before the start. A release
 * with any problem is refused whole.
 */
export function checkDmdRelease(release: DmdReleaseContent): DmdReleaseCheck {
  const p = new Problems();
  if (release.name.trim().length === 0 || release.name.length > 200) {
    p.add(problem("bad_release", null, null, "The release has no usable name."));
  }
  if (!isRealDate(release.releasedOn)) {
    p.add(problem("bad_release", null, null, "The release date is not a real date."));
  }

  const counts: Record<DmdReleaseFile, number> = {
    lookup: release.lookups.length,
    vtm: release.vtms.length,
    vmp: release.vmps.length,
    amp: release.amps.length,
    vmpp: release.vmpps.length,
    ampp: release.ampps.length,
    gtin: release.gtins.length,
  };
  for (const file of DMD_RELEASE_FILES) {
    if (counts[file] === 0) {
      p.add(problem("no_records", file, null, `The ${file} file has no records.`));
    }
  }

  // Lookups: each kind and code once.
  const codes = new Map<DmdLookupKind, Set<string>>(DMD_LOOKUP_KINDS.map((k) => [k, new Set()]));
  for (const entry of release.lookups) {
    const seen = codes.get(entry.kind);
    if (!seen) {
      p.add(problem("unknown_code", "lookup", entry.code, `Unknown lookup kind ${entry.kind}.`));
      continue;
    }
    if (seen.has(entry.code)) {
      p.add(problem("duplicate_id", "lookup", entry.code, `${entry.kind} ${entry.code} twice.`));
    }
    seen.add(entry.code);
    if (entry.description.trim().length === 0) {
      p.add(
        problem("empty_name", "lookup", entry.code, `${entry.kind} ${entry.code} has no name.`),
      );
    }
  }
  const codeKnown = (
    kind: DmdLookupKind,
    code: string | null,
    file: DmdReleaseFile,
    id: string,
  ) => {
    if (code !== null && !codes.get(kind)?.has(code)) {
      p.add(problem("unknown_code", file, id, `${id} names ${kind} ${code}, not in the lookups.`));
    }
  };

  const ids = (file: DmdReleaseFile, rows: readonly { id: string; name: string }[]) => {
    const seen = new Set<string>();
    for (const row of rows) {
      if (!isDmdId(row.id)) {
        p.add(problem("bad_id", file, row.id, `${row.id} is not a dm+d identifier.`));
      } else if (seen.has(row.id)) {
        p.add(problem("duplicate_id", file, row.id, `${row.id} appears twice.`));
      }
      seen.add(row.id);
      if (row.name.trim().length === 0) {
        p.add(problem("empty_name", file, row.id, `${row.id} has no name.`));
      }
    }
    return seen;
  };
  const vtmIds = ids("vtm", release.vtms);
  const vmpIds = ids("vmp", release.vmps);
  const ampIds = ids("amp", release.amps);
  const vmppIds = ids("vmpp", release.vmpps);
  const amppIds = ids("ampp", release.ampps);

  const refers = (
    file: DmdReleaseFile,
    id: string,
    target: string | null,
    known: Set<string>,
    what: string,
  ) => {
    if (target !== null && !known.has(target)) {
      p.add(
        problem(
          "missing_reference",
          file,
          id,
          `${id} names ${what} ${target}, not in the release.`,
        ),
      );
    }
  };
  const previous = (file: DmdReleaseFile, id: string, previousId: string | null) => {
    if (previousId !== null && (!isDmdId(previousId) || previousId === id)) {
      p.add(problem("bad_id", file, id, `${id} names ${previousId} as its previous identifier.`));
    }
  };
  const decimal = (file: DmdReleaseFile, id: string, value: string | null) => {
    if (value !== null && !DECIMAL.test(value)) {
      p.add(problem("bad_quantity", file, id, `${id} has a quantity that is not a number.`));
    }
  };

  for (const vtm of release.vtms) previous("vtm", vtm.id, vtm.previousId);
  const vmpOf = new Map<string, string>();
  for (const vmp of release.vmps) {
    previous("vmp", vmp.id, vmp.previousId);
    refers("vmp", vmp.id, vmp.vtmId, vtmIds, "VTM");
    codeKnown("unit_of_measure", vmp.unitDoseUomCode, "vmp", vmp.id);
    codeKnown("unit_of_measure", vmp.udfsUomCode, "vmp", vmp.id);
    for (const code of vmp.strengthUomCodes) codeKnown("unit_of_measure", code, "vmp", vmp.id);
    codeKnown("form", vmp.formCode, "vmp", vmp.id);
    for (const code of vmp.routeCodes) codeKnown("route", code, "vmp", vmp.id);
    codeKnown("control_drug_category", vmp.controlDrugCategoryCode, "vmp", vmp.id);
    decimal("vmp", vmp.id, vmp.udfs);
  }
  for (const amp of release.amps) {
    refers("amp", amp.id, amp.vmpId, vmpIds, "VMP");
    vmpOf.set(amp.id, amp.vmpId);
    for (const code of amp.licensedRouteCodes) codeKnown("route", code, "amp", amp.id);
  }
  const vmppVmp = new Map<string, string>();
  for (const vmpp of release.vmpps) {
    refers("vmpp", vmpp.id, vmpp.vmpId, vmpIds, "VMP");
    vmppVmp.set(vmpp.id, vmpp.vmpId);
    codeKnown("unit_of_measure", vmpp.quantityUomCode, "vmpp", vmpp.id);
    decimal("vmpp", vmpp.id, vmpp.quantity);
  }
  for (const ampp of release.ampps) {
    refers("ampp", ampp.id, ampp.vmppId, vmppIds, "VMPP");
    refers("ampp", ampp.id, ampp.ampId, ampIds, "AMP");
    codeKnown("legal_category", ampp.legalCategoryCode, "ampp", ampp.id);
    const viaAmp = vmpOf.get(ampp.ampId);
    const viaVmpp = vmppVmp.get(ampp.vmppId);
    if (viaAmp !== undefined && viaVmpp !== undefined && viaAmp !== viaVmpp) {
      p.add(
        problem(
          "pack_mismatch",
          "ampp",
          ampp.id,
          `${ampp.id}'s AMP and VMPP name different VMPs (${viaAmp}, ${viaVmpp}).`,
        ),
      );
    }
    if (ampp.discontinuedOn !== null && !isRealDate(ampp.discontinuedOn)) {
      p.add(
        problem(
          "bad_date",
          "ampp",
          ampp.id,
          `${ampp.id} has a discontinued date that is not a date.`,
        ),
      );
    }
  }

  const gtinKeys = new Set<string>();
  for (const g of release.gtins) {
    refers("gtin", g.amppId, g.amppId, amppIds, "AMPP");
    if (!/^\d{14}$/.test(g.gtin) || !isGtin(g.gtin)) {
      p.add(problem("bad_gtin", "gtin", g.amppId, `${g.amppId} has an invalid GTIN ${g.gtin}.`));
    }
    if (!isRealDate(g.startDate) || (g.endDate !== null && !isRealDate(g.endDate))) {
      p.add(problem("bad_date", "gtin", g.amppId, `${g.amppId}'s GTIN ${g.gtin} has a bad date.`));
    } else if (g.endDate !== null && g.endDate < g.startDate) {
      p.add(
        problem(
          "bad_date",
          "gtin",
          g.amppId,
          `${g.amppId}'s GTIN ${g.gtin} ends before it starts.`,
        ),
      );
    }
    const key = dmdGtinKey(g);
    if (gtinKeys.has(key)) {
      p.add(problem("duplicate_id", "gtin", g.amppId, `${g.amppId}'s GTIN ${g.gtin} twice.`));
    }
    gtinKeys.add(key);
  }

  return { ok: p.count === 0, problems: p.kept, problemCount: p.count };
}

/** The stored key of a GTIN mapping: the pack, the GTIN and the day it starts. */
export function dmdGtinKey(g: Pick<DmdGtin, "amppId" | "gtin" | "startDate">): string {
  return `${g.amppId}:${g.gtin}:${g.startDate}`;
}

/** The stored key of a lookup entry. */
export function dmdLookupKey(e: Pick<DmdLookupEntry, "kind" | "code">): string {
  return `${e.kind}:${e.code}`;
}

export interface DmdReleaseRef {
  readonly name: string;
  readonly releasedOn: string;
}

export type DmdReleaseOrder = "load" | "already_loaded" | "older_than_current";

/**
 * Whether a release may load (rule 3): one already loaded under the same name is not loaded again
 * (so a repeated run changes nothing), and one dated before the release in use is refused, so the
 * data never goes backwards. A re-issue on the same date loads.
 */
export function dmdReleaseOrder(
  candidate: DmdReleaseRef,
  loaded: readonly DmdReleaseRef[],
): DmdReleaseOrder {
  if (loaded.some((r) => r.name === candidate.name)) return "already_loaded";
  const latest = loaded.reduce<string | null>(
    (max, r) => (max === null || r.releasedOn > max ? r.releasedOn : max),
    null,
  );
  if (latest !== null && candidate.releasedOn < latest) return "older_than_current";
  return "load";
}

/**
 * The release date in an NHSBSA release name (`nhsbsa_dmd_10.1.0_20261026000001` gives
 * 2026-10-26), or null when the name does not carry one.
 */
export function dmdReleaseDateFromName(name: string): string | null {
  const match = /_(\d{4})(\d{2})(\d{2})\d{6}$/.exec(name);
  if (!match) return null;
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  return isRealDate(date) ? date : null;
}

export type DmdFreshnessStatus = "current" | "out_of_date" | "none";

export interface DmdFreshness {
  readonly status: DmdFreshnessStatus;
  /** Whole days from the release date to today, UK dates. */
  readonly ageDays: number | null;
  /** Plain English for the screen, with the release date (dd/mm/yyyy). */
  readonly message: string;
}

const dayNumber = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;

/** dd/mm/yyyy, as every Harbour screen writes a date. */
function ukDisplayDate(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

/**
 * Whether the release in use is out of date (rule 5; HZ-113): older than
 * `medicines.dmd.stale_after_days` (rate table) on today's UK date. Out of date is said on every
 * search and lookup, never hidden; with no release, nothing can be chosen.
 */
export function dmdReleaseFreshness(
  release: { readonly releasedOn: string } | null,
  todayUk: string,
  staleAfterDays: number,
): DmdFreshness {
  if (release === null) {
    return {
      status: "none",
      ageDays: null,
      message:
        "No dm+d release is loaded, so no medicine can be chosen. Tell your Harbour administrator.",
    };
  }
  const ageDays = Math.round(dayNumber(todayUk) - dayNumber(release.releasedOn));
  const date = ukDisplayDate(release.releasedOn);
  if (ageDays > staleAfterDays) {
    return {
      status: "out_of_date",
      ageDays,
      message: `The dm+d data is out of date: the release in use is dated ${date}, ${ageDays} days ago. Check the product against the pack and the prescription, and tell your Harbour administrator.`,
    };
  }
  return { status: "current", ageDays, message: `dm+d release dated ${date}.` };
}

export const DMD_SEARCH_LIMITS = {
  maxQueryLength: 100,
  maxTerms: 8,
  /** Letters and digits needed in all before a name search runs. */
  minCharacters: 3,
  maxResults: 25,
} as const;

export type DmdSearchProblem = "empty" | "too_long" | "too_short" | "invalid_code";

export type DmdSearchQuery =
  | { readonly kind: "code"; readonly id: string }
  | {
      readonly kind: "text";
      readonly terms: readonly string[];
      /** Prefix query for `to_tsquery('app.harbour_search', $1)`, always a bound parameter. */
      readonly tsQuery: string;
    };

export type DmdSearchQueryCheck =
  | { readonly ok: true; readonly query: DmdSearchQuery }
  | { readonly ok: false; readonly problem: DmdSearchProblem; readonly message: string };

const SEARCH_MESSAGES: Record<DmdSearchProblem, string> = {
  empty: "Type part of the medicine's name, or its dm+d code.",
  too_long: "Search for fewer words.",
  too_short: "Type at least 3 letters or numbers of the medicine's name.",
  invalid_code:
    "This is not a valid dm+d code. Check the number, or search by the medicine's name.",
};

/**
 * The search a person typed (rule 6): a dm+d code (6 digits or more, checked with `isDmdId`, so a
 * mistyped code never falls back to a near match), or words, each matched as the start of a word
 * in the product's name ("par 500" finds "Paracetamol 500mg tablets"). Names only: ingredients are
 * never searched (medical-device boundary).
 */
export function dmdSearchQuery(raw: string): DmdSearchQueryCheck {
  const fail = (problem: DmdSearchProblem): DmdSearchQueryCheck => ({
    ok: false,
    problem,
    message: SEARCH_MESSAGES[problem],
  });
  if (raw.length > DMD_SEARCH_LIMITS.maxQueryLength) return fail("too_long");
  const text = raw.normalize("NFKC").trim();
  if (text.length === 0) return fail("empty");
  if (/^\d{6,}$/.test(text)) {
    return isDmdId(text) ? { ok: true, query: { kind: "code", id: text } } : fail("invalid_code");
  }
  const terms = [...new Set(searchTerms(text))];
  if (terms.length > DMD_SEARCH_LIMITS.maxTerms) return fail("too_long");
  if (terms.join("").length < DMD_SEARCH_LIMITS.minCharacters) return fail("too_short");
  return {
    ok: true,
    query: { kind: "text", terms, tsQuery: terms.map((t) => `${t}:*`).join(" & ") },
  };
}

/**
 * The unit codes a dose of a VMP may be written in (medicines.md rule 2): the unit a dose is
 * counted in ("tablet"), the unit of the unit dose form size ("ml") and the units its strengths are
 * given in ("mg"), each once, in that order. Reference data only: Harbour never converts between
 * them (ADR-0080, H-652).
 */
export function dmdDoseUnitCodes(
  vmp: Pick<DmdVmp, "unitDoseUomCode" | "udfsUomCode" | "strengthUomCodes">,
): string[] {
  const codes = [vmp.unitDoseUomCode, vmp.udfsUomCode, ...vmp.strengthUomCodes].filter(
    (c): c is string => c !== null,
  );
  return [...new Set(codes)];
}

/**
 * What the medicines record checks a MAR entry against (`DmdProductFacts`): the dose units and the
 * routes dm+d gives for the VMP, with their dm+d names. A code the lookups do not hold is left out
 * rather than shown without a name.
 */
export function dmdProductFacts(
  vmp: Pick<DmdVmp, "unitDoseUomCode" | "udfsUomCode" | "strengthUomCodes" | "routeCodes">,
  lookups: ReadonlyMap<string, string>,
): DmdProductFacts {
  const named = (kind: DmdLookupKind, codes: readonly string[]) =>
    codes.flatMap((code) => {
      const name = lookups.get(dmdLookupKey({ kind, code }));
      return name === undefined ? [] : [{ code, name }];
    });
  const permittedDoseUnits: DoseUnit[] = named("unit_of_measure", dmdDoseUnitCodes(vmp));
  const permittedRoutes: DmdRoute[] = named("route", vmp.routeCodes);
  return { permittedDoseUnits, permittedRoutes };
}
