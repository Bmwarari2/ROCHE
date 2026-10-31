/**
 * Periods prepared for the working time checks. Internal to the scheduling module. Only periods
 * that count as working time take part: a period's whole span (its breaks included, since a rest
 * break is not a rest period) marks the worker as busy for daily and weekly rest; its working
 * spans (breaks taken out) give the hours.
 */

import { assertValidPeriod, netWorkingSpans } from "./classification";
import {
  clip,
  DAYS_PER_WEEK,
  daysFrom,
  mergeSpans,
  plusDays,
  type Span,
  spanMinutes,
  subtractSpans,
  ukDateOf,
  ukDay,
  ukDays,
} from "./intervals";
import type { WorkPeriod, YoungWorkerException } from "./working-time-types";

export interface PreparedPeriod {
  readonly period: WorkPeriod;
  readonly whole: Span;
  readonly net: readonly Span[];
  readonly own: boolean;
}

export function preparePeriods(periods: readonly WorkPeriod[]): PreparedPeriod[] {
  const prepared: PreparedPeriod[] = [];
  for (const period of periods) {
    assertValidPeriod(period);
    const net = netWorkingSpans(period);
    if (net.length === 0) continue;
    prepared.push({
      period,
      whole: { start: period.start, end: period.end },
      net,
      own: (period.employer ?? "this") === "this",
    });
  }
  return prepared.sort((a, b) => a.whole.start.getTime() - b.whole.start.getTime());
}

export function netMinutesIn(prepared: readonly PreparedPeriod[], window: Span): number {
  let total = 0;
  for (const p of prepared) {
    for (const span of p.net) {
      const part = clip(span, window);
      if (part) total += spanMinutes(part);
    }
  }
  return total;
}

/** Ids of the periods with working time inside a window. */
export function idsIn(prepared: readonly PreparedPeriod[], window: Span): string[] {
  return prepared.filter((p) => p.net.some((s) => clip(s, window))).map((p) => p.period.id);
}

/** Times the worker is at work (merged whole spans), for finding rest. */
export function busySpans(prepared: readonly PreparedPeriod[]): Span[] {
  return mergeSpans(prepared.map((p) => p.whole));
}

/** Working minutes per UK date. */
export function minutesByUkDate(prepared: readonly PreparedPeriod[]): Map<string, number> {
  const byDate = new Map<string, number>();
  for (const p of prepared) {
    for (const span of p.net) {
      const last = ukDateOf(new Date(span.end.getTime() - 1));
      for (let d = ukDateOf(span.start); d <= last; d = plusDays(d, 1)) {
        const part = clip(span, ukDay(d));
        if (part) byDate.set(d, (byDate.get(d) ?? 0) + spanMinutes(part));
      }
    }
  }
  return byDate;
}

export interface Duty extends Span {
  readonly members: readonly PreparedPeriod[];
  /** Breaks taken inside the duty: recorded breaks and gaps between its parts. */
  readonly breaks: readonly Span[];
  readonly minutes: number;
}

/**
 * Groups periods into duties: parts sharing a `dutyId` (a split shift) and periods that overlap
 * or touch. A break only counts if it starts after the duty starts and ends before it ends.
 */
export function duties(prepared: readonly PreparedPeriod[]): Duty[] {
  const groups = new Map<string, PreparedPeriod[]>();
  for (const p of prepared) {
    const key = p.period.dutyId ?? `period:${p.period.id}`;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  const spans = [...groups.values()]
    .map((members) => ({ members, span: spanOf(members) }))
    .sort((a, b) => a.span.start.getTime() - b.span.start.getTime());
  const merged: { members: PreparedPeriod[]; span: Span }[] = [];
  for (const group of spans) {
    const last = merged[merged.length - 1];
    if (last && group.span.start <= last.span.end) {
      last.members.push(...group.members);
      last.span = {
        start: last.span.start,
        end: group.span.end > last.span.end ? group.span.end : last.span.end,
      };
    } else {
      merged.push({ members: [...group.members], span: group.span });
    }
  }
  return merged.map(({ members, span }) => {
    const recorded = members.flatMap((m) => m.period.breaks ?? []);
    const gaps = subtractSpans(
      span,
      members.map((m) => m.whole),
    );
    const breaks = mergeSpans([...recorded, ...gaps]).filter(
      (b) => b.start > span.start && b.end < span.end,
    );
    return {
      ...span,
      members,
      breaks,
      minutes: members.reduce((sum, m) => sum + m.net.reduce((s, n) => s + spanMinutes(n), 0), 0),
    };
  });
}

function spanOf(members: readonly PreparedPeriod[]): Span {
  let start = members[0]?.whole.start as Date;
  let end = members[0]?.whole.end as Date;
  for (const m of members) {
    if (m.whole.start < start) start = m.whole.start;
    if (m.whole.end > end) end = m.whole.end;
  }
  return { start, end };
}

/** True when the exception is recorded with its reason (and, for 27A(1), both conditions). */
export function exceptionHolds(
  exception: YoungWorkerException | undefined,
  basis: YoungWorkerException["basis"],
): boolean {
  if (!exception || exception.basis !== basis || exception.reason.trim() === "") return false;
  if (exception.basis === "continuity_or_surge") {
    return exception.noAdultAvailable && exception.educationUnaffected;
  }
  return true;
}

export interface ReferenceWindow {
  readonly from: string;
  readonly to: string;
  readonly weeks: number;
}

/**
 * The reference periods ending in an evaluation range (reg 4(3), (4) and 6(3), (4)). While the
 * worker has served less than a full period, the period is the time since they started, checked
 * at each whole week of service. After that, a rolling period ends on every day ("any period of
 * N weeks"), or, where an agreement provides, successive periods run from its date.
 */
export function referenceWindows(
  employmentStart: string,
  weeks: number,
  successiveFrom: string | null,
  evaluateFrom: string,
  evaluateTo: string,
): ReferenceWindow[] {
  const length = weeks * DAYS_PER_WEEK;
  const windows = new Map<string, ReferenceWindow>();
  const add = (w: ReferenceWindow) => windows.set(`${w.from}|${w.to}`, w);
  for (let end = evaluateFrom; end <= evaluateTo; end = plusDays(end, 1)) {
    const served = daysFrom(employmentStart, end) + 1;
    if (served < 1) continue;
    if (served < length) {
      if (served % DAYS_PER_WEEK === 0) {
        add({ from: employmentStart, to: end, weeks: served / DAYS_PER_WEEK });
      }
    } else if (successiveFrom === null) {
      add({ from: plusDays(end, 1 - length), to: end, weeks });
    }
  }
  if (successiveFrom !== null) {
    const first = Math.floor(daysFrom(successiveFrom, evaluateFrom) / length);
    const last = Math.floor(daysFrom(successiveFrom, evaluateTo) / length);
    for (let k = first; k <= last; k++) {
      const from = plusDays(successiveFrom, k * length);
      if (from >= employmentStart) add({ from, to: plusDays(from, length - 1), weeks });
    }
  }
  return [...windows.values()].sort(
    (a, b) => a.to.localeCompare(b.to) || a.from.localeCompare(b.from),
  );
}

/**
 * Joins reference windows that overlap into runs, keeping the worst value, so one problem across
 * many rolling periods is reported once. Windows come sorted by their last day.
 */
export function windowRuns<W extends ReferenceWindow>(
  windows: readonly W[],
  value: (w: W) => number,
): { from: string; to: string; worst: number }[] {
  const runs: { from: string; to: string; worst: number }[] = [];
  for (const w of windows) {
    const last = runs[runs.length - 1];
    if (last && w.from <= last.to) {
      last.to = w.to > last.to ? w.to : last.to;
      last.worst = Math.max(last.worst, value(w));
    } else {
      runs.push({ from: w.from, to: w.to, worst: value(w) });
    }
  }
  return runs;
}

/** The UK span of a reference window. */
export function windowSpan(w: { readonly from: string; readonly to: string }): Span {
  return ukDays(w.from, w.to);
}
