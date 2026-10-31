import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { QualityChip } from "@/components/quality/QualityChip";
import { ClearTargetButton, TargetForm } from "@/components/quality/TargetForms";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { getShellContext, tenantApi } from "@/lib/api";
import { t } from "@/lib/i18n";
import { readOrFail } from "@/lib/person-record";
import {
  BUILT_INDICATORS,
  dashboardShown,
  directionOf,
  endedMonths,
  valueKind,
} from "@/lib/quality-dashboard";
import { qualityDone } from "@/lib/quality-done";
import { ukToday } from "@/lib/uk-time";

export const metadata: Metadata = { title: t("quality.dashboard.targets.title") };

type Search = Promise<{ location?: string | string[]; done?: string | string[] }>;

/**
 * The organisation's own indicator targets (QUAL-005; quality.md section 22, rule 41): for each
 * indicator Harbour counts, the organisation default and this location's own target, each set or
 * cleared here. The API decides who may set which: a location's target where the reader holds
 * quality.audit.manage, never looser than the organisation's unless set organisation-wide.
 */
export default async function IndicatorTargetsPage({ searchParams }: { searchParams: Search }) {
  const { me, locationId: shellLocation } = await getShellContext();
  const title = t("quality.dashboard.targets.title");
  const hint = t("quality.dashboard.forbidden");
  if (!dashboardShown(me.permissions)) return <SafetyForbidden title={title} hint={hint} />;
  const params = await searchParams;
  const asked = typeof params.location === "string" ? params.location : null;
  const location =
    me.locations.find((l) => l.id === asked) ??
    me.locations.find((l) => l.id === shellLocation) ??
    me.locations[0];
  if (!location) return <SafetyForbidden title={title} hint={hint} />;
  const path = `/quality/dashboard/targets?location=${location.id}`;
  const api = await tenantApi();
  // Last month's view gives each indicator's direction and unit, and checks the place.
  const month = endedMonths(ukToday(), 1)[0];
  const [view, list] = await Promise.all([
    month
      ? api.GET("/v1/quality/dashboard", {
          params: { query: { locationId: location.id, from: month.first, to: month.last } },
        })
      : null,
    api.GET("/v1/quality/indicator-targets", { params: { query: { locationId: location.id } } }),
  ]);
  const dashboard = view ? readOrFail(view, path) : null;
  const targets = readOrFail(list, path);
  if (!dashboard || !targets) return <SafetyForbidden title={title} hint={hint} />;
  const done = qualityDone(params.done);
  const indicators = dashboard.indicators.filter((i) =>
    (BUILT_INDICATORS as readonly string[]).includes(i.key),
  );

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6 break-words">
      <PageHeader title={title} description={t("quality.dashboard.targets.description")} />
      {done ? <RecordedArrival message={t("quality.done", { done })} param="done" /> : null}
      <p className="m-0">
        <Link
          href={`/quality/dashboard?location=${location.id}`}
          className="inline-flex min-h-target items-center underline"
        >
          {t("quality.dashboard.targets.back")}
        </Link>
      </p>
      {indicators.map((indicator) => {
        const name = t("quality.dashboard.indicator.title", { key: indicator.key });
        const direction = directionOf(indicator);
        const organisation =
          targets.items.find((x) => x.indicatorKey === indicator.key && x.locationId === null) ??
          null;
        const own =
          targets.items.find(
            (x) => x.indicatorKey === indicator.key && x.locationId === location.id,
          ) ?? null;
        const shared = {
          indicatorKey: indicator.key,
          indicatorTitle: name,
          locationId: location.id,
          locationName: location.name,
          direction: indicator.direction,
          kind: valueKind(indicator),
          multiplier: indicator.multiplier,
          path,
        };
        const current = (target: typeof own) =>
          target ? (
            <p className="m-0">
              {t("quality.dashboard.targets.current", {
                green: target.green,
                amber: target.amber,
                direction,
              })}
            </p>
          ) : (
            <p className="m-0">
              <QualityChip
                chip={{
                  status: "neutral",
                  icon: "circle-minus",
                  label: t("quality.dashboard.targets.none"),
                }}
              />
            </p>
          );
        return (
          <Card key={indicator.key} as="section" title={name} headingLevel={2}>
            <div className="flex flex-col gap-6">
              <section
                aria-labelledby={`target-organisation-${indicator.key}`}
                className="flex flex-col gap-3"
              >
                <h3
                  id={`target-organisation-${indicator.key}`}
                  className="m-0 text-body font-semibold"
                >
                  {t("quality.dashboard.targets.organisation")}
                </h3>
                {current(organisation)}
                <TargetForm {...shared} level="organisation" current={organisation} />
                {organisation ? (
                  <ClearTargetButton
                    id={organisation.id}
                    version={organisation.version}
                    level="organisation"
                    indicatorTitle={name}
                    path={path}
                  />
                ) : null}
              </section>
              <section
                aria-labelledby={`target-location-${indicator.key}`}
                className="flex flex-col gap-3"
              >
                <h3 id={`target-location-${indicator.key}`} className="m-0 text-body font-semibold">
                  {t("quality.dashboard.targets.location", { location: location.name })}
                </h3>
                {current(own)}
                <TargetForm {...shared} level="location" current={own} />
                {own ? (
                  <ClearTargetButton
                    id={own.id}
                    version={own.version}
                    level="location"
                    indicatorTitle={name}
                    path={path}
                  />
                ) : null}
              </section>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
