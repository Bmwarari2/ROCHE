import { Card, EmptyState, PageHeader } from "@harbour/ui";
import { CalendarDays } from "lucide-react";
import type { Metadata } from "next";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { MY_SHIFTS_PAGE, myShiftsShown, ukClock } from "@/lib/rota";

export const metadata: Metadata = { title: t("rota.mine.title") };

/** How far ahead "my shifts" looks, in days. */
const AHEAD_DAYS = 42;

const ukToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());

/** The member's own shifts on published rotas for the next six weeks, in UK time. */
export default async function MyShiftsPage() {
  const { me } = await getShellContext();
  const title = t("rota.mine.title");
  if (!myShiftsShown(me.permissions)) return <SafetyForbidden title={title} />;
  const from = ukToday();
  const end = new Date(`${from}T12:00:00Z`);
  end.setUTCDate(end.getUTCDate() + AHEAD_DAYS);
  const to = end.toISOString().slice(0, 10);
  const api = await tenantApi();
  const got = await api.GET("/v1/me/shifts", { params: { query: { from, to } } });
  if (!got.data) failWith(got.error, got.response, MY_SHIFTS_PAGE);
  const homes = new Map(me.locations.map((l) => [l.id, l.name]));
  const ukDate = (iso: string) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date(iso));

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={me.tenant.name}
        title={title}
        description={t("rota.mine.description", {
          from: formatDate(from) ?? from,
          to: formatDate(to) ?? to,
        })}
      />
      <Card as="section" title={t("rota.mine.list")} headingLevel={2}>
        {got.data.items.length === 0 ? (
          <EmptyState
            headingLevel={3}
            icon={<CalendarDays size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("rota.mine.empty")}
          />
        ) : (
          <ul className="hb-long-list m-0 flex list-none flex-col gap-3 p-0">
            {got.data.items.map((s) => (
              <li key={s.shiftId} className="flex flex-col gap-1 border-b border-border pb-3">
                <h3 className="m-0 text-body font-semibold">
                  {t("rota.mine.item", {
                    date: formatDate(ukDate(s.startsAt)) ?? "",
                    label: s.label,
                    start: ukClock(s.startsAt),
                    end: ukClock(s.endsAt),
                  })}
                </h3>
                <p className="m-0 text-body-dense">
                  {t("rota.mine.where", {
                    home: homes.get(s.locationId) ?? "",
                    known: homes.has(s.locationId) ? "yes" : "no",
                    kind: s.kind,
                  })}
                </p>
                {s.changedAfterPublishAt ? (
                  <p className="m-0 text-body-dense">{t("rota.shift.changedAfterPublish")}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
