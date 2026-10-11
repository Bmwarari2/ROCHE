import { ButtonLink, Card, StatusChip } from "@harbour/ui";
import { History } from "lucide-react";
import type { Metadata } from "next";
import { AssessmentForm } from "@/components/care/AssessmentForm";
import { AssessmentResult } from "@/components/care/AssessmentResult";
import { NoAccess } from "@/components/care/NoAccess";
import { getShellContext, tenantApi } from "@/lib/api";
import { availableTools, bandChip, bandLabel, isToolKey, TOOL_KEYS } from "@/lib/assessments";
import { can, tabHref } from "@/lib/care-record";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { personNames } from "@/lib/people";
import { getPerson, readOrFail } from "@/lib/person-record";
import { firstParam, recordMetadata } from "@/lib/record-metadata";
import { ukDateTimeInput } from "@/lib/uk-time";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** The page title names the tab, and the tool when one is being run, never the person. */
export async function generateMetadata({
  searchParams,
}: {
  readonly searchParams: SearchParams;
}): Promise<Metadata> {
  const tool = firstParam((await searchParams).run);
  return recordMetadata(
    "assessments",
    isToolKey(tool) ? t("care.assessments.form.title", { tool }) : undefined,
  );
}

/**
 * The assessments tab (care.md rule 5; register rows CARE-003 and CARE-006): run MUST or the NICE
 * NG249 falls questions, and Waterlow or Braden when the organisation has them switched on. The
 * current result of each tool and every result are shown as the API calculated them.
 */
export default async function AssessmentsPage({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id } = await params;
  const { person } = await getPerson(id);
  if (!person) return null;
  const { me } = await getShellContext();
  if (!can(me.permissions, "care.plan.read")) return <NoAccess />;
  const path = tabHref(id, "assessments");
  const api = await tenantApi();
  const [latest, all] = await Promise.all([
    api
      .GET("/v1/people/{id}/assessments", { params: { path: { id }, query: { latest: "true" } } })
      .then((r) => readOrFail(r, path)),
    api
      .GET("/v1/people/{id}/assessments", { params: { path: { id }, query: { latest: "false" } } })
      .then((r) => readOrFail(r, path)),
  ]);
  if (!latest || !all) return <NoAccess />;
  const names = personNames(person);
  const tools = availableTools(me.flags);
  const runParam = (await searchParams).run;
  const run = typeof runParam === "string" && isToolKey(runParam) ? runParam : null;
  const canRun = can(me.permissions, "care.assessment.write");
  const offTools = TOOL_KEYS.filter((tool) => !tools.includes(tool));

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-eyebrow">{t("care.assessments.title")}</h2>
        <p className="m-0 max-w-prose text-text-secondary">{t("care.assessments.description")}</p>
      </div>

      {canRun ? (
        <div className="flex flex-wrap gap-2">
          {tools.map((tool) => (
            <ButtonLink
              key={tool}
              href={`${path}?run=${tool}`}
              variant={run === tool ? "primary" : "secondary"}
              aria-current={run === tool ? "page" : undefined}
            >
              {t("care.assessments.run", { tool })}
            </ButtonLink>
          ))}
        </div>
      ) : null}
      {offTools.map((tool) => (
        <p key={tool} className="m-0 text-callout text-text-secondary">
          {t("care.assessments.disabled", { tool })}
        </p>
      ))}

      {canRun && run && tools.includes(run) ? (
        <Card as="section" title={t("care.assessments.form.title", { tool: run })} headingLevel={3}>
          <AssessmentForm
            personId={id}
            tool={run}
            nowLocal={ukDateTimeInput()}
            name={names.preferred}
          />
        </Card>
      ) : null}

      <section aria-labelledby="current-results" className="flex flex-col gap-3">
        <h3 id="current-results" className="m-0 text-body font-semibold">
          {t("care.assessments.current.title")}
        </h3>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {TOOL_KEYS.filter(
            (tool) => tools.includes(tool) || latest.items.some((i) => i.toolKey === tool),
          ).map((tool) => {
            const item = latest.items.find((i) => i.toolKey === tool);
            return (
              <Card key={tool}>
                {item ? (
                  <AssessmentResult item={item} headingLevel={4} />
                ) : (
                  <div className="flex flex-col gap-2">
                    <h4 className="m-0 text-body font-semibold">
                      {t("care.assessments.toolFull", { tool })}
                    </h4>
                    <p className="m-0 text-text-secondary">{t("care.assessments.current.none")}</p>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="all-results" className="flex flex-col gap-3">
        <h3 id="all-results" className="m-0 text-body font-semibold">
          {t("care.assessments.history.title")}
        </h3>
        {all.items.length === 0 ? (
          <p className="m-0 text-text-secondary">{t("care.assessments.history.empty")}</p>
        ) : (
          <ol
            aria-labelledby="all-results"
            className="hb-long-list m-0 flex list-none flex-col gap-2 p-0"
          >
            {all.items.map((item) => {
              const band = bandLabel(item, t);
              const line = [
                t("care.assessments.tool", { tool: item.toolKey }),
                item.score === null ? null : t("care.assessments.score", { score: item.score }),
                band,
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <li
                  key={item.id}
                  className="flex flex-wrap items-center gap-3 rounded-input border border-border px-4 py-2"
                >
                  <time dateTime={item.occurredAt} className="tabular-nums text-text-secondary">
                    {formatDateTime(item.occurredAt)}
                  </time>
                  {item.superseded ? (
                    <>
                      <del className="text-text-secondary">{line}</del>
                      <StatusChip
                        status="notApplicable"
                        label={t("care.assessments.superseded")}
                        icon={History}
                      />
                    </>
                  ) : (
                    <>
                      <span className="font-semibold">
                        {t("care.assessments.tool", { tool: item.toolKey })}
                      </span>
                      {item.score === null ? null : (
                        <span>{t("care.assessments.score", { score: item.score })}</span>
                      )}
                      {band ? <StatusChip status={bandChip(item)} label={band} /> : null}
                    </>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </>
  );
}
