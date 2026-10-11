/**
 * Outbreak detection at one location (safety.md section 4 rule 7; hazard HZ-013). Computed across
 * the location's incidents and observations, not only the incident being recorded: the caller
 * passes every case since the location's last outbreak report.
 *
 * UKHSA, "Report an outbreak of acute respiratory infection in an adult social care setting"
 * (gov.uk, updated 11 September 2026, read 11 October 2026): report "a single confirmed case of
 * flu in your setting" and "a new outbreak of acute respiratory infection (ARI) – 2 or more people
 * in your setting with symptoms that started within 5 days of each other". "You only need to report
 * 2 or more ARI cases as an outbreak if they could be linked by spread within your setting ... If in
 * doubt, report as an outbreak." "Report as soon as possible."
 *
 * Diarrhoea and vomiting: `outbreak.diarrhoea_vomiting_cases` linked cases (master prompt 11.1).
 * No national time window was found (human action H-65), so linkage is a staff decision recorded
 * on each case; cases nobody has reviewed are listed for review once there are enough of them.
 *
 * Figures come from the rate table: `outbreak.ari_cases`, `outbreak.ari_window_days`,
 * `outbreak.flu_confirmed_cases`, `outbreak.diarrhoea_vomiting_cases`.
 */

import { type Citation, cite, SOURCES } from "../shared/citation";
import { ukIsoDate } from "../shared/working-days";
import type { SafetyRates } from "./rates";

export interface InfectionCase {
  /** Opaque id of the incident or observation. */
  readonly ref: string;
  readonly syndrome: "acute_respiratory" | "diarrhoea_vomiting";
  /** When the symptoms started (or were first noticed). */
  readonly onsetAt: Date;
  /** ARI: false only when the infection could not have been spread in the setting. */
  readonly couldBeLinkedWithinSetting: boolean | null;
  /** ARI: when a test confirmed flu, if it did. */
  readonly fluConfirmedAt?: Date | null;
  /** Diarrhoea and vomiting: the group staff linked this case to, or "not_linked". Null until reviewed. */
  readonly link?: { readonly group: string } | "not_linked" | null;
}

export interface OutbreakSignal {
  readonly kind: "acute_respiratory" | "flu" | "diarrhoea_vomiting";
  /** When the threshold was reached: the clock for the report starts here. */
  readonly thresholdMetAt: Date;
  readonly caseRefs: readonly string[];
  readonly reason: string;
  readonly sources: readonly Citation[];
}

export interface OutbreakAssessment {
  readonly signals: readonly OutbreakSignal[];
  /** Diarrhoea and vomiting cases nobody has reviewed for linkage, when there are enough to matter. */
  readonly casesToReviewForLinks: readonly string[];
}

const UKHSA = cite(
  "UKHSA",
  "Report an outbreak of acute respiratory infection in an adult social care setting",
  SOURCES.ukhsaAri,
);
const MASTER = cite("Harbour master prompt", "11.1 (UKHSA outbreak)", "docs/00-MASTER-PROMPT.md");

function dayNumber(instant: Date): number {
  return Date.parse(`${ukIsoDate(instant)}T00:00:00Z`) / 86_400_000;
}

const byOnset = (a: InfectionCase, b: InfectionCase) => a.onsetAt.getTime() - b.onsetAt.getTime();

/** The earliest cluster of ARI cases whose onsets fall within the window of each other. */
function ariSignal(cases: readonly InfectionCase[], rates: SafetyRates): OutbreakSignal | null {
  const ari = cases
    .filter((c) => c.syndrome === "acute_respiratory" && c.couldBeLinkedWithinSetting !== false)
    .sort(byOnset);
  let best: OutbreakSignal | null = null;
  for (let i = 0; i < ari.length; i++) {
    const first = ari[i] as InfectionCase;
    const cluster = ari.filter(
      (c, j) => j >= i && dayNumber(c.onsetAt) - dayNumber(first.onsetAt) <= rates.ariWindowDays,
    );
    if (cluster.length < rates.ariCases) continue;
    const metAt = (cluster[rates.ariCases - 1] as InfectionCase).onsetAt;
    if (!best || metAt.getTime() < best.thresholdMetAt.getTime()) {
      best = {
        kind: "acute_respiratory",
        thresholdMetAt: metAt,
        caseRefs: cluster.map((c) => c.ref),
        reason: `${cluster.length} people with acute respiratory infection symptoms that started within ${rates.ariWindowDays} days of each other (threshold ${rates.ariCases})`,
        sources: [UKHSA],
      };
    }
  }
  return best;
}

function fluSignal(cases: readonly InfectionCase[], rates: SafetyRates): OutbreakSignal | null {
  const confirmed = cases
    .filter((c) => c.syndrome === "acute_respiratory" && c.fluConfirmedAt)
    .sort((a, b) => (a.fluConfirmedAt as Date).getTime() - (b.fluConfirmedAt as Date).getTime());
  const metBy = confirmed[rates.fluConfirmedCases - 1];
  if (!metBy) return null;
  return {
    kind: "flu",
    thresholdMetAt: metBy.fluConfirmedAt as Date,
    caseRefs: confirmed.map((c) => c.ref),
    reason: `${confirmed.length} confirmed case${confirmed.length === 1 ? "" : "s"} of flu (threshold ${rates.fluConfirmedCases})`,
    sources: [UKHSA],
  };
}

function diarrhoeaVomitingSignals(
  cases: readonly InfectionCase[],
  rates: SafetyRates,
): OutbreakSignal[] {
  const groups = new Map<string, InfectionCase[]>();
  for (const c of cases) {
    if (c.syndrome !== "diarrhoea_vomiting" || !c.link || c.link === "not_linked") continue;
    groups.set(c.link.group, [...(groups.get(c.link.group) ?? []), c]);
  }
  const signals: OutbreakSignal[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort(byOnset);
    const metBy = sorted[rates.diarrhoeaVomitingCases - 1];
    if (!metBy) continue;
    signals.push({
      kind: "diarrhoea_vomiting",
      thresholdMetAt: metBy.onsetAt,
      caseRefs: sorted.map((c) => c.ref),
      reason: `${sorted.length} linked cases of diarrhoea and vomiting (threshold ${rates.diarrhoeaVomitingCases})`,
      sources: [MASTER],
    });
  }
  return signals.sort((a, b) => a.thresholdMetAt.getTime() - b.thresholdMetAt.getTime());
}

/** Whether the location's cases meet a reporting threshold, and from when. */
export function detectOutbreaks(
  cases: readonly InfectionCase[],
  rates: SafetyRates,
): OutbreakAssessment {
  const signals = [
    ariSignal(cases, rates),
    fluSignal(cases, rates),
    ...diarrhoeaVomitingSignals(cases, rates),
  ]
    .filter((s): s is OutbreakSignal => s !== null)
    .sort((a, b) => a.thresholdMetAt.getTime() - b.thresholdMetAt.getTime());
  const unreviewed = cases.filter((c) => c.syndrome === "diarrhoea_vomiting" && !c.link);
  return {
    signals,
    casesToReviewForLinks:
      unreviewed.length >= rates.diarrhoeaVomitingCases ? unreviewed.map((c) => c.ref) : [],
  };
}
