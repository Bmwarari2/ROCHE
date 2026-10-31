import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  AddShiftForm,
  ApplyPatternForm,
  AssignShift,
  CancelShiftButton,
  RemoveAssignmentButton,
} from "@/components/rota/RotaForms";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { firstParam } from "@/lib/record-metadata";
import {
  mayCheck,
  mayManageRota,
  mayOverride,
  rotaCheckPage,
  rotaChip,
  rotaHomePage,
  rotaPage,
  rotaShown,
  shiftChip,
  shiftsByDate,
  ukClock,
} from "@/lib/rota";

export const metadata: Metadata = { title: t("rota.builder.title") };

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const DONE = new Set([
  "started",
  "shiftAdded",
  "patternApplied",
  "shiftCancelled",
  "assigned",
  "overridden",
  "removed",
  "published",
]);

/** Every UK date from `from` to `to`, inclusive. */
function datesOf(from: string, to: string): string[] {
  const out: string[] = [];
  for (
    let d = new Date(`${from}T12:00:00Z`);
    d.toISOString().slice(0, 10) <= to;
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * The rota builder (SCHED-002; HZ-124): the rota's shifts by day, each open or with who is on it
 * as an icon and a word, and an override shown as one. A rota manager adds shifts from templates
 * or a pattern, puts members on open shifts through the rostering rule (with a manager's
 * justified override where allowed), takes them off or cancels a shift with a reason, then checks
 * the rota before publishing it.
 */
export default async function RotaBuilderPage({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { me } = await getShellContext();
  const title = t("rota.builder.title");
  if (!rotaShown(me.permissions)) return <SafetyForbidden title={title} />;
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const api = await tenantApi();
  const got = await api.GET("/v1/rotas/{id}", { params: { path: { id } } });
  if (got.response.status === 404) notFound();
  if (!got.data) failWith(got.error, got.response, rotaPage(id));
  const rota = got.data;
  const manage = mayManageRota(me.permissions);
  const home = me.locations.find((l) => l.id === rota.locationId);
  const [templates, patterns, workers] = manage
    ? await Promise.all([
        api.GET("/v1/locations/{id}/shift-templates", {
          params: { path: { id: rota.locationId } },
        }),
        api.GET("/v1/locations/{id}/shift-patterns", { params: { path: { id: rota.locationId } } }),
        api.GET("/v1/locations/{id}/rota-workers", { params: { path: { id: rota.locationId } } }),
      ])
    : [null, null, null];
  const done = firstParam((await searchParams).done);
  const days = shiftsByDate(rota.shifts);
  const dateOptions = datesOf(rota.startsOn, rota.endsOn).map((d) => ({
    value: d,
    label: formatDate(d) ?? d,
  }));
  const open = rota.shifts.filter((s) => !s.assignment).length;

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={home?.name ?? me.tenant.name}
        title={title}
        description={t("rota.builder.description", {
          from: formatDate(rota.startsOn) ?? rota.startsOn,
          to: formatDate(rota.endsOn) ?? rota.endsOn,
          shifts: rota.shifts.length,
          open,
        })}
      />
      {done && DONE.has(done) ? (
        <RecordedArrival message={t("rota.done", { done })} param="done" />
      ) : null}
      <p className="m-0 flex flex-wrap items-center gap-3">
        <SafetyChip chip={rotaChip(rota, t)} />
        <Link
          href={rotaHomePage(rota.locationId)}
          className="inline-flex min-h-target items-center underline"
        >
          {t("rota.backToRotas")}
        </Link>
        {mayCheck(me.permissions) ? (
          <Link
            href={rotaCheckPage(rota.id)}
            className="inline-flex min-h-target items-center underline"
          >
            {rota.state === "published" && !rota.changedSincePublished
              ? t("rota.builder.checkAgain")
              : t("rota.builder.checkAndPublish")}
          </Link>
        ) : null}
      </p>
      {rota.changedSincePublished ? (
        <p className="m-0">{t("rota.builder.changedSincePublished")}</p>
      ) : null}
      {manage && templates?.data && patterns?.data ? (
        <Card as="section" title={t("rota.builder.addTitle")} headingLevel={2}>
          <div className="flex flex-col gap-6">
            {templates.data.items.length > 0 ? (
              <AddShiftForm rotaId={rota.id} dates={dateOptions} templates={templates.data.items} />
            ) : (
              <p className="m-0">{t("rota.builder.noTemplates")}</p>
            )}
            {patterns.data.items.length > 0 ? (
              <ApplyPatternForm
                rotaId={rota.id}
                version={rota.version}
                patterns={patterns.data.items}
              />
            ) : null}
          </div>
        </Card>
      ) : null}
      <Card as="section" title={t("rota.builder.shifts")} headingLevel={2}>
        {days.length === 0 ? (
          <p className="m-0">{t("rota.builder.noShifts")}</p>
        ) : (
          <ol className="hb-long-list m-0 flex list-none flex-col gap-6 p-0">
            {days.map((day) => (
              <li key={day.date} className="flex flex-col gap-3">
                <h3 className="m-0 text-body font-semibold">{formatDate(day.date) ?? day.date}</h3>
                <ul className="m-0 flex list-none flex-col gap-3 p-0">
                  {day.shifts.map((shift) => (
                    <li key={shift.id} className="flex flex-col gap-2 border-b border-border pb-3">
                      <h4 className="m-0 text-body font-semibold">
                        {t("rota.shift.heading", {
                          label: shift.label,
                          start: ukClock(shift.startsAt),
                          end: ukClock(shift.endsAt),
                        })}
                      </h4>
                      <p className="m-0 flex flex-wrap items-center gap-2">
                        <SafetyChip chip={shiftChip(shift, t)} />
                        <span>{t("rota.kind", { kind: shift.kind })}</span>
                        {shift.assignment ? (
                          <span>
                            {t("rota.shift.who", { name: shift.assignment.worker.displayName })}
                          </span>
                        ) : null}
                      </p>
                      {shift.changedAfterPublishAt ? (
                        <p className="m-0 text-body-dense">{t("rota.shift.changedAfterPublish")}</p>
                      ) : null}
                      {manage ? (
                        <div className="flex flex-col gap-3">
                          {!shift.assignment && workers?.data ? (
                            <AssignShift
                              shift={shift}
                              workers={workers.data.items}
                              canOverride={mayOverride(me.permissions)}
                            />
                          ) : null}
                          <div className="flex flex-wrap gap-2">
                            {shift.assignment ? <RemoveAssignmentButton shift={shift} /> : null}
                            <CancelShiftButton shift={shift} />
                          </div>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}
