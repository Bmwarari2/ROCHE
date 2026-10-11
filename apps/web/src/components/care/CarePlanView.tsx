import type { CarePlanDetail } from "@harbour/contracts";
import { CircleCheck } from "lucide-react";
import { PCSP_DOMAINS, roleLabel, signOffText } from "@/lib/care-plan";
import { formatDate, formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { PlanStatus } from "./PlanStatus";

function Field({ term, value }: { readonly term: string; readonly value: string | null }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-callout font-semibold">{term}</dt>
      <dd className="m-0 whitespace-pre-line">
        {value?.trim() ? (
          value
        ) : (
          <span className="text-text-secondary">{t("care.plan.section.notWritten")}</span>
        )}
      </dd>
    </div>
  );
}

/**
 * One version of the care and support plan, by need domain, with its status in word and icon at
 * the top (HZ-024), when it was published, when it is due for review and who agreed it.
 */
export function CarePlanView({
  plan,
  name,
  headingLevel = 3,
}: {
  readonly plan: CarePlanDetail;
  /** The person's preferred name, for "in Ada's words". */
  readonly name: string;
  readonly headingLevel?: 2 | 3;
}) {
  const sections = PCSP_DOMAINS.flatMap((domain) => {
    const section = plan.sections.find((s) => s.domain === domain);
    return section ? [section] : [];
  });
  const Heading = `h${headingLevel}` as const;
  const Sub = `h${headingLevel + 1}` as "h3" | "h4";
  return (
    <article className="flex flex-col gap-6" aria-labelledby={`plan-${plan.id}`}>
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <Heading id={`plan-${plan.id}`} className="m-0 text-intro font-semibold">
            {plan.publishedVersion
              ? t("care.plan.version", { version: plan.publishedVersion })
              : t("care.plan.draftName")}
          </Heading>
          <PlanStatus status={plan.status} />
        </div>
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-callout text-text-secondary">
          {plan.publishedAt ? (
            <li>{t("care.plan.published", { date: formatDateTime(plan.publishedAt) ?? "" })}</li>
          ) : null}
          {plan.reviewDueOn ? (
            <li>{t("care.plan.reviewDue", { date: formatDate(plan.reviewDueOn) ?? "" })}</li>
          ) : null}
          {plan.reviewReason ? (
            <li>{t("care.plan.reviewReason", { reason: plan.reviewReason })}</li>
          ) : null}
          <li>{signOffText(plan, name, t)}</li>
        </ul>
        {plan.summary ? (
          <div>
            <p className="m-0 text-callout font-semibold">{t("care.plan.summary")}</p>
            <p className="m-0 whitespace-pre-line">{plan.summary}</p>
          </div>
        ) : null}
      </header>
      {sections.length === 0 ? (
        <p className="m-0 text-text-secondary">{t("care.plan.noSections")}</p>
      ) : (
        sections.map((section) => (
          <section
            key={section.id}
            aria-labelledby={`section-${section.id}`}
            className="flex flex-col gap-3 border-t border-border pt-4"
          >
            <Sub id={`section-${section.id}`} className="m-0 text-body font-semibold">
              {t("care.plan.domain", { domain: section.domain })}
            </Sub>
            <dl className="m-0 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field term={t("care.plan.section.need")} value={section.need} />
              <Field term={t("care.plan.section.outcome", { name })} value={section.outcome} />
              <Field term={t("care.plan.section.strengths")} value={section.strengths} />
              <Field term={t("care.plan.section.contingency")} value={section.contingency} />
            </dl>
            <div className="flex flex-col gap-2">
              <p className="m-0 text-callout font-semibold">{t("care.plan.section.actions")}</p>
              {section.actions.length === 0 ? (
                <p className="m-0 text-text-secondary">{t("care.plan.section.noActions")}</p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {section.actions.map((action) => {
                    const role = roleLabel(action.roleKey, t);
                    return (
                      <li key={action.id} className="rounded-input border border-border px-4 py-2">
                        <p className="m-0 whitespace-pre-line">{action.action}</p>
                        <p className="m-0 flex flex-wrap gap-x-4 text-callout text-text-secondary">
                          {role ? <span>{t("care.plan.action.who", { role })}</span> : null}
                          {action.whenText ? (
                            <span>{t("care.plan.action.when", { when: action.whenText })}</span>
                          ) : null}
                          {action.evidenceRequired ? (
                            <span className="inline-flex items-center gap-1">
                              <CircleCheck size={14} strokeWidth={1.5} aria-hidden="true" />
                              {t("care.plan.action.evidence")}
                            </span>
                          ) : null}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>
        ))
      )}
    </article>
  );
}
