import type { NotificationItem } from "@harbour/contracts";
import { Button, Card, EmptyState, PageHeader, StatusChip, VisuallyHidden } from "@harbour/ui";
import { BellOff } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { acknowledgeNotification, markNotificationRead } from "@/app/actions/notifications";
import { failWith, tenantApi } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { safeNextPath } from "@/lib/problems";

export const metadata: Metadata = { title: t("notifications.title") };

const SEVERITY: Record<
  NotificationItem["severity"],
  { status: "overdue" | "due" | "info"; label: string }
> = {
  urgent: { status: "overdue", label: "Urgent" },
  warning: { status: "due", label: "Needs attention" },
  info: { status: "info", label: "Information" },
};

function stateChip(item: NotificationItem) {
  if (item.acknowledgedAt) return <StatusChip status="done" label="Acknowledged" />;
  if (item.readAt) return <StatusChip status="neutral" label="Read" />;
  return <StatusChip status="info" label="New" />;
}

/** The person's notifications, newest first, with mark as read and acknowledge. */
export default async function NotificationsPage() {
  const api = await tenantApi();
  const { data, error, response } = await api.GET("/v1/notifications");
  if (!data) failWith(error, response, "/notifications");

  const unread = data.unread;

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        title={t("notifications.title")}
        description={
          data.items.length === 0
            ? undefined
            : unread === 0
              ? t("notifications.empty")
              : unread === 1
                ? "1 notification not read yet."
                : `${unread} notifications not read yet.`
        }
      />
      {data.items.length === 0 ? (
        <Card>
          <EmptyState
            headingLevel={2}
            icon={<BellOff size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("notifications.empty")}
            description="Alerts about the people you support and tasks for you will appear here."
          />
        </Card>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {data.items.map((item) => {
            const severity = SEVERITY[item.severity];
            const when = formatDateTime(item.createdAt);
            const link = safeNextPath(item.link);
            return (
              <li key={item.id}>
                <Card as="article" aria-labelledby={`notification-${item.id}`}>
                  <div className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusChip status={severity.status} label={severity.label} />
                      {stateChip(item)}
                      {when ? (
                        <time
                          dateTime={item.createdAt}
                          className="text-callout text-text-secondary"
                        >
                          {when}
                        </time>
                      ) : null}
                    </div>
                    <h2 id={`notification-${item.id}`} className="m-0 text-body font-semibold">
                      {link ? <Link href={link}>{item.title}</Link> : item.title}
                    </h2>
                    {item.body ? <p className="m-0 text-text-secondary">{item.body}</p> : null}
                    {item.readAt && item.acknowledgedAt ? null : (
                      <div className="flex flex-wrap gap-2">
                        {item.readAt ? null : (
                          <form action={markNotificationRead}>
                            <input type="hidden" name="id" value={item.id} />
                            <Button type="submit" variant="secondary">
                              {t("notifications.markRead")}
                              <VisuallyHidden>: {item.title}</VisuallyHidden>
                            </Button>
                          </form>
                        )}
                        {item.acknowledgedAt ? null : (
                          <form action={acknowledgeNotification}>
                            <input type="hidden" name="id" value={item.id} />
                            <Button type="submit" variant="primary">
                              {t("notifications.acknowledge")}
                              <VisuallyHidden>: {item.title}</VisuallyHidden>
                            </Button>
                          </form>
                        )}
                      </div>
                    )}
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
