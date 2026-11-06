import type { Transaction } from "@harbour/db";
import {
  type DmdRoute,
  describeSchedule,
  entryVersionIds,
  formatDose,
  isTimeCritical,
  type MarEntry,
  type MedicinesDueStatement,
  type MedicinesRates,
  type MedicinesStatement,
  marEntryStatus,
  type TransferMedicine,
  ukIsoDate,
} from "@harbour/domain";
import {
  type AdministrationRow,
  effective,
  medicinesRates,
  personAdministrations,
} from "./medicine-administrations";
import { roundFor, TAKEN } from "./medicine-rounds";
import { personEntries, UNCHECKED_POLICY } from "./medicines";
import { loadPerson } from "./people";

/**
 * Medicines in the Phase 1 outputs (slice 49; medicines.md section 16; HZ-021, HZ-023): the
 * downtime pack's doses due and the transfer pack's current medicines, from the eMAR. Each list
 * carries when it was read, and the packs print that it is not the live record. The lists show the
 * record and pass it on; they never say what to give (medical-device boundary). A person with no
 * eMAR entries keeps the Phase 1 source (where the paper MAR is kept; the pre-admission list).
 */

export interface EmarFacts {
  readonly entries: readonly MarEntry[];
  readonly rows: readonly AdministrationRow[];
  readonly rates: MedicinesRates;
}

/** The person's eMAR, or null when they have no entry on it. */
export async function emarFacts(
  tx: Transaction,
  tenantId: string,
  personId: string,
  now: Date,
): Promise<EmarFacts | null> {
  const entries = (await personEntries(tx, personId)).map((s) => s.entry);
  if (entries.length === 0) return null;
  const { nation } = await loadPerson(tx, personId);
  return {
    entries,
    rows: await personAdministrations(tx, personId),
    rates: await medicinesRates(tx, tenantId, nation, ukIsoDate(now)),
  };
}

const routeWords = (route: DmdRoute) => route.name;

/** HZ-021: the doses due from `from` to `until`, those still outstanding from before, and PRNs. */
export function downtimeMedicinesFrom(
  facts: EmarFacts,
  from: Date,
  until: Date,
  now: Date,
): MedicinesDueStatement {
  const byId = new Map(facts.entries.map((e) => [e.id, e]));
  const round = roundFor(facts, { from, to: until }, now, now);
  const scheduled = round.doses.map((d) => {
    const entry = byId.get(d.entryId);
    const dueAt = new Date(d.dueAt);
    const open = d.state !== "recorded";
    return {
      name: d.productName,
      dose: d.doseInWords,
      route: entry ? routeWords(entry.route) : "",
      dueAt,
      timeCritical: d.timeCritical,
      status: open ? ("due" as const) : ("given" as const),
      givenAt: null,
      outstanding: open && dueAt.getTime() < from.getTime(),
    };
  });
  const prn = round.whenRequired.map((p) => {
    const entry = byId.get(p.entryId);
    return {
      name: p.productName,
      dose: entry?.directions.kind === "when_required" ? formatDose(entry.directions.dose) : "",
      route: entry ? routeWords(entry.route) : "",
      reason: entry?.indication ?? null,
      lastGivenAt: p.lastGiven ? new Date(p.lastGiven.at) : null,
    };
  });
  return { status: "recorded", scheduled, prn, producedAt: now };
}

const NOT_IN_FORCE: ReadonlySet<string> = new Set([
  "Withdrawn before it started",
  "Not started yet",
  "Replaced by a newer entry",
  "Stopped",
  "Ended",
]);

/** HZ-023: the medicines in force on the eMAR now, each with when it was last taken. */
export function transferMedicinesFrom(facts: EmarFacts, now: Date): MedicinesStatement {
  const taken = effective(facts.rows).filter((r) => TAKEN.has(r.outcome) && r.givenAt);
  const items: TransferMedicine[] = facts.entries.flatMap((entry) => {
    const status = marEntryStatus(entry, now, UNCHECKED_POLICY);
    if (NOT_IN_FORCE.has(status.words)) return [];
    const versions = entryVersionIds(entry, facts.entries);
    const last = taken
      .filter((r) => versions.has(r.medicationId))
      .reduce<Date | null>(
        (at, r) => (at === null || (r.givenAt as Date) > at ? (r.givenAt as Date) : at),
        null,
      );
    const d = entry.directions;
    return [
      {
        name: entry.product.name,
        dose:
          d.kind === "when_required"
            ? formatDose(d.dose)
            : [...new Set(d.schedule.times.map((t) => formatDose(t.dose)))].join("; "),
        route: routeWords(entry.route),
        frequency: d.kind === "when_required" ? "When required" : describeSchedule(d.schedule),
        lastGivenAt: last,
        timeCritical: isTimeCritical(entry),
        status: status.words === "Checked" ? null : status.words,
      },
    ];
  });
  return { status: "recorded", source: "emar", items, producedAt: now };
}
