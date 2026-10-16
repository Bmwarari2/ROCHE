import type { IncidentDetail } from "@harbour/contracts";
import { TriangleAlert } from "lucide-react";
import Link from "next/link";
import { Notice } from "@/components/care/Notice";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import {
  notificationClockChip,
  notificationDueLines,
  notificationKindLabel,
  notificationStatusChip,
  notificationSubjects,
  notificationsInOrder,
  notificationsView,
  notificationWarnings,
  type TimeLine,
} from "@/lib/incidents";
import { SafetyChip } from "./SafetyChip";

const iconProps = { strokeWidth: 1.5, "aria-hidden": true } as const;

/** A warning in words with its icon, never colour alone; one about a moment carries its time. */
export function SafetyWarning({
  text,
  dateTime = null,
}: {
  readonly text: string;
  readonly dateTime?: string | null;
}) {
  return (
    <p className="m-0 flex items-start gap-2 font-semibold">
      <TriangleAlert {...iconProps} size={18} className="mt-0.5 shrink-0" />
      {dateTime ? <time dateTime={dateTime}>{text}</time> : text}
    </p>
  );
}

/**
 * When the clocks on the page were worked out (#49 review): they are counted when the page is
 * drawn and do not move on by themselves.
 */
export function ClocksAsOf({ now }: { readonly now: Date }) {
  return (
    <p className="m-0 text-body-dense text-text-secondary">
      <time dateTime={now.toISOString()}>
        {t("safety.notification.asOf", { dateTime: formatDateTime(now.toISOString()) ?? "" })}
      </time>
    </p>
  );
}

/** A moment in words, in a `<time>` element; a time that cannot be read is a warning. */
export function When({ line }: { readonly line: TimeLine }) {
  return line.dateTime ? (
    <span className="text-body-dense">
      <time dateTime={line.dateTime}>{line.text}</time>
    </span>
  ) : (
    <SafetyWarning text={line.text} />
  );
}

/**
 * The statutory notifications on an incident (HZ-013): the notices and what is waiting before
 * Harbour can say, then each notification with its kind, who it is about, its clock and status as
 * icons and words, its deadlines in the law's terms, its recipient and its warnings. Read only;
 * the forms follow (docs/plans/STATUS.md).
 */
export function IncidentNotifications({
  classifier,
  access,
  names,
  riddorDays,
  closed,
  now,
  linked = false,
}: {
  readonly classifier: IncidentDetail["classifier"];
  readonly access: { readonly canSubmit: boolean; readonly canManage: boolean };
  /** The incident is closed: the checks that decide a notification are over. */
  readonly closed: boolean;
  /** The reader's people by id, for who a notification is about. */
  readonly names: ReadonlyMap<string, string>;
  /** RIDDOR's over-seven-day threshold from the rate table, when the page could read it. */
  readonly riddorDays?: number;
  /** When the page was drawn, which the clocks are counted to. */
  readonly now: Date;
  /** The reader may open each notification's own page (`safety.incident.manage`). */
  readonly linked?: boolean;
}) {
  const view = notificationsView(classifier, { ...access, closed, now }, t, riddorDays);
  const items = notificationsInOrder(classifier?.notifications ?? []);
  const subjects = notificationSubjects(items, names, t);
  const waitingFor = new Map((classifier?.pending ?? []).map((p) => [p.kind, p.waitingFor.length]));
  return (
    <div className="flex flex-col gap-3">
      {view.notices.map((notice) => (
        <Notice
          key={notice.title}
          tone="warning"
          icon={<TriangleAlert {...iconProps} size={20} />}
          title={notice.title}
        >
          {notice.body}
        </Notice>
      ))}
      {view.waiting.map((line) => (
        <SafetyWarning key={line.text} text={line.text} dateTime={line.dateTime} />
      ))}
      {view.none ? <p className="m-0">{view.none}</p> : null}
      {items.length > 0 ? <ClocksAsOf now={now} /> : null}
      {items.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {items.map((item) => {
            const status = notificationStatusChip(item, t);
            const subject = subjects.get(item.id);
            return (
              <li
                key={item.id}
                className="flex flex-col gap-1 border-b border-border pb-3 break-words"
                data-notification={item.kind}
              >
                <h3 className="m-0 text-body font-semibold">
                  {linked ? (
                    <Link
                      href={`/notifications/statutory/${item.id}`}
                      className="inline-flex min-h-target items-center underline"
                    >
                      {notificationKindLabel(item.kind, t, riddorDays)}
                    </Link>
                  ) : (
                    notificationKindLabel(item.kind, t, riddorDays)
                  )}
                </h3>
                {subject ? <span>{subject}</span> : null}
                <span className="flex flex-wrap items-center gap-2">
                  <SafetyChip chip={notificationClockChip(item, now, t)} />
                  {status ? <SafetyChip chip={status} /> : null}
                </span>
                {notificationDueLines(item, classifier?.outputs ?? [], t).map((line) => (
                  <When key={line.text} line={line} />
                ))}
                <span className="text-body-dense text-text-secondary">
                  {t("safety.notification.recipient", { kind: item.kind })}
                </span>
                {notificationWarnings(item, waitingFor.get(item.kind) ?? null, t).map((text) => (
                  <SafetyWarning key={text} text={text} />
                ))}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
