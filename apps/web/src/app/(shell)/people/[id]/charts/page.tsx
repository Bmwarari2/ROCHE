import { Button, Card, DateInput, Meter, StatusChip, TabNav } from "@harbour/ui";
import { Copy } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ChartEntryForm } from "@/components/care/ChartEntryForm";
import { ChartSettingsForm } from "@/components/care/ChartSettingsForm";
import { NoAccess } from "@/components/care/NoAccess";
import { ObservationList } from "@/components/care/ObservationList";
import { ReadOnlyNotice } from "@/components/care/ReadOnlyNotice";
import { RecordFrame } from "@/components/care/RecordFrame";
import { WindowNote } from "@/components/care/WindowNote";
import { getShellContext, tenantApi } from "@/lib/api";
import {
  can,
  chartsNotice,
  mayEditCarePlan,
  readingWindow,
  recordCareAccess,
  tabHref,
  windowStart,
} from "@/lib/care-record";
import { CHARTS, type ChartKind, fluidDayView, isChart } from "@/lib/charts";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { personNames } from "@/lib/people";
import { getCareProfile, getEntryOutages, getPerson, readOrFail } from "@/lib/person-record";
import { type CareProfileLoad, profileOf } from "@/lib/record-data";
import { firstParam, recordMetadata } from "@/lib/record-metadata";
import { addDays, isDatePart, isIsoDate, readDateField, ukToday } from "@/lib/uk-time";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** The page title names the tab and the chart chosen, so changing chart is announced. */
export async function generateMetadata({
  searchParams,
}: {
  readonly searchParams: SearchParams;
}): Promise<Metadata> {
  const chart = firstParam((await searchParams).record);
  return recordMetadata(
    "charts",
    t("care.charts.kind", { chart: isChart(chart) ? chart : "fluid_intake" }),
  );
}

/**
 * The charts tab (care.md rule 6; register rows CARE-007 and CARE-010): the fluid balance day in
 * UK time with the target and shortfall the API worked out, a form for each chart, and the recent
 * entries of the chart chosen. Vital signs show the NEWS2 result and the RCP's response wording
 * as the API returns them (HZ-014); food and drink show the prescribed IDDSI level (HZ-016).
 */
async function ChartsTab({
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
  if (!can(me.permissions, "care.note.read")) return <NoAccess />;

  const query = await searchParams;
  const today = ukToday();
  // The day to show: from the day, month and year boxes when they were sent, else `?date=`.
  const typed = readDateField({ get: (name) => firstParam(query[name]) ?? null }, "date", {
    subject: t("care.date.subject.chartDay"),
    optional: true,
    t,
  });
  const typedDate = typed.ok ? typed.date : null;
  const requestedDate = typedDate ?? firstParam(query.date);
  const future = requestedDate !== undefined && isIsoDate(requestedDate) && requestedDate > today;
  const dateError = !typed.ok
    ? typed.message
    : future
      ? t("care.charts.fluid.futureDay")
      : undefined;
  const date =
    requestedDate && isIsoDate(requestedDate) && requestedDate <= today ? requestedDate : today;
  const recordParam = firstParam(query.record);
  const chart: ChartKind = isChart(recordParam) ? recordParam : "fluid_intake";
  const days = readingWindow(query.days);
  const path = tabHref(id, "charts");
  const here = (overrides: Record<string, string>) => {
    const next = new URLSearchParams({ date, record: chart, ...overrides });
    if (next.get("date") === today) next.delete("date");
    return `${path}?${next.toString()}`;
  };

  const api = await tenantApi();
  const [fluid, entries, profileLoad] = await Promise.all([
    api
      .GET("/v1/people/{id}/charts/fluid", { params: { path: { id }, query: { date } } })
      .then((r) => readOrFail(r, path)),
    api
      .GET("/v1/people/{id}/observations", {
        params: { path: { id }, query: { chart, from: windowStart(days) } },
      })
      .then((r) => readOrFail(r, path)),
    can(me.permissions, "care.plan.read")
      ? getCareProfile(id)
      : Promise.resolve<CareProfileLoad>({ kind: "no_access" }),
  ]);
  const profile = profileOf(profileLoad);
  if (!fluid || !entries) return <NoAccess />;
  const names = personNames(person);
  const fluidView = fluidDayView(fluid, t);
  const dateLabel = formatDate(fluid.date) ?? fluid.date;
  // The form only where the viewer's care.note.write reaches the person (review round 2, C2-M2).
  const { canRecord: canWrite } = recordCareAccess(person, me.permissions);
  const outages = canWrite ? await getEntryOutages(person.locationId) : [];
  const canSetUp = mayEditCarePlan(person, me.permissions) && profile !== null;
  // Why entries cannot be recorded, scoped to entries above chart settings the viewer can still
  // change, and why the settings are hidden when they cannot (review rounds 4 and 5).
  const notice = chartsNotice(person, me.permissions);

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-eyebrow">{t("care.charts.title")}</h2>
        <p className="m-0 text-text-secondary">
          {t("care.charts.description", { name: names.preferred })}
        </p>
      </div>

      <Card as="section" title={t("care.charts.fluid.title")} headingLevel={3}>
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-3">
            <Link
              className="hb-button hb-button--secondary"
              href={here({ date: addDays(date, -1) })}
            >
              <span className="hb-button__label">{t("care.charts.fluid.previousDay")}</span>
            </Link>
            {date < today ? (
              <Link
                className="hb-button hb-button--secondary"
                href={here({ date: addDays(date, 1) })}
              >
                <span className="hb-button__label">{t("care.charts.fluid.nextDay")}</span>
              </Link>
            ) : null}
            <form method="get" action={path} className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="record" value={chart} />
              <DateInput
                legend={t("care.charts.fluid.day")}
                name="date"
                defaultValue={date}
                labels={{
                  day: t("care.date.day"),
                  month: t("care.date.month"),
                  year: t("care.date.year"),
                }}
                {...(dateError ? { error: dateError } : {})}
                {...(!typed.ok ? { errorParts: typed.parts.filter(isDatePart) } : {})}
              />
              <Button type="submit" variant="secondary">
                {t("care.charts.fluid.show")}
              </Button>
            </form>
          </div>
          <Meter
            label={t("care.charts.fluid.meter", { date: dateLabel })}
            value={fluid.intakeMl}
            max={fluidView.meterMax}
            valueText={fluidView.valueText}
            description={
              <span className="flex flex-col gap-1">
                <span>
                  <StatusChip status={fluidView.status} label={fluidView.statusText} />
                </span>
                <span>{fluidView.outputText}</span>
                <span>{fluidView.entriesText}</span>
                {fluidView.flaggedText ? (
                  <span className="flex items-start gap-2 font-semibold" data-fluid-flagged="">
                    <Copy
                      size={18}
                      strokeWidth={1.5}
                      aria-hidden="true"
                      className="mt-0.5 shrink-0"
                    />
                    {fluidView.flaggedText}
                  </span>
                ) : null}
                {fluidView.refusedText ? (
                  <span data-fluid-refused="">{fluidView.refusedText}</span>
                ) : null}
              </span>
            }
          />
          <p className="m-0 text-body-dense text-text-secondary">{t("care.charts.fluid.ukDay")}</p>
        </div>
      </Card>

      <TabNav
        label={t("care.charts.record.label")}
        linkComponent={Link}
        currentAs="true"
        items={CHARTS.map((kind) => ({
          href: here({ record: kind }),
          label: t("care.charts.kind", { chart: kind }),
          current: kind === chart,
        }))}
      />

      {notice ? <ReadOnlyNotice text={t(notice)} /> : null}
      {canWrite ? (
        <Card as="section" title={t("care.charts.record.title", { chart })} headingLevel={3}>
          <ChartEntryForm
            personId={id}
            outages={outages}
            chart={chart}
            profile={profile}
            profileKind={profileLoad.kind}
            name={names.preferred}
          />
        </Card>
      ) : null}

      <section aria-labelledby="chart-entries" className="flex flex-col gap-3">
        <h3 id="chart-entries" className="m-0 text-body font-semibold">
          {t("care.charts.recent", { chart, days })}
        </h3>
        <WindowNote days={days} href={here({})} />
        {entries.items.length === 0 ? (
          <p className="m-0 text-text-secondary">{t("care.charts.recentEmpty", { days })}</p>
        ) : (
          <ObservationList
            items={entries.items}
            label={t("care.charts.recent", { chart, days })}
            tenantUserId={me.tenantUserId}
          />
        )}
      </section>

      {canSetUp && profile ? (
        <Card
          as="section"
          title={t("care.profile.title")}
          description={t("care.profile.description", { name: names.preferred })}
          headingLevel={3}
        >
          <ChartSettingsForm personId={id} profile={profile} />
        </Card>
      ) : null}
    </>
  );
}

/** The tab inside the record's frame: the point-of-care header, read again on every tab, and the tabs. */
export default async function ChartsPage(props: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id } = await props.params;
  return (
    <RecordFrame personId={id} tab="charts">
      <ChartsTab {...props} />
    </RecordFrame>
  );
}
