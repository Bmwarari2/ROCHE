import type { IncidentDetail } from "@harbour/contracts";
import { Card, PageHeader, StatusChip } from "@harbour/ui";
import { Lock, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EntryBadges } from "@/components/care/EntryBadges";
import { Notice } from "@/components/care/Notice";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { getShellContext, problemCode, tenantApi } from "@/lib/api";
import { can, entryAuthor } from "@/lib/care-record";
import { isUuid } from "@/lib/context-cookies";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import {
  incidentPersonFacts,
  incidentPersonLine,
  incidentStatusChip,
  incidentTitle,
  notificationClockChip,
  notificationKindLabel,
  notificationsInOrder,
  notificationsView,
  notificationWarnings,
} from "@/lib/incidents";
import { personNames } from "@/lib/people";
import { readOrFail } from "@/lib/person-record";

type Params = Promise<{ id: string }>;
type Row = readonly [field: string, value: string | null, dateTime?: string | null];

/** The page title says what the page is, never who was involved. */
export const metadata: Metadata = { title: t("safety.incident.pageTitle") };

const iconProps = { size: 20, strokeWidth: 1.5, "aria-hidden": true } as const;

/** Labelled values, empty ones left out; a moment sits in a `<time>` element. */
function Fields({ rows }: { readonly rows: readonly Row[] }) {
  const shown = rows.filter(([, value]) => Boolean(value));
  if (shown.length === 0) return null;
  return (
    <dl className="m-0 grid grid-cols-1 gap-3 sm:grid-cols-2">
      {shown.map(([field, value, dateTime]) => (
        <div key={field} className="min-w-0">
          <dt className="text-body-dense font-semibold">{t("safety.incident.field", { field })}</dt>
          <dd className="m-0 whitespace-pre-line break-words">
            {dateTime ? <time dateTime={dateTime}>{value}</time> : value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Warning({ text }: { readonly text: string }) {
  return (
    <p className="m-0 flex items-start gap-2 font-semibold">
      <TriangleAlert {...iconProps} size={18} className="mt-0.5 shrink-0" />
      {text}
    </p>
  );
}

const when = (iso: string | null) => formatDateTime(iso) ?? null;

/** Whether the statutory notifications this incident needs are drafted, and when each is due. */
function Notifications({ classifier }: { readonly classifier: IncidentDetail["classifier"] }) {
  const view = notificationsView(classifier, t);
  const items = notificationsInOrder(classifier?.notifications ?? []);
  return (
    <div className="flex flex-col gap-3">
      {view.notices.map((notice) => (
        <Notice
          key={notice.title}
          tone="warning"
          icon={<TriangleAlert {...iconProps} />}
          title={notice.title}
        >
          {notice.body}
        </Notice>
      ))}
      {view.pending.map((line) => (
        <Warning key={line} text={line} />
      ))}
      {view.none ? <p className="m-0">{view.none}</p> : null}
      {items.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex flex-col gap-1 border-b border-border pb-3 break-words"
              data-notification={item.kind}
            >
              <h3 className="m-0 text-body font-semibold">{notificationKindLabel(item.kind, t)}</h3>
              <span className="flex flex-wrap items-center gap-2">
                <SafetyChip chip={notificationClockChip(item, t)} />
                {item.clock === "done" ? null : (
                  <span>{t("safety.notification.status", { status: item.status })}</span>
                )}
              </span>
              <span className="text-body-dense">
                <time dateTime={item.dueAt}>
                  {t("safety.notification.dueBy", { dateTime: when(item.dueAt) ?? "" })}
                </time>
              </span>
              <span className="text-body-dense text-text-secondary">
                {t("safety.notification.recipient", { kind: item.kind })}
              </span>
              {notificationWarnings(item, t).map((text) => (
                <Warning key={text} text={text} />
              ))}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * One incident (register rows SAFE-001 and SAFE-002; hazard HZ-013): what happened, who was told,
 * the people on it, and the statutory notifications with their clocks and warnings, as the API
 * returns them. A reader who cannot see everyone on it sees the header and their own people only.
 * Answering the questions and preparing the notifications follow (docs/plans/STATUS.md).
 */
export default async function IncidentPage({ params }: { readonly params: Params }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { me } = await getShellContext();
  const listTitle = t("safety.incidents.title");
  if (!can(me.permissions, "safety.incident.read")) return <SafetyForbidden title={listTitle} />;
  const api = await tenantApi();
  const result = await api.GET("/v1/incidents/{id}", { params: { path: { id } } });
  if (problemCode(result.error) === "not_found") notFound();
  const incident = readOrFail(result, `/incidents/${id}`);
  if (!incident) return <SafetyForbidden title={listTitle} />;
  // Names of the people we support on it, from the reader's own scope; without access to the
  // people list they are named by kind ("A person we support").
  const people = await api.GET("/v1/people", { params: { query: {} } });
  const names = new Map((people.data?.items ?? []).map((p) => [p.id, personNames(p).full]));
  const title = incidentTitle(incident, t);
  const location = me.locations.find((l) => l.id === incident.locationId);
  const author = (userId: string | null) =>
    userId ? t("safety.incident.who", { who: entryAuthor(userId, me.tenantUserId) }) : null;
  const section = (name: string) => t("safety.incident.section", { section: name });
  const notRecorded = t("common.notRecorded");

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <nav aria-label={t("common.breadcrumb")} className="text-body-dense">
        <Link href="/incidents" className="underline">
          {listTitle}
        </Link>
        <span aria-hidden="true" className="px-2 text-text-secondary">
          ›
        </span>
        <span>{title}</span>
      </nav>
      <PageHeader eyebrow={location?.name ?? notRecorded} title={title} />
      <p className="m-0 flex flex-wrap items-center gap-2">
        <SafetyChip chip={incidentStatusChip(incident.status, t)} />
        {incident.restricted ? (
          <StatusChip status="info" label={t("safety.incident.restrictedChip")} icon={Lock} />
        ) : null}
        <EntryBadges entry={incident} />
      </p>
      {incident.restricted ? (
        <Notice icon={<Lock {...iconProps} />} title={t("safety.incident.restrictedNotice")}>
          {t("safety.incident.restrictedHint")}
        </Notice>
      ) : null}
      <Card as="section" title={section("details")} headingLevel={2} className="break-words">
        <Fields
          rows={[
            ["occurredAt", when(incident.occurredAt), incident.occurredAt],
            ["foundAt", when(incident.foundAt), incident.foundAt],
            ["recordedAt", when(incident.recordedAt), incident.recordedAt],
            ["raisedBy", author(incident.raisedBy)],
            [
              "severity",
              incident.severity
                ? t("safety.incident.severity", { severity: incident.severity })
                : notRecorded,
            ],
            [
              "harmGrade",
              incident.harmGrade
                ? t("safety.incident.harm", { harm: incident.harmGrade })
                : notRecorded,
            ],
            ["description", incident.description],
            ["immediateActions", incident.immediateActions],
            ["closedAt", when(incident.closedAt), incident.closedAt],
            ["closedBy", author(incident.closedBy)],
            ["closedReason", incident.closedReason],
          ]}
        />
      </Card>
      {incident.restricted ? null : (
        <Card as="section" title={section("contacts")} headingLevel={2} className="break-words">
          <Fields
            rows={[
              [
                "emergencyServices",
                t("safety.incident.answer", { answer: String(incident.emergencyServicesCalled) }),
              ],
              ["gp", t("safety.incident.answer", { answer: String(incident.gpContacted) })],
              [
                "family",
                incident.familyInformed
                  ? t("safety.incident.familyInformed", {
                      who: incident.familyInformed.who,
                      dateTime: when(incident.familyInformed.at) ?? "",
                    })
                  : notRecorded,
              ],
              ["contactNotes", incident.contactNotes],
            ]}
          />
        </Card>
      )}
      <Card as="section" title={section("people")} headingLevel={2} className="break-words">
        {incident.people.length === 0 ? (
          <p className="m-0">{t("safety.incident.noPeople")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {incident.people.map((person) => (
              <li key={person.id} className="flex flex-col gap-1 border-b border-border pb-3">
                <span className="font-semibold">{incidentPersonLine(person, names, t)}</span>
                {person.injuryDetails ? (
                  <span className="whitespace-pre-line">
                    {t("safety.incident.injury", { details: person.injuryDetails })}
                  </span>
                ) : null}
                {incidentPersonFacts(person, t).map((fact) => (
                  <span key={fact} className="text-body-dense">
                    {fact}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {incident.restricted ? null : (
        <Card as="section" title={section("notifications")} headingLevel={2}>
          <Notifications classifier={incident.classifier} />
        </Card>
      )}
    </div>
  );
}
