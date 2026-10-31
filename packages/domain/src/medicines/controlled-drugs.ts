/**
 * Controlled drugs register rules (medicines.md rules 24 to 27; master prompt 10.2 and 10.3;
 * Misuse of Drugs Regulations 2001 as the master prompt reads them; HZ-116). One page per person,
 * drug, form and strength (a dm+d VMP carries all three); entries are chronological and never
 * edited; every entry stores the balance after it, checked against the entry before; a mistake is
 * put right by a correction entry that refers to it, shown beside it (a margin correction). Each
 * entry has a second signature from a witness who is not the recorder: required where the tenant's
 * policy says so (by default in care homes), or, where it allows, "no witness available" with the
 * reason, flagged for manager review. Destruction is always witnessed. Slice 34 stores the register
 * (ADR-0083, ADR-0084); the step-up and the witness's own sign-in are the API's.
 */

import { addUkDays } from "../shared/time";
import type { DmdProductRef } from "./dmd";
import { formatDoseQuantity, isDoseQuantity } from "./dose";
import type { MedicinesRates } from "./rates";

export const CD_MOVEMENTS = [
  "receipt",
  "administration",
  "disposal",
  "transfer_out",
  "destruction",
  "correction",
] as const;
export type CdMovement = (typeof CD_MOVEMENTS)[number];

/** `required`: every entry needs a witness. `where_available`: a lone worker may record why there was none. */
export type CdWitnessPolicy = "required" | "where_available";

/** The service types a location runs (`service_type` in the platform schema). */
export type ServiceType =
  | "residential"
  | "nursing"
  | "supported_living"
  | "domiciliary"
  | "complex_care"
  | "live_in"
  | "respite"
  | "day_service"
  | "childrens_home";

/**
 * The tenant's default witness policy for a service (master prompt 10.3: on in residential and
 * nursing homes; a lone worker in home care or supported living may record that no witness was
 * available). A tenant may make any service stricter.
 */
export function defaultCdWitnessPolicy(service: ServiceType): CdWitnessPolicy {
  return service === "residential" ||
    service === "nursing" ||
    service === "respite" ||
    service === "childrens_home"
    ? "required"
    : "where_available";
}

/** The page a controlled drug's entries go on: the person and the dm+d VMP (drug, form and strength). */
export function cdPageKey(personId: string, product: Pick<DmdProductRef, "vmpId">): string {
  return `${personId}|${product.vmpId}`;
}

export interface CdEntry {
  readonly id: string;
  readonly pageKey: string;
  readonly movement: CdMovement;
  /** The amount moved; for a correction, the signed change it makes to the balance. */
  readonly quantity: number;
  /** The entry a correction puts right. */
  readonly correctsId: string | null;
  /** Why, for a correction. */
  readonly reason: string | null;
  readonly balanceAfter: number;
  readonly at: Date;
  readonly recordedBy: string;
  readonly witnessedBy: string | null;
  readonly noWitnessReason: string | null;
}

export type CdEntryProblem =
  | "wrong_page"
  | "not_chronological"
  | "bad_quantity"
  | "balance_wrong"
  | "balance_negative"
  | "correction_needs_entry"
  | "correction_needs_reason"
  | "not_a_correction"
  | "witness_required"
  | "witness_is_recorder"
  | "witness_and_no_witness";

export interface CdEntryIssue {
  readonly problem: CdEntryProblem;
  readonly message: string;
}

export type CdEntryCheck =
  | { readonly ok: true; readonly flags: readonly "no_witness_for_review"[] }
  | { readonly ok: false; readonly issues: readonly CdEntryIssue[] };

/** The balance after a movement: a receipt adds, a correction adds its signed change, the rest take away. */
export function cdBalanceAfter(previous: number, movement: CdMovement, quantity: number): number {
  const change = movement === "receipt" || movement === "correction" ? quantity : -quantity;
  // Quantities have at most 3 decimal places (liquids), so the sum is kept to that precision.
  return Math.round((previous + change) * 1000) / 1000;
}

/** Checks a new entry against the page it goes on and the tenant's witness policy (HZ-116). */
export function checkCdEntry(
  page: readonly CdEntry[],
  entry: CdEntry,
  policy: CdWitnessPolicy,
): CdEntryCheck {
  const issues: CdEntryIssue[] = [];
  const add = (problem: CdEntryProblem, message: string) => issues.push({ problem, message });
  const last = page[page.length - 1] ?? null;
  if (page.some((e) => e.pageKey !== entry.pageKey)) {
    add(
      "wrong_page",
      "This entry belongs on another page: one page per person, drug, form and strength.",
    );
  }
  if (last && entry.at.getTime() < last.at.getTime()) {
    add(
      "not_chronological",
      "Entries go in time order. Record a correction instead of an earlier entry.",
    );
  }
  const size = Math.abs(entry.quantity);
  if (!isDoseQuantity(size) || (entry.movement !== "correction" && entry.quantity < 0)) {
    add("bad_quantity", "Record the amount as a number more than zero.");
  } else {
    const expected = cdBalanceAfter(last?.balanceAfter ?? 0, entry.movement, entry.quantity);
    if (expected < 0) {
      add(
        "balance_negative",
        "This would leave less than none. Count the stock and tell the nurse in charge.",
      );
    } else if (entry.balanceAfter !== expected) {
      add(
        "balance_wrong",
        `The balance after this entry is ${expected === 0 ? "0" : formatDoseQuantity(expected)}, not ${entry.balanceAfter}. Check the count.`,
      );
    }
  }
  if (entry.movement === "correction") {
    if (!entry.correctsId || !page.some((e) => e.id === entry.correctsId)) {
      add(
        "correction_needs_entry",
        "Choose the entry on this page that the correction puts right.",
      );
    }
    if (!entry.reason || entry.reason.trim() === "") {
      add("correction_needs_reason", "Say what was wrong.");
    }
  } else if (entry.correctsId !== null) {
    add("not_a_correction", "Only a correction refers to another entry.");
  }
  const noWitness = entry.noWitnessReason !== null && entry.noWitnessReason.trim() !== "";
  if (entry.witnessedBy !== null && noWitness) {
    add("witness_and_no_witness", "Record a witness or why there was none, not both.");
  } else if (entry.witnessedBy !== null && entry.witnessedBy === entry.recordedBy) {
    add(
      "witness_is_recorder",
      "The witness must be someone other than the person recording the entry.",
    );
  } else if (entry.witnessedBy === null) {
    const alwaysWitnessed = entry.movement === "destruction";
    if (policy === "required" || alwaysWitnessed || !noWitness) {
      add(
        "witness_required",
        alwaysWitnessed
          ? "Destruction is always witnessed."
          : policy === "required"
            ? "A second person must witness this entry."
            : "Record the witness, or why no witness was available.",
      );
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, flags: entry.witnessedBy === null ? ["no_witness_for_review"] : [] };
}

/** The balance a page shows, read from its last entry (every entry stores it). */
export function cdPageBalance(page: readonly CdEntry[]): number {
  return page[page.length - 1]?.balanceAfter ?? 0;
}

/** A stock count against the page: any difference raises an incident (slice 34; HZ-115 from then). */
export function cdStockCheck(
  page: readonly CdEntry[],
  counted: number,
): {
  readonly expected: number;
  readonly counted: number;
  readonly difference: number;
  readonly raiseIncident: boolean;
} {
  const expected = cdPageBalance(page);
  const difference = Math.round((counted - expected) * 1000) / 1000;
  return { expected, counted, difference, raiseIncident: difference !== 0 };
}

/** When a page's next stock check is due (`medicines.cd.stock_check_interval_days`, in UK days). */
export function cdStockCheckDueAt(
  lastCheckedAt: Date,
  rates: Pick<MedicinesRates, "cdStockCheckIntervalDays">,
): Date {
  return addUkDays(lastCheckedAt, rates.cdStockCheckIntervalDays);
}
