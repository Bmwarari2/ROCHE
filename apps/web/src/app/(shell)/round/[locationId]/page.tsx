import type { RoundTask } from "@harbour/contracts";
import { Card, EmptyState, PageHeader, StatusChip } from "@harbour/ui";
import { CircleAlert, ClipboardCheck, History, RotateCcw, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrivalNotice } from "@/components/care/ArrivalNotice";
import { Notice } from "@/components/care/Notice";
import { RoundRefresh } from "@/components/care/RoundRefresh";
import { RoundTaskActions } from "@/components/care/RoundTaskActions";
import { PersonHeaderCompact } from "@/components/people/PersonHeader";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { personNames } from "@/lib/people";
import { firstParam } from "@/lib/record-metadata";
import {
  dueLine,
  forPerson,
  nextReadIn,
  recordHref,
  roundCounts,
  roundShown,
  roundTaskActions,
  timeStateChip,
} from "@/lib/round";

type Params = Promise<{ locationId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata: Metadata = { title: t("care.round.title") };

const iconProps = { size: 20, strokeWidth: 1.5, "aria-hidden": true } as const;
const MOVED = new Set(["in_progress", "done", "skipped"]);

/**
 * The round (care.md rule 8; CARE-013; hazards HZ-001, HZ-003, HZ-024): the location's open tasks
 * for the shift running now, by floor or unit and room, each stop with the person's name, room and
 * communication needs. Each task says when it is due and where it stands in an icon and words; a
 * care plan round shows the action as its plan words it, marked when from an earlier plan; each
 * stop lists the actions that are not rounds (medicines). Tasks can be started, done or marked not
 * done with a reason by those who record care; the API decides each again.
 */
export default async function RoundPage({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { locationId } = await params;
  if (!isUuid(locationId)) notFound();
  const { me } = await getShellContext();
  const title = t("care.round.title");
  if (!roundShown(me.permissions)) return <SafetyForbidden title={title} />;
  const location = me.locations.find((l) => l.id === locationId);
  if (!location) notFound();
  const query = await searchParams;
  const person = firstParam(query.person);
  const personId = person && isUuid(person) ? person : null;
  const moved = firstParam(query.moved);
  const at = firstParam(query.at);
  const api = await tenantApi();
  const read = await api.GET("/v1/locations/{id}/round", {
    params: { path: { id: locationId }, query: {} },
  });
  if (problemCode(read.error) === "not_found") notFound();
  if (problemCode(read.error) === "missing_permission") return <SafetyForbidden title={title} />;
  if (!read.data) failWith(read.error, read.response, `/round/${locationId}`);
  const round = read.data;
  const areas = forPerson(round, personId);
  const counts = roundCounts(areas);
  // Tasks are recorded by those who record care; the API checks the task's own permission and
  // that it reaches the person (the round view does not say which permission each task names).
  const canWrite = me.permissions.includes("care.note.write");
  const base = `/round/${locationId}${personId ? `?person=${personId}` : ""}`;
  const filteredName = personId
    ? areas.flatMap((a) => a.stops).find((s) => s.person)?.person
    : null;

  const taskLine = (task: RoundTask, name: string | null) => (
    <li
      key={task.id}
      className="flex flex-col gap-2 rounded-input border border-border p-3"
      data-round-task={task.timeState}
    >
      <p className="m-0 font-semibold">{task.planAction?.action ?? task.title}</p>
      <p className="m-0 flex flex-wrap items-center gap-2">
        <SafetyChip chip={timeStateChip(task.timeState, t)} />
        {task.priority === "urgent" ? (
          <StatusChip status="overdue" label={t("care.round.urgent")} icon={TriangleAlert} />
        ) : null}
        {task.status === "in_progress" ? (
          <StatusChip status="info" label={t("care.round.started")} />
        ) : null}
        {task.catchUp ? (
          <StatusChip status="info" label={t("care.round.catchUp")} icon={RotateCcw} />
        ) : null}
      </p>
      <p className="m-0 text-body-dense">{dueLine(task, t)}</p>
      {task.planAction?.notice ? (
        <p className="m-0 flex items-start gap-2 font-semibold">
          <History size={18} strokeWidth={1.5} aria-hidden="true" className="mt-0.5 shrink-0" />
          {task.planAction.notice}
        </p>
      ) : null}
      <RoundTaskActions
        locationId={locationId}
        taskId={task.id}
        version={task.version}
        title={task.planAction?.action ?? task.title}
        actions={roundTaskActions(task, canWrite)}
        recordHref={recordHref(task)}
        returnTo={base}
        name={name}
      />
    </li>
  );

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={location.name}
        title={title}
        description={t("care.round.shift", {
          name: round.shift.name,
          from: formatDateTime(round.from) ?? "",
          to: formatDateTime(round.to) ?? "",
        })}
      />
      {moved && MOVED.has(moved) ? (
        <ArrivalNotice key={at ?? moved}>{t("care.round.arrived", { moved })}</ArrivalNotice>
      ) : null}
      <RoundRefresh inMs={nextReadIn(areas)} />
      <p className="m-0 text-body-dense">{t("care.round.counts", counts)}</p>
      <p className="m-0 text-body-dense text-text-secondary">
        {t("care.round.readAt", { dateTime: formatDateTime(round.readAt) ?? "" })}
      </p>
      {round.complete ? null : (
        <Notice
          tone="warning"
          icon={<TriangleAlert {...iconProps} />}
          title={t("care.round.incomplete")}
        />
      )}
      {personId ? (
        <p className="m-0">
          {t("care.round.onePerson", {
            name: filteredName ? personNames(filteredName).full : t("care.round.thisPerson"),
          })}{" "}
          <Link
            href={`/round/${locationId}`}
            className="inline-flex min-h-target items-center underline"
          >
            {t("care.round.everyone")}
          </Link>
        </p>
      ) : null}
      {areas.length === 0 ? (
        <Card>
          <EmptyState
            headingLevel={2}
            icon={<ClipboardCheck size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("care.round.empty")}
          />
        </Card>
      ) : (
        areas.map((area) => (
          <Card
            key={area.area ?? "none"}
            as="section"
            title={area.area ?? t("care.round.noArea")}
            headingLevel={2}
          >
            <ul className="m-0 flex list-none flex-col gap-5 p-0">
              {area.stops.map((stop) => (
                <li
                  key={stop.personId ?? "none"}
                  className="flex flex-col gap-3 border-b border-border pb-4"
                >
                  {stop.person ? (
                    <PersonHeaderCompact person={stop.person} />
                  ) : (
                    <h3 className="m-0 text-body font-semibold">
                      {t("care.round.noPerson", { hidden: String(stop.personId !== null) })}
                    </h3>
                  )}
                  {stop.person && !personId ? (
                    <Link
                      href={`/round/${locationId}?person=${stop.person.id}`}
                      className="inline-flex min-h-target items-center text-body-dense underline"
                    >
                      {t("care.round.onlyThem", { name: personNames(stop.person).full })}
                    </Link>
                  ) : null}
                  <ul className="m-0 flex list-none flex-col gap-3 p-0">
                    {stop.tasks.map((task) =>
                      taskLine(task, stop.person ? personNames(stop.person).full : null),
                    )}
                  </ul>
                  {stop.notRounds.length > 0 ? (
                    <ul className="m-0 flex list-none flex-col gap-1 p-0">
                      {stop.notRounds.map((n) => (
                        <li key={n.actionId} className="flex items-start gap-2 text-body-dense">
                          <CircleAlert
                            size={18}
                            strokeWidth={1.5}
                            aria-hidden="true"
                            className="mt-0.5 shrink-0"
                          />
                          <span>
                            {n.action}: {n.notice}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          </Card>
        ))
      )}
    </div>
  );
}
