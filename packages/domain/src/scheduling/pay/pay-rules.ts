import { canonicalInput, formatPounds, percentOf, type WorkingLine } from "./money";

/**
 * Gross pay from a tenant's pay rule set (scheduling.md 4b rule 1; ADR-0086). Rates by role,
 * enhancements by kind (a percentage of the basic pay for those hours, or a flat amount an hour),
 * the sleep-in flat allowance, mileage and on-call. Tenant figures, not statutory ones: they live in
 * the versioned rule set, never in the rate table or the code. Where several enhancements apply to
 * the same hours only the highest is paid, unless the set says they stack.
 */

export type EnhancementKind = "night" | "weekend" | "bank_holiday" | "overtime";

export interface Enhancement {
  readonly kind: EnhancementKind;
  readonly mode: "percent" | "flat_per_hour";
  /** A percentage (25 for 25%), or pence an hour. */
  readonly value: number;
}

export interface PayRuleSet {
  readonly id: string;
  readonly version: number;
  /** Basic hourly rate in pence, by role key. */
  readonly roleRates: Readonly<Record<string, number>>;
  readonly enhancements: readonly Enhancement[];
  readonly stackEnhancements: boolean;
  readonly sleepInFlatPence: number;
  readonly mileagePencePerMile: number;
  readonly onCallFlatPence: number;
}

export type TimesheetEntry =
  | {
      readonly kind: "work";
      readonly role: string;
      readonly minutes: number;
      readonly enhancements: readonly EnhancementKind[];
    }
  | { readonly kind: "sleep_in" }
  | { readonly kind: "on_call" }
  | { readonly kind: "mileage"; readonly miles: number };

export interface GrossPay {
  readonly totalPence: number;
  /** Basic pay for hours worked (what counts towards NMW before premiums). */
  readonly basicPence: number;
  /** Enhancements above the basic rate (premiums: never counted for NMW). */
  readonly premiumPence: number;
  /** Sleep-in allowances, on-call and mileage. */
  readonly allowancePence: number;
  readonly working: readonly WorkingLine[];
  readonly canonicalInput: string;
}

export class PayRuleError extends Error {}

function enhancementPence(e: Enhancement, basicPence: number, minutes: number): number {
  return e.mode === "percent"
    ? percentOf(basicPence, e.value)
    : Math.floor((e.value * minutes) / 60);
}

export function grossPay(set: PayRuleSet, entries: readonly TimesheetEntry[]): GrossPay {
  const working: WorkingLine[] = [{ step: `Pay rule set ${set.id}, version ${set.version}` }];
  let basic = 0;
  let premium = 0;
  let allowance = 0;
  for (const entry of entries) {
    switch (entry.kind) {
      case "work": {
        const rate = set.roleRates[entry.role];
        if (rate === undefined) throw new PayRuleError(`No rate for the role "${entry.role}".`);
        if (!Number.isInteger(entry.minutes) || entry.minutes < 0) {
          throw new PayRuleError("Minutes worked must be a whole number of zero or more.");
        }
        const pay = Math.floor((rate * entry.minutes) / 60);
        basic += pay;
        working.push({
          step: `${entry.minutes} minutes as ${entry.role} at ${formatPounds(rate)} an hour (rounded down to the penny)`,
          pence: pay,
        });
        const applicable = set.enhancements
          .filter((e) => entry.enhancements.includes(e.kind))
          .map((e) => ({ e, pence: enhancementPence(e, pay, entry.minutes) }));
        const paid = set.stackEnhancements
          ? applicable
          : applicable.sort((a, b) => b.pence - a.pence).slice(0, 1);
        for (const { e, pence } of paid) {
          premium += pence;
          working.push({
            step:
              e.mode === "percent"
                ? `${e.kind.replace("_", " ")} enhancement: ${e.value}% of that`
                : `${e.kind.replace("_", " ")} enhancement: ${formatPounds(e.value)} an hour`,
            pence,
          });
        }
        if (!set.stackEnhancements && applicable.length > 1) {
          working.push({ step: "Only the highest enhancement is paid for the same hours" });
        }
        break;
      }
      case "sleep_in":
        allowance += set.sleepInFlatPence;
        working.push({ step: "Sleep-in allowance (flat)", pence: set.sleepInFlatPence });
        break;
      case "on_call":
        allowance += set.onCallFlatPence;
        working.push({ step: "On-call allowance (flat)", pence: set.onCallFlatPence });
        break;
      case "mileage": {
        const pence = Math.floor(set.mileagePencePerMile * entry.miles);
        allowance += pence;
        working.push({
          step: `${entry.miles} miles at ${set.mileagePencePerMile}p a mile`,
          pence,
        });
        break;
      }
    }
  }
  const total = basic + premium + allowance;
  working.push({ step: "Gross pay", pence: total });
  return {
    totalPence: total,
    basicPence: basic,
    premiumPence: premium,
    allowancePence: allowance,
    working,
    canonicalInput: canonicalInput({ set, entries }),
  };
}
