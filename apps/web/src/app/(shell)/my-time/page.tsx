import { Card, EmptyState, PageHeader } from "@harbour/ui";
import { CalendarClock } from "lucide-react";
import type { Metadata } from "next";
import { ClockButtons } from "@/components/pay-time/PayTimeForms";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { hoursAndMinutes, myTimeShown, timesheetChip } from "@/lib/pay-time";
import { addDays, ukToday } from "@/lib/uk-time";

export const metadata: Metadata = { title: t("payTime.myTime.title") };

/**
 * My clock and timesheet (Phase 2 slice 60; SCHED-004; scheduling.md section 16): clocking in,
 * out and for breaks on today's shifts, and my timesheet entries for the last fortnight with where
 * each stands, in an icon and a word. A corrected entry is struck through and never counts.
 */
export default async function MyTimePage() {
  const { me } = await getShellContext();
  const title = t("payTime.myTime.title");
  if (!myTimeShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const today = ukToday();
  const [shifts, sheets] = await Promise.all([
    api.GET("/v1/me/shifts", {
      params: { query: { from: addDays(today, -1), to: addDays(today, 1) } },
    }),
    api.GET("/v1/me/timesheets", { params: { query: { from: addDays(today, -13), to: today } } }),
  ]);
  for (const r of [shifts, sheets]) {
    if (!r.data) {
      if (problemCode(r.error) === "missing_permission") return <SafetyForbidden title={title} />;
      return failWith(r.error, r.response, "/my-time");
    }
  }
  const myShifts = shifts.data?.items ?? [];
  const entries = sheets.data?.items ?? [];
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader title={title} description={t("payTime.myTime.description")} />
      <section aria-labelledby="my-shifts" className="flex flex-col gap-3">
        <h2 id="my-shifts" className="m-0 text-heading-3">
          {t("payTime.myTime.shifts")}
        </h2>
        {myShifts.length === 0 ? (
          <Card>
            <EmptyState
              headingLevel={3}
              icon={<CalendarClock size={32} strokeWidth={1.5} aria-hidden="true" />}
              title={t("payTime.myTime.noShifts")}
            />
          </Card>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {myShifts.map((s) => (
              <li key={s.shiftId}>
                <Card as="article" headingLevel={3} title={s.label}>
                  <div className="flex flex-col gap-3">
                    <p className="m-0 text-body-dense text-text-secondary">
                      {t("payTime.myTime.shiftTimes", {
                        from: formatDateTime(s.startsAt) ?? "",
                        to: formatDateTime(s.endsAt) ?? "",
                      })}
                    </p>
                    <ClockButtons shiftId={s.shiftId} locationId={s.locationId} />
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="my-entries" className="flex flex-col gap-3">
        <h2 id="my-entries" className="m-0 text-heading-3">
          {t("payTime.myTime.entries")}
        </h2>
        {entries.length === 0 ? (
          <p className="m-0 text-text-secondary">{t("payTime.myTime.noEntries")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {entries.map((e) => (
              <li key={e.id}>
                <Card as="article" headingLevel={3} title={formatDateTime(e.startedAt) ?? ""}>
                  <div className="flex flex-col gap-2">
                    <p className="m-0 flex flex-wrap items-center gap-2">
                      <SafetyChip chip={timesheetChip(e, t)} />
                    </p>
                    {e.superseded ? (
                      <p className="m-0 text-body-dense">
                        <s>
                          {t("payTime.entry.span", {
                            from: formatDateTime(e.startedAt) ?? "",
                            to: formatDateTime(e.endedAt) ?? "",
                          })}
                        </s>
                      </p>
                    ) : (
                      <p className="m-0 text-body-dense">
                        {t("payTime.entry.span", {
                          from: formatDateTime(e.startedAt) ?? "",
                          to: formatDateTime(e.endedAt) ?? "",
                        })}
                      </p>
                    )}
                    <p className="m-0 text-body-dense text-text-secondary">
                      {t("payTime.entry.worked", { time: hoursAndMinutes(e.workedMinutes, t) })}
                    </p>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
