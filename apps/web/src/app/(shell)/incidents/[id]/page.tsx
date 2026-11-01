import { buttonClassName, Card, PageHeader, StatusChip } from "@harbour/ui";
import { CircleAlert, Lock } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { EntryBadges } from "@/components/care/EntryBadges";
import { Notice } from "@/components/care/Notice";
import { CommunicationStatus } from "@/components/people/CommunicationStatus";
import { AfterDeath } from "@/components/safety/AfterDeath";
import { CandourSection } from "@/components/safety/CandourSection";
import { ClassifierQuestions } from "@/components/safety/ClassifierQuestions";
import { IncidentManage } from "@/components/safety/IncidentManage";
import { IncidentNotifications } from "@/components/safety/IncidentNotifications";
import { InvestigationSection } from "@/components/safety/InvestigationSection";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { getShellContext, problemCode, tenantApi } from "@/lib/api";
import { can, entryAuthor } from "@/lib/care-record";
import { isUuid } from "@/lib/context-cookies";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { questionsYouMayAnswer } from "@/lib/incident-forms";
import {
  doneToShow,
  followUpDoneToShow,
  incidentManageView,
  manageDone,
} from "@/lib/incident-review";
import {
  incidentPersonFacts,
  incidentPersonLine,
  incidentStatusChip,
  incidentTitle,
  notificationKindLabel,
  overdueCount,
  showsPostFallCard,
} from "@/lib/incidents";
import { communicationSummary, personNames, sampleName } from "@/lib/people";
import { readOrFail } from "@/lib/person-record";
import { evidenceManaged } from "@/lib/quality-programme";
import { ukToday } from "@/lib/uk-time";

type Params = Promise<{ id: string }>;
type Row = readonly [field: string, value: string | null, dateTime?: string | null];

/** One read per request, shared by the page title and the page. */
const getIncident = cache(async (id: string) => {
  const api = await tenantApi();
  return api.GET("/v1/incidents/{id}", { params: { path: { id } } });
});

/** The page title names the incident by when it happened, never who was involved. */
export async function generateMetadata({ params }: { readonly params: Params }): Promise<Metadata> {
  const { id } = await params;
  const occurredAt = isUuid(id) ? (await getIncident(id)).data?.occurredAt : undefined;
  return {
    title: t("safety.incident.pageTitle", { dateTime: formatDateTime(occurredAt) ?? "none" }),
  };
}

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

const when = (iso: string | null) => formatDateTime(iso) ?? null;

/**
 * One incident (register row SAFE-001; hazard HZ-013): what happened, who was told and the
 * people on it, as the API returns them, with the questions about statutory notifications still
 * to answer and the statutory notifications with their clocks and warnings (#42 review); an
 * overdue notification is named at the top, linked to them (#49 review). A reader who cannot see
 * everyone on it sees the header and their own people only. The questions are answered here by a
 * manager, or the falls questions by whoever raised it. A manager reviews and closes it here
 * (`incidentManageView`), never the person who raised it; each notification is prepared and
 * submitted on its own page. After a death, the medical examiner pack's sections and the LeDeR
 * prompt (SAFE-008); then the duty of candour record (SAFE-007) and the investigation (SAFE-010),
 * each recorded here by a manager.
 */
export default async function IncidentPage({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: Promise<{ recorded?: string | string[]; done?: string | string[] }>;
}) {
  const { id } = await params;
  const { recorded, done: doneParam } = await searchParams;
  const done = manageDone(doneParam);
  if (!isUuid(id)) notFound();
  const { me } = await getShellContext();
  const listTitle = t("safety.incidents.title");
  if (!can(me.permissions, "safety.incident.read")) return <SafetyForbidden title={listTitle} />;
  const result = await getIncident(id);
  if (problemCode(result.error) === "not_found") notFound();
  const incident = readOrFail(result, `/incidents/${id}`);
  if (!incident) return <SafetyForbidden title={listTitle} />;
  // The people we support on it, from the reader's own scope, for their names and communication
  // needs; without access to the people list they are named by kind ("A person we support").
  const api = await tenantApi();
  const list = await api.GET("/v1/people", { params: { query: {} } });
  const people = new Map((list.data?.items ?? []).map((p) => [p.id, p]));
  const names = new Map(
    [...people].map(([key, p]) => [key, sampleName(p, personNames(p).full, t)]),
  );
  const title = incidentTitle(incident, t);
  const location = me.locations.find((l) => l.id === incident.locationId);
  const author = (userId: string | null) =>
    userId ? t("safety.incident.who", { who: entryAuthor(userId, me.tenantUserId) }) : null;
  const section = (name: string) => t("safety.incident.section", { section: name });
  const notRecorded = t("common.notRecorded");
  const questions = incident.restricted ? 0 : incident.openQuestionCount;
  // The questions the viewer may answer here, as the API allows (ADR-0071): every one for a
  // manager, the point-of-care falls questions for the person who raised it.
  const answerable = questionsYouMayAnswer(incident.classifier?.openQuestions ?? [], {
    canReport: can(me.permissions, "safety.incident.report"),
    manages: can(me.permissions, "safety.incident.manage"),
    raisedByYou: incident.raisedBy === me.tenantUserId,
    closed: incident.status === "closed",
    restricted: incident.restricted,
  });
  const mayAnswer =
    can(me.permissions, "safety.incident.report") &&
    !incident.restricted &&
    incident.status !== "closed" &&
    (can(me.permissions, "safety.incident.manage") || incident.raisedBy === me.tenantUserId);
  // The duty of candour record and the investigation, for a reader who sees it whole (the API
  // refuses anyone else); the candour record's stage decides whether it can close.
  const [candour, investigation] = incident.restricted
    ? [null, null]
    : await Promise.all([
        api.GET("/v1/incidents/{id}/candour", { params: { path: { id } } }),
        api.GET("/v1/incidents/{id}/investigation", { params: { path: { id } } }),
      ]);
  // A read that failed is not known, never "none" (review M3): the sections warn and offer no
  // forms, and closing waits for the candour record to be read.
  const candourRecord = candour?.data?.record ?? null;
  const candourUnknown = candour !== null && !candour.data;
  const investigationRecord = investigation?.data?.record ?? null;
  const investigationUnknown = investigation !== null && !investigation.data;
  // Review and close, for a manager, never "close" for the person who raised it (rule 11).
  const manage = incidentManageView(incident, me, candourUnknown ? "unread" : candourRecord);
  const shownDone = doneToShow(done, incident.status);
  const followUpDone = followUpDoneToShow(
    done,
    candourRecord?.state ?? null,
    investigationRecord?.status ?? null,
  );
  const now = new Date();
  const overdue = overdueCount(incident.classifier);
  // RIDDOR's over-seven-day threshold for its label, from the rate table on the incident's date.
  const riddor = [
    ...(incident.classifier?.notifications ?? []),
    ...(incident.classifier?.outputs ?? []),
    ...(incident.classifier?.pending ?? []),
  ].some((n) => n.kind === "riddor_over_7_day");
  const threshold = riddor
    ? await api.GET("/v1/rates/{key}", {
        params: {
          path: { key: "riddor.over_7_day.threshold_days" },
          query: { on: ukToday(new Date(incident.occurredAt)) },
        },
      })
    : null;

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <nav aria-label={t("common.breadcrumb")} className="text-body-dense">
        <Link href="/incidents" className="underline">
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
        {...(evidenceManaged(me.permissions) && !incident.restricted
          ? {
              secondaryActions: (
                <Link
                  href={`/quality/evidence/tag?recordType=incident&recordId=${incident.id}`}
                  className={buttonClassName({ variant: "secondary" })}
                >
                  {t("quality.tag.fromRecord")}
                </Link>
              ),
            }
          : {})}
      />
      {recorded === "1" ? <RecordedArrival /> : null}
      {shownDone && recorded !== "1" ? (
        <RecordedArrival message={t("safety.manage.done", { done: shownDone })} param="done" />
      ) : null}
      {followUpDone && !shownDone && recorded !== "1" ? (
        <RecordedArrival
          message={t("safety.followUp.done", {
            done: followUpDone,
            state: candourRecord?.state ?? "none",
          })}
          param="done"
        />
      ) : null}
      <p className="m-0 flex flex-wrap items-center gap-2">
        <SafetyChip chip={incidentStatusChip(incident.status, t)} />
        {incident.restricted ? (
          <StatusChip status="info" label={t("safety.incident.restrictedChip")} icon={Lock} />
        ) : null}
        {questions > 0 ? (
          <StatusChip
            status="due"
            label={t("safety.incident.questionsChip", { count: questions })}
            icon={CircleAlert}
          />
        ) : null}
        {overdue > 0 ? (
          // A native link, so the browser moves focus to the section's heading (WCAG 2.4.3); named
          // with the chip's words first, so what is seen is what is said (WCAG 2.5.3).
          <a
            href="#notifications"
            aria-label={t("safety.incident.overdueLink", { count: overdue })}
            className="inline-flex min-h-target items-center"
          >
            <StatusChip
              status="overdue"
              label={t("safety.incident.overdueChip", { count: overdue })}
              icon={CircleAlert}
            />
          </a>
        ) : null}
        <EntryBadges entry={incident} />
      </p>
      {incident.restricted ? (
        <Notice icon={<Lock {...iconProps} />} title={t("safety.incident.restrictedNotice")}>
          {t("safety.incident.restrictedHint")}
        </Notice>
      ) : null}
      <Card
        as="section"
        title={section(incident.restricted ? "about" : "details")}
        headingLevel={2}
        className="break-words"
      >
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
      {showsPostFallCard(incident) ? (
        <Card as="section" title={t("safety.incident.postFall.title")} headingLevel={2}>
          <div className="flex max-w-prose flex-col gap-3">
            <p className="m-0">{t("safety.incident.postFall.intro")}</p>
            <p className="m-0 flex items-start gap-2 font-semibold">
              <CircleAlert
                size={20}
                strokeWidth={1.5}
                aria-hidden="true"
                className="mt-0.5 shrink-0"
              />
              {t("safety.incident.postFall.urgentAdvice")}
            </p>
            <p className="m-0">
              <Link href="/tasks">{t("safety.incident.postFall.link")}</Link>
              {" · "}
              <Link href="/tasks?status=closed">{t("safety.incident.postFall.finishedLink")}</Link>
            </p>
            <p className="m-0 text-body-dense text-text-secondary">
              {t("safety.incident.postFall.listHint")}
            </p>
          </div>
        </Card>
      ) : null}
      {incident.restricted ? null : (
        <Card as="section" aria-labelledby="notifications">
          <div className="flex flex-col gap-4">
            {/* Focusable, so the overdue link at the top brings focus here. */}
            <h2 id="notifications" tabIndex={-1} className="hb-card__title scroll-mt-nav">
              {section("notifications")}
            </h2>
            <IncidentNotifications
              classifier={incident.classifier}
              access={{
                canSubmit: can(me.permissions, "safety.notification.submit"),
                canManage: can(me.permissions, "safety.incident.manage"),
              }}
              names={names}
              {...(threshold?.data ? { riddorDays: threshold.data.value } : {})}
              closed={incident.status === "closed"}
              now={now}
              linked={can(me.permissions, "safety.incident.manage")}
              answerable={answerable.length}
            >
              {mayAnswer ? (
                <ClassifierQuestions incidentId={incident.id} questions={answerable} />
              ) : null}
            </IncidentNotifications>
          </div>
        </Card>
      )}
      <AfterDeath
        incident={incident}
        names={names}
        records={people}
        linked={can(me.permissions, "safety.incident.manage")}
        now={now}
      />
      <CandourSection
        incident={incident}
        record={candourRecord}
        unknown={candourUnknown}
        viewer={me}
        names={names}
        records={people}
        now={now}
      />
      <InvestigationSection
        incident={incident}
        record={investigationRecord}
        unknown={investigationUnknown}
        viewer={me}
        now={now}
      />
      {manage ? (
        <Card as="section" title={section("manage")} headingLevel={2} className="break-words">
          <IncidentManage
            incidentId={incident.id}
            version={incident.version}
            view={manage}
            notificationLabels={Object.fromEntries(
              (incident.classifier?.notifications ?? []).map((n) => [
                n.kind,
                notificationKindLabel(n.kind, t, threshold?.data?.value),
              ]),
            )}
            personNames={Object.fromEntries(names)}
          />
        </Card>
      ) : null}
      <Card as="section" title={section("people")} headingLevel={2} className="break-words">
        {incident.people.length === 0 ? (
          <p className="m-0">
            {t("safety.incident.noPeople", { restricted: String(incident.restricted) })}
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {incident.people.map((person) => {
              const record = person.personId ? people.get(person.personId) : undefined;
              return (
                <li key={person.id} className="flex flex-col gap-1 border-b border-border pb-3">
                  <span className="font-semibold">{incidentPersonLine(person, names, t)}</span>
                  {record ? (
                    // Labelled in every state, so "Not recorded" says what is missing (AIS).
                    <dl className="m-0 flex flex-wrap items-start gap-x-2 gap-y-1">
                      <dt className="text-body-dense font-semibold">
                        {t("people.header.communicationNeeds")}
                      </dt>
                      <dd className="m-0">
                        <CommunicationStatus
                          summary={communicationSummary(record, t)}
                          flagLabel={t("people.header.communicationNeeds")}
                          compact
                        />
                      </dd>
                    </dl>
                  ) : null}
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
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
