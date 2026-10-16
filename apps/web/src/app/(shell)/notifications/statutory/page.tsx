import type { StatutoryNotificationSummary } from "@harbour/contracts";
import { Card, PageHeader } from "@harbour/ui";
import { TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Notice } from "@/components/care/Notice";
import { ClocksAsOf, SafetyWarning, When } from "@/components/safety/IncidentNotifications";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { can } from "@/lib/care-record";
import { t } from "@/lib/i18n";
import {
  notificationClockChip,
  notificationDueLines,
  notificationKindLabel,
  notificationStatusChip,
  notificationSubjects,
  notificationWarnings,
} from "@/lib/incidents";
import { personNames } from "@/lib/people";
import {
  hasHiddenSubjects,
  NOTIFICATION_LIST_LIMIT,
  notificationGroups,
} from "@/lib/statutory-notifications";

export const metadata: Metadata = { title: t("safety.notifications.title") };

function Item({
  item,
  subject,
  location,
  now,
}: {
  readonly item: StatutoryNotificationSummary;
  readonly subject: string | undefined;
  readonly location: string;
  readonly now: Date;
}) {
  const status = notificationStatusChip(item, t);
  const lines = notificationDueLines(item, [], t);
  const describedBy = `about-${item.id}`;
  return (
    <li
      className="flex flex-col gap-1 border-b border-border pb-3 break-words"
      data-notification={item.kind}
    >
      <h3 className="m-0 text-body font-semibold">
        {/* Described by who and when, so two links of the same kind are told apart. */}
        <Link
          href={`/notifications/statutory/${item.id}`}
          aria-describedby={describedBy}
          className="inline-flex min-h-target items-center underline"
        >
          {notificationKindLabel(item.kind, t)}
        </Link>
      </h3>
      <span className="flex flex-wrap items-center gap-2">
        <SafetyChip chip={notificationClockChip(item, now, t)} />
        {status ? <SafetyChip chip={status} /> : null}
      </span>
      <span id={describedBy} className="flex flex-col gap-1">
        {subject ? <span>{subject}</span> : null}
        {lines.map((line) => (
          <When key={line.text} line={line} />
        ))}
        <span className="text-body-dense text-text-secondary">{location}</span>
      </span>
      <span className="text-body-dense text-text-secondary">
        {t("safety.notification.recipient", { kind: item.kind })}
      </span>
      {notificationWarnings(item, null, t).map((text) => (
        <SafetyWarning key={text} text={text} />
      ))}
    </li>
  );
}

/**
 * Every statutory notification in the viewer's scope (register rows SAFE-002 and SAFE-003; hazard
 * HZ-013), for holders of `safety.incident.manage` as the API allows: those still to do first,
 * overdue before due, then those submitted or decided not required, each with its clock and
 * status as an icon and a word, who it is about, its due time and warnings, and when the clocks
 * were worked out. Each opens its own page. Read only; the forms follow (docs/plans/STATUS.md).
 */
export default async function StatutoryNotificationsPage() {
  const { me, locationId } = await getShellContext();
  const title = t("safety.notifications.title");
  if (!can(me.permissions, "safety.incident.manage")) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const { data, error, response } = await api.GET("/v1/notifications/statutory", {
    params: { query: locationId ? { locationId } : {} },
  });
  if (!data) {
    if (problemCode(error) === "missing_permission") return <SafetyForbidden title={title} />;
    return failWith(error, response, "/notifications/statutory");
  }
  // The reader's own people, for who a notification is about; others are numbered.
  const list = await api.GET("/v1/people", { params: { query: {} } });
  const names = new Map((list.data?.items ?? []).map((p) => [p.id, personNames(p).full]));
  const now = new Date();
  const groups = notificationGroups(data.items);
  const subjects = notificationSubjects([...groups.todo, ...groups.done], names, t);
  const location = me.locations.find((l) => l.id === locationId);
  const locationNames = new Map(me.locations.map((l) => [l.id, l.name]));

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={location ? location.name : me.tenant.name}
        title={title}
        description={t("safety.notifications.description")}
      />
      {data.items.length >= NOTIFICATION_LIST_LIMIT ? (
        <Notice
          tone="warning"
          icon={<TriangleAlert size={20} strokeWidth={1.5} aria-hidden="true" />}
          title={t("safety.notifications.truncated", { limit: NOTIFICATION_LIST_LIMIT })}
        />
      ) : null}
      <ClocksAsOf now={now} />
      {hasHiddenSubjects(data.items, names) ? (
        <p className="m-0">{t("safety.notifications.numbered")}</p>
      ) : null}
      {(["todo", "done"] as const).map((group) => (
        <Card
          key={group}
          as="section"
          headingLevel={2}
          title={t("safety.notifications.group", { group })}
        >
          {groups[group].length === 0 ? (
            <p className="m-0">{t("safety.notifications.empty", { group })}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {groups[group].map((item) => (
                <Item
                  key={item.id}
                  item={item}
                  subject={subjects.get(item.id)}
                  location={
                    locationNames.get(item.locationId) ?? t("safety.incident.locationHidden")
                  }
                  now={now}
                />
              ))}
            </ul>
          )}
        </Card>
      ))}
    </div>
  );
}
