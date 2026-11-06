/**
 * The dm+d subset a device holds (integrations.md section 11 rule 9; ADR-0080; HZ-113). A phone or
 * tablet at the point of care holds only the dm+d rows its location's MARs need, never the whole
 * dictionary: each product named on a MAR entry, the products that replaced it, the packs that
 * could be in the person's hand and the barcodes printed on them, and the lookups those rows name.
 * Slice 68 sends the subset on the medicines sync streams; this is the rule that chooses it.
 *
 * A MAR entry naming a VMP may be given from any supplier's pack of it, so every valid AMP and pack
 * of the VMP comes with it; an entry naming an AMP brings that AMP's packs only. Invalid AMPs and
 * packs are left out unless the MAR names them, so a scan of one never matches; withdrawn and ended
 * GTINs are left out, so they never match either. A product the MAR names that the reference data
 * does not hold is returned as `unresolved`, for the device to say so rather than show nothing.
 */

import type { DmdAmp, DmdAmpp, DmdGtin, DmdLookupKind, DmdVmp, DmdVmpp } from "./dmd-release";
import { dmdGtinKey, dmdLookupKey } from "./dmd-release";

/** A product named on a MAR entry at the location. */
export interface DmdSubsetNeed {
  readonly vmpId: string;
  readonly ampId: string | null;
}

/** Stored rows for the products needed (the API reads them; more rows than needed is fine). */
export interface DmdSubsetRows {
  readonly vmps: readonly (DmdVmp & { readonly supersededBy: string | null })[];
  readonly amps: readonly DmdAmp[];
  readonly vmpps: readonly DmdVmpp[];
  readonly ampps: readonly DmdAmpp[];
  readonly gtins: readonly (DmdGtin & { readonly withdrawn: boolean })[];
}

export interface DmdDeviceSubset {
  readonly vtmIds: readonly string[];
  readonly vmpIds: readonly string[];
  readonly ampIds: readonly string[];
  readonly vmppIds: readonly string[];
  readonly amppIds: readonly string[];
  /** GTIN mapping keys (`dmdGtinKey`). */
  readonly gtinKeys: readonly string[];
  /** Lookup keys (`dmdLookupKey`). */
  readonly lookupKeys: readonly string[];
  /** Identifiers a MAR names that the reference data does not hold (HZ-113). */
  readonly unresolved: readonly string[];
}

/** Follows `supersededBy` from a VMP, returning it and each product that replaced it, in order. */
function supersessionChain<T extends { readonly id: string; readonly supersededBy: string | null }>(
  start: T,
  byId: ReadonlyMap<string, T>,
): T[] {
  const chain = [start];
  const seen = new Set([start.id]);
  let next = start.supersededBy;
  while (next !== null && !seen.has(next)) {
    const found = byId.get(next);
    if (!found) break;
    chain.push(found);
    seen.add(found.id);
    next = found.supersededBy;
  }
  return chain;
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = out.get(k);
    if (list) list.push(row);
    else out.set(k, [row]);
  }
  return out;
}

/**
 * The dm+d rows a location's devices need for the products on its MARs, on today's UK date
 * (`todayUk`, YYYY-MM-DD): a GTIN that ended before today is left out, one that starts later is
 * kept (the device may be offline when it starts, and checks the dates when it scans).
 */
export function selectDmdDeviceSubset(
  needs: readonly DmdSubsetNeed[],
  rows: DmdSubsetRows,
  todayUk: string,
): DmdDeviceSubset {
  const vmpById = new Map(rows.vmps.map((v) => [v.id, v]));
  const ampById = new Map(rows.amps.map((a) => [a.id, a]));
  const vmppById = new Map(rows.vmpps.map((v) => [v.id, v]));
  const ampsByVmp = groupBy(rows.amps, (a) => a.vmpId);
  const amppsByAmp = groupBy(rows.ampps, (a) => a.ampId);
  const gtinsByAmpp = groupBy(rows.gtins, (g) => g.amppId);

  const vtmIds = new Set<string>();
  const vmpIds = new Set<string>();
  const ampIds = new Set<string>();
  const vmppIds = new Set<string>();
  const amppIds = new Set<string>();
  const gtinKeys = new Set<string>();
  const lookups = new Set<string>();
  const unresolved = new Set<string>();

  const lookup = (kind: DmdLookupKind, code: string | null) => {
    if (code !== null) lookups.add(dmdLookupKey({ kind, code }));
  };
  const addAmpp = (ampp: DmdAmpp) => {
    if (amppIds.has(ampp.id)) return;
    amppIds.add(ampp.id);
    lookup("legal_category", ampp.legalCategoryCode);
    const vmpp = vmppById.get(ampp.vmppId);
    if (vmpp) {
      vmppIds.add(vmpp.id);
      lookup("unit_of_measure", vmpp.quantityUomCode);
    } else unresolved.add(ampp.vmppId);
    for (const g of gtinsByAmpp.get(ampp.id) ?? []) {
      if (g.withdrawn) continue;
      if (g.endDate !== null && g.endDate < todayUk) continue;
      gtinKeys.add(dmdGtinKey(g));
    }
  };
  const addAmp = (amp: DmdAmp) => {
    ampIds.add(amp.id);
    for (const code of amp.licensedRouteCodes) lookup("route", code);
    for (const ampp of amppsByAmp.get(amp.id) ?? []) if (!ampp.invalid) addAmpp(ampp);
  };
  const addVmp = (vmp: DmdVmp) => {
    vmpIds.add(vmp.id);
    if (vmp.vtmId !== null) vtmIds.add(vmp.vtmId);
    lookup("unit_of_measure", vmp.unitDoseUomCode);
    lookup("unit_of_measure", vmp.udfsUomCode);
    for (const code of vmp.strengthUomCodes) lookup("unit_of_measure", code);
    lookup("form", vmp.formCode);
    for (const code of vmp.routeCodes) lookup("route", code);
    lookup("control_drug_category", vmp.controlDrugCategoryCode);
  };

  for (const need of needs) {
    const named = vmpById.get(need.vmpId);
    if (!named) {
      unresolved.add(need.vmpId);
      if (need.ampId !== null) unresolved.add(need.ampId);
      continue;
    }
    const chain = supersessionChain(named, vmpById);
    for (const vmp of chain) addVmp(vmp);
    if (need.ampId !== null) {
      const amp = ampById.get(need.ampId);
      if (!amp || !chain.some((v) => v.id === amp.vmpId)) {
        unresolved.add(need.ampId);
        continue;
      }
      // The AMP the MAR names comes even when invalid, so the device can show what was prescribed;
      // its packs come only when valid.
      addAmp(amp);
      continue;
    }
    for (const vmp of chain) {
      for (const amp of ampsByVmp.get(vmp.id) ?? []) if (!amp.invalid) addAmp(amp);
    }
  }

  const sorted = (s: Set<string>) => [...s].sort();
  return {
    vtmIds: sorted(vtmIds),
    vmpIds: sorted(vmpIds),
    ampIds: sorted(ampIds),
    vmppIds: sorted(vmppIds),
    amppIds: sorted(amppIds),
    gtinKeys: sorted(gtinKeys),
    lookupKeys: sorted(lookups),
    unresolved: sorted(unresolved),
  };
}
