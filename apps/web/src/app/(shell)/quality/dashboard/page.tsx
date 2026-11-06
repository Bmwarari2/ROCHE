import type { QualityIndicatorOut } from "@harbour/contracts";
import { Button, Card, PageHeader, SelectField } from "@harbour/ui";
import { CircleAlert, Info } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Notice } from "@/components/care/Notice";
import { QualityChip } from "@/components/quality/QualityChip";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { getShellContext, tenantApi } from "@/lib/api";
import { formatDate, formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { readOrFail } from "@/lib/person-record";
import {
  countWords,
  dashboardShown,
  directionOf,
  endedMonths,
  figureWords,
  monthLabel,
  ragChip,
  readPeriod,
} from "@/lib/quality-dashboard";
import { ukToday } from "@/lib/uk-time";

export const metadata: Metadata = { title: t("quality.dashboard.title") };

const linkClass = "inline-flex min-h-target items-center underline";

type Search = Promise<{
  location?: string | string[];
  from?: string | string[];
  to?: string | string[];
}>;

/**
 * The quality dashboard (QUAL-005; quality.md section 22; HZ-129): one location and whole ended
 * months, ten indicators, each with its figure, its working (numerator, denominator, period,
 * source and how it is worked out) and its status against the organisation's own target as an
 * icon and a word. "No data" is said with its reason and never rated; a withheld small count reads
 * as withheld, never as 0.
 */
export default async function QualityDashboardPage({ searchParams }: { searchParams: Search }) {
  const { me, locationId: shellLocation } = await getShellContext();
  const title = t("quality.dashboard.title");
  const hint = t("quality.dashboard.forbidden");
  if (!dashboardShown(me.permissions)) return <SafetyForbidden title={title} hint={hint} />;
  const params = await searchParams;
  const asked = typeof params.location === "string" ? params.location : null;
  const location =
    me.locations.find((l) => l.id === asked) ??
    me.locations.find((l) => l.id === shellLocation) ??
    me.locations[0];
  if (!location) return <SafetyForbidden title={title} hint={hint} />;
  const today = ukToday();
  const months = endedMonths(today);
  const period = readPeriod(params, today);
  const api = await tenantApi();
  const path = "/quality/dashboard";
  const dashboard = readOrFail(
    await api.GET("/v1/quality/dashboard", {
      params: { query: { locationId: location.id, from: period.from.first, to: period.to.last } },
    }),
    path,
  );
  if (!dashboard) return <SafetyForbidden title={title} hint={hint} />;
  const monthOptions = months.map((m) => ({ value: m.value, label: monthLabel(m.value, t) }));
  const chosen = (value: string) =>
    months.some((m) => m.value === value) ? value : period.from.value;
  const problem = period.problem
    ? t("quality.dashboard.picker.problem", { problem: period.problem })
    : null;
  const problemId = period.problemField === "to" ? "dashboard-to" : "dashboard-from";
  const targetsHref = `/quality/dashboard/targets?location=${location.id}`;

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6 break-words">
      <PageHeader title={title} description={t("quality.dashboard.description")} />

      <Card as="section" title={t("quality.dashboard.picker.title")} headingLevel={2}>
        <form method="get" action={path} className="flex flex-col gap-4">
          {problem ? (
            <div role="alert" className="flex flex-col gap-2">
              <Notice
                icon={<CircleAlert size={20} aria-hidden="true" />}
                title={t("quality.dashboard.picker.summary")}
                tone="warning"
              >
                <p className="m-0">
                  <a href={`#${problemId}`} className="underline">
                    {problem}
                  </a>
                </p>
                <p className="m-0">{t("quality.dashboard.picker.fallback")}</p>
              </Notice>
            </div>
          ) : null}
          <div className="flex flex-wrap items-end gap-4">
            <SelectField
              name="location"
              label={t("quality.dashboard.picker.location")}
              defaultValue={location.id}
              options={me.locations.map((l) => ({ value: l.id, label: l.name }))}
              className="w-full min-w-0 max-w-xs"
            />
          </div>
          <fieldset
            className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0"
            aria-describedby="dashboard-months-hint"
          >
            <legend className="mb-1 font-semibold">{t("quality.dashboard.picker.months")}</legend>
            <p id="dashboard-months-hint" className="m-0 text-body-dense text-text-secondary">
              {t("quality.dashboard.picker.hint")}
            </p>
            <div className="flex flex-wrap items-end gap-4">
              <SelectField
                id="dashboard-from"
                name="from"
                label={t("quality.dashboard.picker.from")}
                defaultValue={chosen(period.asked.from)}
                options={monthOptions}
                className="w-full min-w-0 max-w-xs"
                {...(period.problemField === "from" && problem ? { error: problem } : {})}
              />
              <SelectField
                id="dashboard-to"
                name="to"
                label={t("quality.dashboard.picker.to")}
                defaultValue={chosen(period.asked.to)}
                options={monthOptions}
                className="w-full min-w-0 max-w-xs"
                {...(period.problemField === "to" && problem ? { error: problem } : {})}
              />
            </div>
          </fieldset>
          <div>
            <Button type="submit" variant="secondary">
              {t("quality.dashboard.picker.show")}
            </Button>
          </div>
        </form>
      </Card>

      <section aria-labelledby="dashboard-indicators" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 id="dashboard-indicators" className="m-0 text-title font-semibold">
            {period.from.value === period.to.value
              ? t("quality.dashboard.showingOne", {
                  location: location.name,
                  month: monthLabel(period.from.value, t),
                })
              : t("quality.dashboard.showing", {
                  location: location.name,
                  from: monthLabel(period.from.value, t),
                  to: monthLabel(period.to.value, t),
                })}
          </h2>
          <p className="m-0 text-body-dense text-text-secondary">
            {t("quality.dashboard.counted", {
              when: formatDateTime(dashboard.generatedAt) ?? "",
            })}
          </p>
          <p className="m-0">
            <Link href={targetsHref} className={linkClass}>
              {t("quality.dashboard.setTargets", { location: location.name })}
            </Link>
          </p>
        </div>
        <Notice
          icon={<Info size={20} aria-hidden="true" />}
          title={t("quality.dashboard.indicators")}
        >
          <p className="m-0">{t("quality.dashboard.notBuiltNote")}</p>
        </Notice>
        <ul className="m-0 grid list-none grid-cols-1 gap-4 p-0 lg:grid-cols-2">
          {dashboard.indicators.map((indicator) => (
            <li key={indicator.key} className="flex">
              <IndicatorCard indicator={indicator} minGroupSize={dashboard.minGroupSize} />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function IndicatorCard({
  indicator,
  minGroupSize,
}: {
  readonly indicator: QualityIndicatorOut;
  readonly minGroupSize: number;
}) {
  const key = indicator.key;
  const built = indicator.source !== null;
  const direction = directionOf(indicator);
  const today = indicator.period.from === indicator.period.to;
  const periodWords = today
    ? t("quality.dashboard.periodToday", { date: formatDate(indicator.period.from) ?? "" })
    : t("quality.dashboard.period", {
        from: formatDate(indicator.period.from) ?? "",
        to: formatDate(indicator.period.to) ?? "",
      });
  const term = "font-semibold";
  return (
    <Card
      as="section"
      title={t("quality.dashboard.indicator.title", { key })}
      headingLevel={3}
      className="w-full"
    >
      <div className="flex flex-col gap-3">
        <p className="m-0 flex flex-wrap items-center gap-2">
          <QualityChip chip={ragChip(indicator.status, t)} />
        </p>
        {indicator.display !== null || indicator.reasonCode === "small_number" ? (
          <p className="m-0 text-title font-semibold">{figureWords(indicator, minGroupSize, t)}</p>
        ) : null}
        {indicator.reasonCode || indicator.status === "no_data" ? (
          <p className="m-0 max-w-prose">
            {t("quality.dashboard.reason", { code: indicator.reasonCode ?? "unknown" })}
          </p>
        ) : null}
        {built ? (
          <dl className="m-0 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
            <dt className={term}>{t("quality.dashboard.numerator", { key })}</dt>
            <dd className="m-0">{countWords(indicator.numerator, indicator, minGroupSize, t)}</dd>
            <dt className={term}>{t("quality.dashboard.denominator", { key })}</dt>
            <dd className="m-0">{countWords(indicator.denominator, indicator, minGroupSize, t)}</dd>
            <dt className={term}>{t("quality.dashboard.term.period")}</dt>
            <dd className="m-0">{periodWords}</dd>
            <dt className={term}>{t("quality.dashboard.term.source")}</dt>
            <dd className="m-0">{t("quality.dashboard.source", { key })}</dd>
            <dt className={term}>{t("quality.dashboard.term.method")}</dt>
            <dd className="m-0">
              {t("quality.dashboard.method", { key, multiplier: indicator.multiplier })}
            </dd>
            <dt className={term}>{t("quality.dashboard.term.target")}</dt>
            <dd className="m-0 flex flex-col gap-1">
              {indicator.target ? (
                <>
                  <span>
                    {t("quality.dashboard.target", {
                      level: indicator.target.level,
                      green: indicator.target.green,
                      amber: indicator.target.amber,
                      direction,
                    })}
                  </span>
                  {indicator.target.organisationDefault ? (
                    <span className="text-body-dense text-text-secondary">
                      {t("quality.dashboard.targetDefault", {
                        green: indicator.target.organisationDefault.green,
                        amber: indicator.target.organisationDefault.amber,
                        direction,
                      })}
                    </span>
                  ) : null}
                </>
              ) : (
                <span>{t("quality.dashboard.noTarget")}</span>
              )}
            </dd>
          </dl>
        ) : (
          <p className="m-0 text-body-dense text-text-secondary">
            {t("quality.dashboard.source", { key })}
          </p>
        )}
      </div>
    </Card>
  );
}
