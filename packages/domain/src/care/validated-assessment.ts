/**
 * Stored results of the locked validated tools (care.md section 4 rule 5; register rows CARE-003
 * and CARE-006; hazards HZ-012 and HZ-014). The API runs the published calculator on the server by
 * its key and stores what it returns: tool key and version, answers, score, band, workings,
 * triggers and the date the tool is next due. Nothing here re-scores or re-bands a tool.
 *
 * Next due dates. MUST repeats every `must.care_home.screening_interval_months` months (BAPEN, in
 * care homes). Waterlow, Braden and the NG249 falls pathway have no published repeat interval in
 * the spec: they are repeated at each care plan review (`care_plan.review_interval_months`) and on
 * change, which is how NG249 1.1.7 ("at review") and NICE CG179 (reassess when the person's
 * condition changes) are met. NEWS2 is a vital signs chart, recorded through observations.
 *
 * Waterlow and Braden wait for licence confirmation (human action H-25): each has a feature flag
 * that is off by default, and the tool is refused while its flag is off.
 */

import type { FlagKey } from "../platform/feature-flags";
import {
  addMonthsToDate,
  type CareTrigger,
  isIsoDate,
  type ScoreWorking,
  type ToolOutcome,
} from "./assessment";
import { type BradenInput, calculateBraden } from "./braden";
import { type FallsPathwayInput, ng249FallsPathway } from "./falls";
import { calculateMust, type MustInput } from "./must";
import type { CareRates } from "./rates";
import { TOOLS_AWAITING_LICENCE_CONFIRMATION } from "./tools";
import { calculateWaterlow, type WaterlowInput } from "./waterlow";

export const ASSESSMENT_TOOL_KEYS = ["must", "waterlow", "braden", "ng249_falls"] as const;
export type AssessmentToolKey = (typeof ASSESSMENT_TOOL_KEYS)[number];

export type AssessmentInput =
  | { readonly toolKey: "must"; readonly answers: Omit<MustInput, "screenedOn"> }
  | { readonly toolKey: "waterlow"; readonly answers: WaterlowInput }
  | { readonly toolKey: "braden"; readonly answers: BradenInput }
  | { readonly toolKey: "ng249_falls"; readonly answers: FallsPathwayInput };

export interface AssessmentRecord {
  readonly toolKey: AssessmentToolKey;
  readonly toolVersion: string;
  /** Null for the NG249 falls pathway, which never scores (NG249 1.1.1). */
  readonly score: number | null;
  readonly band: string | null;
  readonly workings: readonly ScoreWorking[];
  readonly triggers: readonly CareTrigger[];
  /** Tool-specific detail shown with the result, for example the exact BMI or the NG249 reason. */
  readonly details: Readonly<Record<string, unknown>>;
  readonly nextDueOn: string;
}

export interface AssessmentContext {
  /** The day the assessment was done (UK date), from which the next one falls due. */
  readonly assessedOn: string;
  readonly rates: Pick<
    CareRates,
    | "mustScreeningIntervalMonths"
    | "mustMediumRiskFoodRecordDays"
    | "weightDefaultIntervalMonths"
    | "weightAtRiskIntervalWeeks"
  >;
  readonly reviewIntervalMonths: number;
}

/** The feature flag that must be on before a tool can be used, or null when none is needed. */
export function toolFlag(toolKey: AssessmentToolKey): FlagKey | null {
  return TOOLS_AWAITING_LICENCE_CONFIRMATION.find((t) => t.toolKey === toolKey)?.flagKey ?? null;
}

export function toolAvailable(
  toolKey: AssessmentToolKey,
  enabled: (flag: FlagKey) => boolean,
): boolean {
  const flag = toolFlag(toolKey);
  return flag === null || enabled(flag);
}

export function runAssessment(
  input: AssessmentInput,
  context: AssessmentContext,
): ToolOutcome<AssessmentRecord> {
  if (!isIsoDate(context.assessedOn)) {
    const message = "The assessment date must be a real date (yyyy-mm-dd).";
    return {
      ok: false,
      code: "invalid",
      message,
      issues: [{ item: "assessedOn", problem: "not_allowed", message }],
    };
  }
  const atReview = addMonthsToDate(context.assessedOn, context.reviewIntervalMonths);
  const rescreen = (toolKey: AssessmentToolKey): CareTrigger => ({
    kind: "rescreen",
    toolKey,
    dueOn: atReview,
  });

  switch (input.toolKey) {
    case "must": {
      const outcome = calculateMust(
        { ...input.answers, screenedOn: context.assessedOn },
        context.rates,
      );
      if (!outcome.ok) return outcome;
      const r = outcome.result;
      return {
        ok: true,
        result: {
          toolKey: "must",
          toolVersion: r.toolVersion,
          score: r.score,
          band: r.band,
          workings: r.workings,
          triggers: r.triggers,
          details: {
            bmi: r.bmi,
            obese: r.obese,
            weightLossPercent: r.weightLossPercent,
            assessorJudgement: r.assessorJudgement,
          },
          nextDueOn: r.nextScreeningDueOn,
        },
      };
    }
    case "waterlow": {
      const outcome = calculateWaterlow(input.answers);
      if (!outcome.ok) return outcome;
      const r = outcome.result;
      return {
        ok: true,
        result: {
          toolKey: "waterlow",
          toolVersion: r.toolVersion,
          score: r.score,
          band: r.band,
          workings: r.workings,
          triggers: [...r.triggers, rescreen("waterlow")],
          details: { bmi: r.bmi, malnutritionScore: r.malnutritionScore },
          nextDueOn: atReview,
        },
      };
    }
    case "braden": {
      const outcome = calculateBraden(input.answers);
      if (!outcome.ok) return outcome;
      const r = outcome.result;
      return {
        ok: true,
        result: {
          toolKey: "braden",
          toolVersion: r.toolVersion,
          score: r.score,
          band: r.band,
          workings: r.workings,
          triggers: [...r.triggers, rescreen("braden")],
          details: { bandLabel: r.bandLabel },
          nextDueOn: atReview,
        },
      };
    }
    case "ng249_falls": {
      const outcome = ng249FallsPathway(input.answers);
      if (!outcome.ok) return outcome;
      const r = outcome.result;
      return {
        ok: true,
        result: {
          toolKey: "ng249_falls",
          toolVersion: r.toolVersion,
          score: null,
          band: null,
          workings: [],
          triggers: [...r.triggers, rescreen("ng249_falls")],
          details: {
            setting: r.setting,
            answers: r.answers,
            outcome: r.outcome,
            recommendation: r.recommendation,
            reason: r.reason,
            criteriaMet: r.criteriaMet,
          },
          nextDueOn: atReview,
        },
      };
    }
  }
}

export type CorrectionCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly problem: "not_found" | "tool" | "reason";
      readonly message: string;
    };

/** A correction re-runs the same tool for the same person and says why (Reg 17, HZ-017). */
export function checkAssessmentCorrection(
  original: { readonly toolKey: string } | null,
  toolKey: AssessmentToolKey,
  reason: string | null | undefined,
): CorrectionCheck {
  if (original === null) {
    return {
      ok: false,
      problem: "not_found",
      message: "The result being corrected was not found.",
    };
  }
  if (original.toolKey !== toolKey) {
    return {
      ok: false,
      problem: "tool",
      message: "A correction must use the same tool as the result it corrects.",
    };
  }
  if ((reason?.trim().length ?? 0) === 0) {
    return { ok: false, problem: "reason", message: "Say why the result is being corrected." };
  }
  return { ok: true };
}

/**
 * The current result for each tool: the latest that no later row supersedes. Superseded results
 * stay readable in the history. Sorted by tool key.
 */
export function currentResults<
  R extends {
    readonly id: string;
    readonly toolKey: string;
    readonly occurredAt: Date;
    readonly supersedesId: string | null;
  },
>(rows: readonly R[]): R[] {
  const superseded = new Set(rows.flatMap((r) => (r.supersedesId ? [r.supersedesId] : [])));
  const latest = new Map<string, R>();
  for (const row of rows) {
    if (superseded.has(row.id)) continue;
    const seen = latest.get(row.toolKey);
    if (!seen || row.occurredAt.getTime() > seen.occurredAt.getTime()) latest.set(row.toolKey, row);
  }
  return [...latest.values()].sort((a, b) => a.toolKey.localeCompare(b.toolKey));
}

/**
 * A result that changes the picture brings the care plan review forward (care.md rule 1, "and on
 * change"): a different band from the person's previous result for the same tool, or a fall.
 */
export function needsPlanReview(
  previous: Pick<AssessmentRecord, "toolKey" | "band"> | null,
  next: Pick<AssessmentRecord, "toolKey" | "band" | "triggers">,
): boolean {
  if (next.toolKey === "ng249_falls") {
    return next.triggers.some((t) => t.kind === "task" && t.task === "falls_review");
  }
  return previous !== null && previous.band !== next.band;
}
