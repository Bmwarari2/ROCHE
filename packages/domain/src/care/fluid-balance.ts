/**
 * Fluid balance chart (care.md section 4 rule 6). The day runs from 00:00 to 24:00 in the
 * location's time zone, so the clock-change days are 23 and 25 hours long (HZ-009). Every Harbour
 * location is in the UK, so the location's IANA zone is Europe/London and the UK time helpers
 * apply. The daily target is the person's own, set by staff in the care plan; with no target the
 * chart says so and never invents one. Arithmetic only, no interpretation (medical-device
 * boundary, section 3).
 */

import { fromUkWallClock, type UK_TIME_ZONE } from "../shared/time";
import { InputCheck, type InputIssue, isIsoDate } from "./assessment";

export type LocationTimeZone = typeof UK_TIME_ZONE;

export interface FluidEntry {
  readonly occurredAt: Date;
  readonly kind: "intake" | "output";
  /** Millilitres, a whole number above 0. */
  readonly volumeMl: number;
}

export interface FluidDayInput {
  /** The local calendar day, yyyy-mm-dd. */
  readonly date: string;
  readonly timeZone: LocationTimeZone;
  readonly entries: readonly FluidEntry[];
  /** The person's daily intake target in millilitres, or null when none is set. */
  readonly targetMl: number | null;
  /** Totals so far: entries after this instant are left out. Defaults to the whole day. */
  readonly asAt?: Date;
}

export type FluidTargetProgress =
  | { readonly status: "no_target" }
  | {
      readonly status: "target_set";
      readonly targetMl: number;
      /** Target minus intake so far, never below 0. */
      readonly shortfallMl: number;
      readonly met: boolean;
    };

export interface FluidDaySummary {
  readonly date: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  /** 24, or 23 and 25 on the clock-change days. */
  readonly hoursInDay: number;
  readonly intakeMl: number;
  readonly outputMl: number;
  /** Intake minus output. */
  readonly balanceMl: number;
  readonly entriesCounted: number;
  readonly target: FluidTargetProgress;
}

export type FluidDayOutcome =
  | { readonly ok: true; readonly summary: FluidDaySummary }
  | { readonly ok: false; readonly issues: readonly InputIssue[] };

const MS_PER_HOUR = 3_600_000;
/** Upper limit for a single entry or a target, as a typing check only. */
const MAX_VOLUME_ML = 100_000;

/** The instants at which a UK calendar day starts and ends. */
export function ukDayBounds(date: string): { readonly startsAt: Date; readonly endsAt: Date } {
  if (!isIsoDate(date)) throw new RangeError(`Not a date: ${date}`);
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return {
    startsAt: fromUkWallClock(year, month, day, 0, 0),
    endsAt: fromUkWallClock(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0),
  };
}

export function fluidDaySummary(input: FluidDayInput): FluidDayOutcome {
  const check = new InputCheck();
  if (!isIsoDate(input.date)) {
    check.add("date", "not_allowed", "The chart date must be a real date (yyyy-mm-dd).");
  }
  input.entries.forEach((entry, index) => {
    check.number(`entries.${index}.volumeMl`, "Volume", entry.volumeMl, {
      min: 1,
      max: MAX_VOLUME_ML,
      decimals: 0,
    });
  });
  if (input.targetMl !== null) {
    check.number("targetMl", "Daily target", input.targetMl, {
      min: 1,
      max: MAX_VOLUME_ML,
      decimals: 0,
    });
  }
  if (check.failed) return { ok: false, issues: check.issues };

  const { startsAt, endsAt } = ukDayBounds(input.date);
  const until = Math.min(endsAt.getTime(), input.asAt?.getTime() ?? endsAt.getTime());
  const counted = input.entries.filter((e) => {
    const t = e.occurredAt.getTime();
    // A day runs from 00:00 inclusive to the next 00:00 exclusive.
    return t >= startsAt.getTime() && t < endsAt.getTime() && t <= until;
  });
  const total = (kind: FluidEntry["kind"]) =>
    counted.filter((e) => e.kind === kind).reduce((sum, e) => sum + e.volumeMl, 0);
  const intakeMl = total("intake");
  const outputMl = total("output");
  const target: FluidTargetProgress =
    input.targetMl === null
      ? { status: "no_target" }
      : {
          status: "target_set",
          targetMl: input.targetMl,
          shortfallMl: Math.max(0, input.targetMl - intakeMl),
          met: intakeMl >= input.targetMl,
        };
  return {
    ok: true,
    summary: {
      date: input.date,
      startsAt,
      endsAt,
      hoursInDay: (endsAt.getTime() - startsAt.getTime()) / MS_PER_HOUR,
      intakeMl,
      outputMl,
      balanceMl: intakeMl - outputMl,
      entriesCounted: counted.length,
      target,
    },
  };
}
