import { Card, PageHeader, StatusChip } from "@harbour/ui";
import { CircleAlert, Route } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ArrivalNotice } from "@/components/care/ArrivalNotice";
import { Notice } from "@/components/care/Notice";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import {
  AutoRefresh,
  SessionActions,
  StartSessionForm,
} from "@/components/scheduling/LoneWorkerForms";
import { getShellContext, tenantApi } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { dueWords, locationName, loneWorkerAccess, ownChip } from "@/lib/lone-worker";

export const metadata: Metadata = { title: t("scheduling.loneWorker.title") };

/** How often the worker's page reads its session again, so "due" turns up without a reload. */
const REFRESH_SECONDS = 60;

/**
 * Lone working (SCHED-012, slice 61; scheduling.md section 15). The worker's own session: start
 * one, check in, ask for help, finish. Monitors and those who name the route are linked to the
 * board and the route. The page never shows or offers duress (H-1140).
 */
export default async function LoneWorkingPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ done?: string | string[] }>;
}) {
  const { done } = await searchParams;
  const arrived = done === "started" || done === "finished" ? done : null;
  const { me, locationId } = await getShellContext();
  const title = t("scheduling.loneWorker.title");
  const access = loneWorkerAccess(me.permissions);
  if (!access.checkIn && !access.monitor && !access.manage) {
    return <SafetyForbidden title={title} />;
  }
  const api = await tenantApi();
  const mine = access.checkIn ? await api.GET("/v1/lone-worker/sessions/mine") : null;
  // A worker whose session cannot be read is told what to do now, never shown a bare error.
  const unreadable = mine !== null && !mine.data;
  const session = mine?.data?.session ?? null;
  const on = mine?.data?.on ?? true;
  const now = new Date();
  const checkedAt = now.toISOString();

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={me.tenant.name}
        title={title}
        description={t("scheduling.loneWorker.description")}
      />
      {access.monitor || access.manage ? (
        <nav aria-label={t("scheduling.loneWorker.sections")}>
          <ul className="m-0 flex list-none flex-wrap gap-4 p-0">
            {access.monitor ? (
              <li>
                <Link
                  href="/lone-working/board"
                  className="inline-flex min-h-target items-center underline"
                >
                  {t("scheduling.loneWorker.board.title")}
                </Link>
              </li>
            ) : null}
            {access.manage ? (
              <li>
                <Link
                  href="/lone-working/route"
                  className="inline-flex min-h-target items-center underline"
                >
                  {t("scheduling.loneWorker.route.title")}
                </Link>
              </li>
            ) : null}
          </ul>
        </nav>
      ) : null}

      {access.checkIn ? (
        <Card as="section" aria-labelledby="my-session">
          <div className="flex flex-col gap-4">
            <h2 id="my-session" className="hb-card__title">
              {t("scheduling.loneWorker.mine.title")}
            </h2>
            {arrived ? (
              <ArrivalNotice>
                {t("scheduling.loneWorker.mine.arrived", { done: arrived })}
              </ArrivalNotice>
            ) : null}
            {unreadable ? (
              <Notice
                tone="warning"
                icon={<CircleAlert size={20} strokeWidth={1.5} aria-hidden="true" />}
                title={t("scheduling.loneWorker.mine.unreadableTitle")}
              >
                <p className="m-0">{t("scheduling.loneWorker.mine.unreadableBody")}</p>
              </Notice>
            ) : !on && !session ? (
              <Notice
                tone="warning"
                icon={<Route size={20} strokeWidth={1.5} aria-hidden="true" />}
                title={t("scheduling.loneWorker.off.title")}
              >
                <p className="m-0">{t("scheduling.loneWorker.off.body")}</p>
              </Notice>
            ) : session && session.status !== "finished" ? (
              <>
                <AutoRefresh
                  checkedAt={checkedAt}
                  intervalSeconds={REFRESH_SECONDS}
                  staleWords={t("scheduling.loneWorker.mine.staleBody")}
                  announcements={[
                    {
                      key: ownChip(session, now, t).label,
                      words: ownChip(session, now, t).label,
                      urgent: false,
                    },
                  ]}
                />
                <div className="flex flex-wrap items-center gap-3">
                  <StatusChip {...ownChip(session, now, t)} />
                  {dueWords(session.nextDueAt, now, t) ? (
                    <p className="m-0 font-semibold">{dueWords(session.nextDueAt, now, t)}</p>
                  ) : null}
                </div>
                {session.overdueAlarmOpen ? (
                  <Notice
                    tone="warning"
                    icon={<CircleAlert size={20} strokeWidth={1.5} aria-hidden="true" />}
                    title={t("scheduling.loneWorker.mine.overdueTitle")}
                  >
                    <p className="m-0">{t("scheduling.loneWorker.mine.overdueBody")}</p>
                  </Notice>
                ) : null}
                <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-[max-content_1fr]">
                  <dt className="font-semibold">{t("scheduling.loneWorker.mine.where")}</dt>
                  <dd className="m-0">{locationName(session.locationId, me.locations, t)}</dd>
                  <dt className="font-semibold">{t("scheduling.loneWorker.mine.kind")}</dt>
                  <dd className="m-0">
                    {t("scheduling.loneWorker.workKind", { kind: session.workKind })}
                  </dd>
                  <dt className="font-semibold">{t("scheduling.loneWorker.mine.started")}</dt>
                  <dd className="m-0">{formatDateTime(session.startedAt)}</dd>
                  <dt className="font-semibold">{t("scheduling.loneWorker.mine.plannedEnd")}</dt>
                  <dd className="m-0">{formatDateTime(session.plannedEndAt)}</dd>
                  <dt className="font-semibold">{t("scheduling.loneWorker.mine.interval")}</dt>
                  <dd className="m-0">
                    {t("scheduling.loneWorker.mine.everyMinutes", {
                      minutes: session.intervalMinutes,
                    })}
                  </dd>
                </dl>
                <SessionActions sessionId={session.id} />
                <section aria-labelledby="my-events" className="flex flex-col gap-2">
                  <h3 id="my-events" className="m-0 text-heading-sm">
                    {t("scheduling.loneWorker.mine.events")}
                  </h3>
                  {session.events.length === 0 ? (
                    <p className="m-0">{t("scheduling.loneWorker.mine.noEvents")}</p>
                  ) : (
                    <ul className="m-0 flex list-none flex-col gap-1 p-0">
                      {session.events.map((event) => (
                        <li key={event.id}>
                          {t("scheduling.loneWorker.mine.eventLine", {
                            kind: event.kind,
                            time: formatDateTime(event.deviceAt) ?? "",
                            late: event.late ? "yes" : "no",
                          })}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </>
            ) : (
              <>
                <p className="m-0">{t("scheduling.loneWorker.start.intro")}</p>
                <StartSessionForm
                  locations={me.locations}
                  defaultLocationId={
                    locationId ?? (me.locations.length === 1 ? (me.locations[0]?.id ?? null) : null)
                  }
                />
              </>
            )}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
