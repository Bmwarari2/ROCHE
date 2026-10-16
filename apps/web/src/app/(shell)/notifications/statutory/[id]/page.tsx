import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache, type ReactNode } from "react";
import { ClocksAsOf, SafetyWarning, When } from "@/components/safety/IncidentNotifications";
import { NotificationManage } from "@/components/safety/NotificationManage";
import { PersonNeeds } from "@/components/safety/PersonNeeds";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { getShellContext, problemCode, tenantApi } from "@/lib/api";
import { can, entryAuthor } from "@/lib/care-record";
import { isUuid } from "@/lib/context-cookies";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { contentFields, manageDone, notificationManageView } from "@/lib/incident-review";
import {
  incidentStatusChip,
  incidentTitle,
  notificationClockChip,
  notificationKindLabel,
  notificationStatusChip,
  notificationWarnings,
} from "@/lib/incidents";
import { personNames } from "@/lib/people";
import { getPerson, readOrFail } from "@/lib/person-record";
import {
  citationLine,
  deadlineLines,
  notificationSource,
  notificationSubject,
  submitterHint,
} from "@/lib/statutory-notifications";
import { ukToday } from "@/lib/uk-time";

type Params = Promise<{ id: string }>;
type Row = readonly [field: string, value: ReactNode, dateTime?: string | null];

/** One read per request, shared by the page title and the page. */
const getNotification = cache(async (id: string) => {
  const api = await tenantApi();
  return api.GET("/v1/notifications/statutory/{id}", { params: { path: { id } } });
});

/** The page title names the kind of notification, never who it is about. */
export async function generateMetadata({ params }: { readonly params: Params }): Promise<Metadata> {
  const { id } = await params;
  const kind = isUuid(id) ? (await getNotification(id)).data?.kind : undefined;
  return { title: kind ? notificationKindLabel(kind, t) : t("safety.notification.pageTitle") };
}

const link = "inline-flex min-h-target items-center underline";

/** Labelled values, empty ones left out; a moment sits in a `<time>` element. */
function Fields({ rows }: { readonly rows: readonly Row[] }) {
  const shown = rows.filter(([, value]) => Boolean(value));
  if (shown.length === 0) return null;
  return (
    <dl className="m-0 grid grid-cols-1 gap-3 sm:grid-cols-2">
      {shown.map(([field, value, dateTime]) => (
        <div key={field} className="min-w-0">
          <dt className="text-body-dense font-semibold">
            {t("safety.notification.field", { field })}
          </dt>
          <dd className="m-0 whitespace-pre-line break-words">
            {dateTime ? <time dateTime={dateTime}>{value}</time> : value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The API's own English lines (reasons, required content), marked as English for Welsh readers. */
function EnglishList({ lines }: { readonly lines: readonly string[] }) {
  return (
    <div className="flex flex-col gap-2">
      <ul lang="en-GB" className="m-0 flex list-disc flex-col gap-1 ps-5">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="m-0 text-body-dense text-text-secondary">
        {t("safety.notification.englishOnly")}
      </p>
    </div>
  );
}

/**
 * One statutory notification (register rows SAFE-002 and SAFE-003; hazard HZ-013), the page the
 * overdue alert links to, for holders of `safety.incident.manage` as the API allows: its clock and
 * status as icons and words with when they were worked out, who it is about, the record it was
 * drafted on with that record's status (#49 review round 2), its warnings, every deadline in the
 * law's terms, why Harbour drafted it, what it must include, the sources and how it ended. The
 * forms to prepare it, record that it was submitted or decide it is not required (with step-up)
 * appear only where `notificationManageView` offers them (ADR-0071).
 */
export default async function StatutoryNotificationPage({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: Promise<{ done?: string | string[] }>;
}) {
  const { id } = await params;
  const done = manageDone((await searchParams).done);
  if (!isUuid(id)) notFound();
  const { me } = await getShellContext();
  const listTitle = t("safety.notifications.title");
  // The overdue alert sends holders of safety.notification.submit here: say who can act (H-260).
  const forbidden = <SafetyForbidden title={listTitle} hint={submitterHint(me.permissions, t)} />;
  if (!can(me.permissions, "safety.incident.manage")) return forbidden;
  const api = await tenantApi();
  const result = await getNotification(id);
  if (problemCode(result.error) === "not_found") notFound();
  const item = readOrFail(result, `/notifications/statutory/${id}`);
  if (!item) return forbidden;
  const now = new Date();
  const source = notificationSource(item);
  // The incident it was drafted on, for its name, status, open answers and RIDDOR's threshold;
  // without it the link still goes there.
  const incident =
    source?.source === "incident"
      ? (await api.GET("/v1/incidents/{id}", { params: { path: { id: source.id } } })).data
      : undefined;
  const threshold =
    item.kind === "riddor_over_7_day" && incident
      ? await api.GET("/v1/rates/{key}", {
          params: {
            path: { key: "riddor.over_7_day.threshold_days" },
            query: { on: ukToday(new Date(incident.occurredAt)) },
          },
        })
      : null;
  // The one person it is about (a view the API audits), for their name and communication needs.
  const person = item.personId ? (await getPerson(item.personId)).person : null;
  // Each form only where its permission reaches the person it is about (ADR-0071); a person the
  // reader cannot open at all reaches nothing. About no one, the held permissions decide.
  const reaching = item.personId ? (person ? (person.access?.reaching ?? null) : []) : null;
  const manage = notificationManageView(item, me.permissions, reaching);
  const fields = contentFields(item.requiredContent);
  const names = new Map(person ? [[person.id, personNames(person).full]] : []);
  const title = notificationKindLabel(item.kind, t, threshold?.data?.value);
  const location = me.locations.find((l) => l.id === item.locationId);
  const subject = notificationSubject(item, names, t);
  const status = notificationStatusChip(item, t);
  const waitingFor =
    incident?.classifier?.pending.find((p) => p.kind === item.kind)?.waitingFor.length ?? null;
  const section = (name: string) => t("safety.notification.section", { section: name });
  const when = (iso: string | null) => formatDateTime(iso) ?? null;

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6 break-words">
      <nav aria-label={t("common.breadcrumb")} className="text-body-dense">
        <Link href="/notifications/statutory" className={link}>
          {listTitle}
        </Link>
        <span aria-hidden="true" className="px-2 text-text-secondary">
          ›
        </span>
        <span aria-current="page">{title}</span>
      </nav>
      <PageHeader
        eyebrow={location?.name ?? t("safety.incident.locationHidden")}
        title={title}
        description={t("safety.notification.recipient", { kind: item.kind })}
      />
      {done ? <RecordedArrival message={t("safety.manage.done", { done })} /> : null}
      <div className="flex flex-col gap-2">
        <p className="m-0 flex flex-wrap items-center gap-2">
          <SafetyChip chip={notificationClockChip(item, now, t)} />
          {status ? <SafetyChip chip={status} /> : null}
        </p>
        <ClocksAsOf now={now} />
        {subject ? <p className="m-0">{subject}</p> : null}
        {person ? <PersonNeeds person={person} /> : null}
        {notificationWarnings(item, waitingFor, t).map((text) => (
          <SafetyWarning key={text} text={text} />
        ))}
      </div>
      {source ? (
        <Card
          as="section"
          title={t("safety.notification.field", { field: "source" })}
          headingLevel={2}
        >
          <p className="m-0 flex flex-wrap items-center gap-2">
            <Link href={source.href} className={link}>
              {t("safety.notification.sourceLink", {
                source: source.source,
                title: incident ? incidentTitle(incident, t) : "none",
              })}
            </Link>
            {incident ? <SafetyChip chip={incidentStatusChip(incident.status, t)} /> : null}
          </p>
        </Card>
      ) : null}
      <Card
        as="section"
        title={section(item.clock === "done" ? "history" : "deadlines")}
        headingLevel={2}
      >
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {deadlineLines(item, t).map((line) => (
            <li key={line.text}>
              <When line={line} />
            </li>
          ))}
        </ul>
      </Card>
      {item.reasons.length > 0 ? (
        <Card as="section" title={section("reasons")} headingLevel={2}>
          <EnglishList lines={item.reasons} />
        </Card>
      ) : null}
      {item.requiredContent.length > 0 ? (
        <Card as="section" title={section("content")} headingLevel={2}>
          <EnglishList lines={item.requiredContent} />
        </Card>
      ) : null}
      {item.sources.length > 0 ? (
        <Card as="section" title={section("sources")} headingLevel={2}>
          <ul lang="en-GB" className="m-0 flex list-none flex-col gap-1 p-0">
            {item.sources.map((cite) => {
              const line = citationLine(cite, t);
              return (
                <li key={`${cite.source} ${cite.provision}`}>
                  {line.href ? (
                    <a href={line.href} className={link} rel="noreferrer">
                      {line.text}
                    </a>
                  ) : (
                    line.text
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}
      {manage.prepare || manage.submit || manage.notRequired ? (
        <Card as="section" title={section("act")} headingLevel={2}>
          <NotificationManage
            target={{
              id: item.id,
              incidentId: item.incidentId,
              version: item.version,
              status: item.status,
            }}
            view={manage}
            fields={fields}
            content={item.content}
          />
        </Card>
      ) : Object.keys(item.content).length > 0 ? (
        <Card as="section" title={section("prepared")} headingLevel={2}>
          <dl className="m-0 flex flex-col gap-3">
            {fields
              .filter((field) => item.content[field.key])
              .map((field) => (
                <div key={field.name} className="min-w-0">
                  <dt className="text-body-dense font-semibold">
                    {field.line ?? t("safety.manage.prepare.notes")}
                  </dt>
                  <dd className="m-0 whitespace-pre-line break-words">{item.content[field.key]}</dd>
                </div>
              ))}
          </dl>
        </Card>
      ) : null}
      <Card as="section" title={section("outcome")} headingLevel={2}>
        {item.submittedAt || item.notRequiredReason ? (
          <Fields
            rows={[
              ["submittedAt", when(item.submittedAt), item.submittedAt],
              [
                "submittedBy",
                item.submittedBy
                  ? t("safety.incident.who", {
                      who: entryAuthor(item.submittedBy, me.tenantUserId),
                    })
                  : null,
              ],
              ["externalReference", item.externalReference],
              ["evidence", item.evidenceDocumentId ? t("safety.notification.evidence") : null],
              ["notRequiredReason", item.notRequiredReason],
              ["classifierVersion", item.classifierVersion],
            ]}
          />
        ) : (
          <p className="m-0">{t("safety.notification.noOutcome")}</p>
        )}
      </Card>
    </div>
  );
}
