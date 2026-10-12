/**
 * Read-only views of the care plan, risk assessments and validated-tool results (care.md section
 * 6: read only on the phone in Phase 1). Only the active plan and active risk assessments reach the
 * device, so a draft or superseded version is never shown as the one to follow (HZ-024). Review
 * dates that have passed are said in words, not colour.
 */
import { PCSP_DOMAINS } from "@harbour/domain";
import { t } from "../i18n/t";
import { currentEntries } from "./entries";
import type { AssessmentRow, CarePlanRow, PlanActionRow, PlanSectionRow, RiskRow } from "./queries";
import { formatIsoDate, parseInstant, ukDateTimeParts } from "./time";

export interface ReviewLine {
  readonly text: string;
  readonly overdue: boolean;
}

/** "Review due 01/01/2027", or "Review overdue since ..." once the date has passed (UK date). */
export function reviewLine(
  dueOn: string | null,
  today: string,
  keys: {
    readonly due: "mobile.carePlan.review" | "mobile.risks.review" | "mobile.risks.nextDue";
    readonly overdue:
      | "mobile.carePlan.reviewOverdue"
      | "mobile.risks.reviewOverdue"
      | "mobile.risks.nextDueOverdue";
  },
): ReviewLine | null {
  const date = formatIsoDate(dueOn);
  if (!dueOn || !date) return null;
  const overdue = dueOn.slice(0, 10) < today;
  return { text: t(overdue ? keys.overdue : keys.due, { date }), overdue };
}

export interface PlanActionView {
  readonly id: string;
  readonly action: string;
  readonly who: string | null;
  readonly when: string;
}

export interface PlanSectionView {
  readonly id: string;
  readonly title: string;
  readonly need: string | null;
  readonly outcome: string | null;
  readonly strengths: string | null;
  readonly contingency: string | null;
  readonly actions: readonly PlanActionView[];
}

export interface CarePlanView {
  readonly version: string | null;
  readonly summary: string | null;
  readonly review: ReviewLine | null;
  readonly sections: readonly PlanSectionView[];
}

const domainOrder = (domain: string | null) => {
  const index = (PCSP_DOMAINS as readonly string[]).indexOf(domain ?? "");
  return index === -1 ? PCSP_DOMAINS.length : index;
};

export function carePlanView(
  plan: CarePlanRow,
  sections: readonly PlanSectionRow[],
  actions: readonly PlanActionRow[],
  today: string,
): CarePlanView {
  const published = parseInstant(plan.published_at);
  const version =
    plan.published_version !== null && published
      ? t("mobile.carePlan.version", {
          version: plan.published_version,
          date: ukDateTimeParts(published).date,
        })
      : null;
  return {
    version,
    summary: plan.summary,
    review: reviewLine(plan.review_due_on, today, {
      due: "mobile.carePlan.review",
      overdue: "mobile.carePlan.reviewOverdue",
    }),
    sections: [...sections]
      .sort((a, b) => domainOrder(a.domain) - domainOrder(b.domain))
      // A section with nothing written yet adds nothing at the point of care.
      .filter(
        (s) =>
          s.need ||
          s.outcome ||
          s.strengths ||
          s.contingency ||
          actions.some((a) => a.section_id === s.id),
      )
      .map((s) => ({
        id: s.id,
        title: t("mobile.carePlan.domainName", { domain: s.domain ?? "other" }),
        need: s.need,
        outcome: s.outcome,
        strengths: s.strengths,
        contingency: s.contingency,
        actions: actions
          .filter((a) => a.section_id === s.id && a.action)
          .map((a) => ({
            id: a.id,
            action: a.action ?? "",
            who: a.role_key ? t("mobile.carePlan.actionWho", { role: a.role_key }) : null,
            when: t("mobile.carePlan.actionWhen", {
              when: a.when_text ?? t("mobile.carePlan.asNeeded"),
            }),
          })),
      })),
  };
}

export interface RiskView {
  readonly id: string;
  readonly hazard: string;
  readonly whoAtRisk: string | null;
  readonly rating: string;
  readonly residual: string | null;
  readonly controls: readonly string[];
  readonly positive: string | null;
  readonly personViews: string | null;
  readonly review: ReviewLine | null;
}

function textList(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [value];
  }
}

export function riskView(row: RiskRow, today: string): RiskView {
  const rated = row.risk_rating !== null && row.risk_band !== null;
  return {
    id: row.id,
    hazard: row.hazard ?? row.template_key ?? "",
    whoAtRisk: row.who_at_risk ? t("mobile.risks.whoAtRisk", { who: row.who_at_risk }) : null,
    // Falls are never rated (NG249); an unrated assessment says so rather than showing a blank.
    rating: rated
      ? t("mobile.risks.rating", {
          band: t("mobile.risks.band", { band: row.risk_band ?? "none" }),
          rating: row.risk_rating ?? 0,
        })
      : t("mobile.risks.notRated"),
    residual:
      row.residual_rating !== null && row.residual_band !== null
        ? t("mobile.risks.residual", {
            band: t("mobile.risks.band", { band: row.residual_band }),
            rating: row.residual_rating,
          })
        : null,
    controls: textList(row.controls),
    positive: row.positive_risk_statement,
    personViews: row.person_views,
    review: reviewLine(row.review_due_on, today, {
      due: "mobile.risks.review",
      overdue: "mobile.risks.reviewOverdue",
    }),
  };
}

export interface AssessmentView {
  readonly id: string;
  readonly tool: string;
  readonly result: string;
  readonly nextDue: ReviewLine | null;
}

/** The latest result per tool, leaving out results a correction superseded. */
export function latestAssessments(rows: readonly AssessmentRow[], today: string): AssessmentView[] {
  const latest = new Map<string, AssessmentRow>();
  const current = currentEntries(rows.map((r) => ({ ...r, supersedes_id: r.supersedes_id })));
  for (const row of current) {
    if (!row.tool_key) continue;
    const seen = latest.get(row.tool_key);
    if (!seen || (row.occurred_at ?? "") > (seen.occurred_at ?? "")) latest.set(row.tool_key, row);
  }
  return [...latest.values()]
    .sort((a, b) => (a.tool_key ?? "").localeCompare(b.tool_key ?? ""))
    .map((row) => {
      const at = parseInstant(row.occurred_at);
      const date = at ? ukDateTimeParts(at).date : "";
      return {
        id: row.id,
        tool: t("mobile.risks.tool", { tool: row.tool_key ?? "other" }),
        result:
          row.score === null
            ? t("mobile.risks.resultNoScore", { date })
            : t("mobile.risks.result", {
                band: t("mobile.risks.assessmentBand", { band: row.band ?? "other" }),
                score: row.score,
                date,
              }),
        nextDue: reviewLine(row.next_due_on, today, {
          due: "mobile.risks.nextDue",
          overdue: "mobile.risks.nextDueOverdue",
        }),
      };
    });
}
