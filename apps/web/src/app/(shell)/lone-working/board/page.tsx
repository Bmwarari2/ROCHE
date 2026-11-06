import type { LoneWorkerAlarmItem } from "@harbour/contracts";
import { Card, EmptyState, PageHeader, StatusChip } from "@harbour/ui";
import { CircleAlert, ShieldCheck, Siren } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ArrivalNotice } from "@/components/care/ArrivalNotice";
import { Notice } from "@/components/care/Notice";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { AcknowledgeForm, AutoRefresh } from "@/components/scheduling/LoneWorkerForms";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import {
  alarmChip,
  alarmsInOrder,
  locationName,
  loneWorkerAccess,
  sessionChip,
  sessionsInOrder,
  urgentAlarm,
  workerName,
  worstOpenAlarm,
} from "@/lib/lone-worker";

export const metadata: Metadata = { title: t("scheduling.loneWorker.board.title") };

/** The board reads again every 30 seconds while it is on screen and nobody is typing in it. */
const REFRESH_SECONDS = 30;

/**
 * The lone-worker monitor board (scheduling.md section 15.8a; HZ-125). Open alarms come first,
 * duress first, then help, an overdue check-in and a session not finished, each with the worker's
 * name to contact and the acknowledge form. Then every open session but the viewer's own, those
 * with an alarm first. Status is an icon and words, never colour alone. After an acknowledgement
 * the board says what was acknowledged, and suggests an incident report for anything but safe
 * confirmed, above the alarms (the alarm itself has closed and left the list).
 */
export default async function LoneWorkerBoardPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ acknowledged?: string | string[] }>;
}) {
  const { acknowledged } = await searchParams;
  const { me } = await getShellContext();
  const title = t("scheduling.loneWorker.board.title");
  if (!loneWorkerAccess(me.permissions).monitor) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const ackId = typeof acknowledged === "string" && isUuid(acknowledged) ? acknowledged : null;
  const [board, alarms, closed] = await Promise.all([
    api.GET("/v1/lone-worker/board"),
    api.GET("/v1/lone-worker/alarms"),
    ackId
      ? api.GET("/v1/lone-worker/alarms", { params: { query: { state: "acknowledged" } } })
      : null,
  ]);
  if (!board.data) failWith(board.error, board.response);
  if (!alarms.data) failWith(alarms.error, alarms.response);
  const done: LoneWorkerAlarmItem | undefined = closed?.data?.items.find((a) => a.id === ackId);
  const openAlarms = alarmsInOrder(alarms.data.items).filter((a) => a.state === "open");
  const worst = worstOpenAlarm(openAlarms);
  const sessions = sessionsInOrder(board.data.items, openAlarms);
  const canReport = me.permissions.includes("safety.incident.report");
  const checkedAt = new Date().toISOString();
  const heading = (alarm: LoneWorkerAlarmItem) =>
    t("scheduling.loneWorker.board.alarmHeading", {
      name: workerName(alarm, t),
      reason: alarm.reasonWords,
    });

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={me.tenant.name}
        title={title}
        description={t("scheduling.loneWorker.board.description")}
      />
      <p className="m-0">
        <Link href="/lone-working" className="inline-flex min-h-target items-center underline">
          {t("scheduling.loneWorker.backToLoneWorking")}
        </Link>
      </p>
      {done ? (
        <div className="flex flex-col gap-2">
          <ArrivalNotice>
            {t("scheduling.loneWorker.ack.arrived", {
              name: workerName(done, t),
              outcome: done.outcome ?? "other",
            })}
          </ArrivalNotice>
          {done.outcome !== "safe_confirmed" ? (
            <p className="m-0">
              {t("scheduling.loneWorker.ack.incidentSuggested")}{" "}
              {canReport ? (
                <Link
                  href="/incidents/new"
                  className="inline-flex min-h-target items-center underline"
                >
                  {t("scheduling.loneWorker.ack.reportIncident")}
                </Link>
              ) : (
                t("scheduling.loneWorker.ack.tellSomeone")
              )}
            </p>
          ) : null}
        </div>
      ) : null}
      <AutoRefresh
        checkedAt={checkedAt}
        intervalSeconds={REFRESH_SECONDS}
        staleWords={t("scheduling.loneWorker.board.staleBody")}
        titleCount={openAlarms.length}
        announcements={openAlarms.map((alarm) => ({
          key: alarm.id,
          words: t("scheduling.loneWorker.board.newAlarm", { heading: heading(alarm) }),
          urgent: urgentAlarm(alarm),
        }))}
      />
      {!board.data.on ? (
        <Notice
          tone="warning"
          icon={<CircleAlert size={20} strokeWidth={1.5} aria-hidden="true" />}
          title={t("scheduling.loneWorker.off.title")}
        >
          <p className="m-0">{t("scheduling.loneWorker.off.monitorBody")}</p>
        </Notice>
      ) : null}

      <section aria-labelledby="alarms" className="flex flex-col gap-4">
        <h2 id="alarms" tabIndex={-1} className="m-0 text-heading-md">
          {t("scheduling.loneWorker.board.alarms", { count: openAlarms.length })}
        </h2>
        {openAlarms.length === 0 ? (
          <Card>
            <EmptyState
              headingLevel={3}
              icon={<ShieldCheck size={32} strokeWidth={1.5} aria-hidden="true" />}
              title={t("scheduling.loneWorker.board.noAlarms")}
            />
          </Card>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-4 p-0">
            {openAlarms.map((alarm) => (
              <li key={alarm.id}>
                <Card as="article" aria-labelledby={`alarm-${alarm.id}`}>
                  <div className="flex flex-col gap-3 break-words">
                    <h3 id={`alarm-${alarm.id}`} className="m-0 text-heading-sm">
                      {heading(alarm)}
                    </h3>
                    <div>
                      <StatusChip
                        {...alarmChip(alarm)}
                        {...(urgentAlarm(alarm) ? { icon: Siren } : {})}
                      />
                    </div>
                    {urgentAlarm(alarm) ? (
                      <p className="m-0 font-semibold">
                        {t("scheduling.loneWorker.board.urgent", { reason: alarm.reason })}
                      </p>
                    ) : null}
                    <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-[max-content_1fr]">
                      <dt className="font-semibold">{t("scheduling.loneWorker.board.where")}</dt>
                      <dd className="m-0">{locationName(alarm.locationId, me.locations, t)}</dd>
                      <dt className="font-semibold">{t("scheduling.loneWorker.board.raised")}</dt>
                      <dd className="m-0">{formatDateTime(alarm.raisedAt)}</dd>
                      {alarm.dueAt ? (
                        <>
                          <dt className="font-semibold">{t("scheduling.loneWorker.board.due")}</dt>
                          <dd className="m-0">{formatDateTime(alarm.dueAt)}</dd>
                        </>
                      ) : null}
                      <dt className="font-semibold">
                        {t("scheduling.loneWorker.board.lastCheckIn")}
                      </dt>
                      <dd className="m-0">
                        {alarm.lastCheckInAt
                          ? t("scheduling.loneWorker.board.lastCheckInAt", {
                              time: formatDateTime(alarm.lastCheckInAt) ?? "",
                              late: alarm.lastCheckInLate ? "yes" : "no",
                            })
                          : t("scheduling.loneWorker.board.noCheckIn")}
                      </dd>
                      <dt className="font-semibold">{t("scheduling.loneWorker.board.sent")}</dt>
                      <dd className="m-0">
                        {t("scheduling.loneWorker.board.sentTimes", {
                          count: alarm.alertCount,
                          time: formatDateTime(alarm.lastAlertedAt) ?? "",
                        })}
                      </dd>
                      {alarm.location ? (
                        <>
                          <dt className="font-semibold">
                            {t("scheduling.loneWorker.board.locationPoint")}
                          </dt>
                          <dd className="m-0">
                            {t("scheduling.loneWorker.board.locationPointAt", {
                              latitude: alarm.location.latitude.toFixed(5),
                              longitude: alarm.location.longitude.toFixed(5),
                              accuracy: String(alarm.location.accuracyMetres ?? "unknown"),
                              time: formatDateTime(alarm.location.capturedAt) ?? "",
                            })}
                          </dd>
                        </>
                      ) : null}
                    </dl>
                    <AcknowledgeForm alarmId={alarm.id} version={alarm.version} />
                  </div>
                </Card>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section aria-labelledby="sessions" className="flex flex-col gap-4">
        <h2 id="sessions" className="m-0 text-heading-md">
          {t("scheduling.loneWorker.board.sessions", { count: sessions.length })}
        </h2>
        {sessions.length === 0 ? (
          <Card>
            <EmptyState headingLevel={3} title={t("scheduling.loneWorker.board.noSessions")} />
          </Card>
        ) : (
          <Card>
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable by keyboard (axe scrollable-region-focusable). */}
            <section className="overflow-x-auto" tabIndex={0} aria-labelledby="sessions">
              <table className="w-full border-collapse text-left">
                <caption className="sr-only">
                  {t("scheduling.loneWorker.board.sessionsCaption")}
                </caption>
                <thead>
                  <tr>
                    <th scope="col" className="p-2">
                      {t("scheduling.loneWorker.board.colWorker")}
                    </th>
                    <th scope="col" className="p-2">
                      {t("scheduling.loneWorker.board.colStatus")}
                    </th>
                    <th scope="col" className="p-2">
                      {t("scheduling.loneWorker.board.colWhere")}
                    </th>
                    <th scope="col" className="p-2">
                      {t("scheduling.loneWorker.board.colNext")}
                    </th>
                    <th scope="col" className="p-2">
                      {t("scheduling.loneWorker.board.colLast")}
                    </th>
                    <th scope="col" className="p-2">
                      {t("scheduling.loneWorker.board.colEnds")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((item) => {
                    const alarm = worst.get(item.sessionId);
                    return (
                      <tr key={item.sessionId} className="border-t border-border-subtle">
                        <th scope="row" className="p-2 font-semibold">
                          {workerName(item, t)}
                        </th>
                        <td className="p-2">
                          <StatusChip
                            {...sessionChip(item, alarm)}
                            {...(alarm && urgentAlarm(alarm) ? { icon: Siren } : {})}
                          />
                        </td>
                        <td className="p-2">
                          {locationName(item.locationId, me.locations, t)}
                          <span className="block text-body-dense text-text-secondary">
                            {t("scheduling.loneWorker.workKind", { kind: item.workKind })}
                          </span>
                        </td>
                        <td className="p-2">
                          {formatDateTime(item.nextDueAt) ?? t("common.none")}
                        </td>
                        <td className="p-2">
                          {item.lastCheckInAt
                            ? t("scheduling.loneWorker.board.lastCheckInAt", {
                                time: formatDateTime(item.lastCheckInAt) ?? "",
                                late: item.lastCheckInLate ? "yes" : "no",
                              })
                            : t("scheduling.loneWorker.board.noCheckIn")}
                        </td>
                        <td className="p-2">{formatDateTime(item.plannedEndAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          </Card>
        )}
      </section>
    </div>
  );
}
