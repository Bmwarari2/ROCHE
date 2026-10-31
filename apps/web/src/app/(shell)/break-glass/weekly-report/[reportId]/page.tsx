import { Card, PageHeader } from "@harbour/ui";
import { TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { Notice } from "@/components/care/Notice";
import { BreakGlassReview } from "@/components/platform/BreakGlassReview";
import { CountTable } from "@/components/platform/CountTable";
import { PersonNeeds } from "@/components/safety/PersonNeeds";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import {
  breakGlassReportShown,
  flagChip,
  flagCount,
  flagSentence,
  flagsText,
  listHref,
  personNamer,
  type ReasonLine,
  readSummary,
  reportEntries,
  reportHref,
  reportPersonIds,
  reportWeek,
  reviewChip,
  reviewOffer,
  staffNamer,
  weekParam,
} from "@/lib/break-glass-report";
import { isUuid } from "@/lib/context-cookies";
import { formatDate, formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { personNames, sampleName } from "@/lib/people";
import { firstParam } from "@/lib/record-metadata";

type Params = Promise<{ reportId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata: Metadata = { title: t("breakGlassReport.detailTitle") };

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <Card as="section" headingLevel={2} title={title}>
      <div className="flex flex-col gap-4">{children}</div>
    </Card>
  );
}

function ReasonTable({
  caption,
  lines,
  header,
}: {
  readonly caption: string;
  readonly lines: readonly ReasonLine[];
  readonly header: string;
}) {
  return (
    <CountTable
      caption={caption}
      columns={[
        { id: "reason", header: t("breakGlassReport.column.reason") },
        { id: "count", header, numeric: true },
      ]}
      rows={lines.map((line) => ({
        id: line.reason,
        cells: {
          reason: t("breakGlassReport.reason", { reason: line.reason }),
          count: line.events,
        },
      }))}
    />
  );
}

/**
 * One location's weekly break-glass report (PLAT-006; people.md rule 14; hazard HZ-011): the week's
 * totals, what it flags in words (repeated use, the same person opened again, a person opened by
 * many), the records opened by member of staff, by person and by reason, the break-glass searches,
 * and its review. Staff are named from the report, people from the reader's own list (others are
 * numbered). The report holds counts and opaque ids: each typed reason stays in the audit log. The
 * review form is offered once, to a reader the report does not flag; the API checks it all again.
 */
export default async function BreakGlassReportPage({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { me } = await getShellContext();
  const listTitle = t("breakGlassReport.title");
  if (!breakGlassReportShown(me.permissions)) return <SafetyForbidden title={listTitle} />;
  const { reportId } = await params;
  if (!isUuid(reportId)) notFound();
  const query = await searchParams;
  const week = weekParam(query.week);
  const api = await tenantApi();
  const { data, error, response } = await api.GET("/v1/break-glass/weekly-report", {
    params: { query: week ? { week } : {} },
  });
  if (!data) {
    if (problemCode(error) === "missing_permission") return <SafetyForbidden title={listTitle} />;
    return failWith(error, response, listHref(week));
  }
  const entry = reportEntries(data.items).find((e) => e.report.id === reportId);
  if (!entry) notFound();
  const { report, review } = entry;
  const shown = reportWeek(data);
  const path = reportHref(report.id, shown.monday);
  const summary = readSummary(report.summary);
  const staff = staffNamer([...report.staff, ...(review?.staff ?? [])], t);
  // The reader's own people, by name; anyone else the report counts is numbered.
  const people = await api.GET("/v1/people", { params: { query: {} } });
  const known = new Map((people.data?.items ?? []).map((p) => [p.id, p]));
  const names = new Map(
    [...known].map(([id, p]) => [id, sampleName(p, personNames(p).full, t)] as const),
  );
  const person = personNamer(reportPersonIds(summary), names, t);
  // Communication needs beside each person named (AIS), as on the other governance pages.
  const named = summary.byPerson.flatMap((line) => {
    const summaryOf = known.get(line.personId);
    return summaryOf ? [summaryOf] : [];
  });
  const location = me.locations.find((l) => l.id === report.locationId);
  const locationName = location?.name ?? t("breakGlassReport.locationHidden");
  const range = t("breakGlassReport.week", {
    monday: formatDate(shown.monday) ?? shown.monday,
    sunday: formatDate(shown.sunday) ?? shown.sunday,
  });
  const flags = flagChip(flagCount(summary), t);
  const offer = reviewOffer(entry, summary, me.tenantUserId);
  const done = firstParam(query.done) === "reviewed" && review;
  const hidden = summary.byPerson.some((p) => !names.has(p.personId));

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <nav aria-label={t("common.breadcrumb")} className="text-body-dense">
        <Link
          href={listHref(shown.monday)}
          className="inline-flex min-h-target items-center underline"
        >
          {listTitle}
        </Link>
        <span aria-hidden="true" className="px-2 text-text-secondary">
          ›
        </span>
        <span aria-current="page">{locationName}</span>
      </nav>
      <PageHeader eyebrow={locationName} title={listTitle} description={range} />
      {done ? <RecordedArrival message={t("breakGlassReport.review.done")} param="done" /> : null}
      <p className="m-0 flex flex-wrap items-center gap-2">
        <SafetyChip chip={reviewChip(entry, t)} />
        {flags ? <SafetyChip chip={flags} /> : null}
      </p>
      {summary.unreadable ? (
        <Notice
          tone="warning"
          icon={<TriangleAlert size={20} strokeWidth={1.5} aria-hidden="true" />}
          title={t("breakGlassReport.unreadable")}
        />
      ) : null}

      <Section title={t("breakGlassReport.summary.title")}>
        <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-[max-content_1fr]">
          {(
            [
              ["opened", summary.totalEvents],
              ["staff", summary.distinctUsers],
              ["people", summary.distinctPeople],
              ["searches", summary.searches.total],
            ] as const
          ).map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="font-semibold">{t("breakGlassReport.summary.term", { key })}</dt>
              <dd className="m-0 tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="m-0 text-body-dense text-text-secondary">
          {t("breakGlassReport.summary.generated", {
            dateTime: formatDateTime(report.generatedAt) ?? "",
            threshold: report.repeatThreshold,
          })}
        </p>
        <p className="m-0 text-body-dense text-text-secondary">
          {t("breakGlassReport.summary.reasons")}
        </p>
      </Section>

      <Section title={t("breakGlassReport.flags.title")}>
        {summary.flagged.length === 0 ? (
          <p className="m-0">{t("breakGlassReport.flags.none")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {summary.flagged.map((line) => (
              <li
                key={`${line.flag}-${line.tenantUserId ?? ""}-${line.personId ?? ""}`}
                className="flex items-start gap-2"
              >
                <TriangleAlert
                  size={18}
                  strokeWidth={1.5}
                  aria-hidden="true"
                  className="mt-0.5 shrink-0"
                />
                <span>{flagSentence(line, report.repeatThreshold, staff, person, t)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={t("breakGlassReport.opened.title")}>
        {summary.totalEvents === 0 && summary.byUser.length === 0 ? (
          <p className="m-0">{t("breakGlassReport.opened.none")}</p>
        ) : (
          <>
            <CountTable
              caption={t("breakGlassReport.byUser.caption")}
              columns={[
                { id: "who", header: t("breakGlassReport.column.staff") },
                { id: "events", header: t("breakGlassReport.column.opened"), numeric: true },
                { id: "people", header: t("breakGlassReport.column.people"), numeric: true },
                { id: "flags", header: t("breakGlassReport.column.flags") },
              ]}
              rows={summary.byUser.map((line) => ({
                id: line.tenantUserId,
                cells: {
                  who: staff(line.tenantUserId),
                  events: line.events,
                  people: line.people,
                  flags: flagsText(line.flags, t),
                },
              }))}
            />
            {hidden ? <p className="m-0">{t("breakGlassReport.numbered")}</p> : null}
            <CountTable
              caption={t("breakGlassReport.byPerson.caption")}
              columns={[
                { id: "whom", header: t("breakGlassReport.column.person") },
                { id: "events", header: t("breakGlassReport.column.times"), numeric: true },
                { id: "users", header: t("breakGlassReport.column.staffCount"), numeric: true },
                { id: "flags", header: t("breakGlassReport.column.flags") },
              ]}
              rows={summary.byPerson.map((line) => ({
                id: line.personId,
                cells: {
                  whom: person(line.personId),
                  events: line.events,
                  users: line.users,
                  flags: flagsText(line.flags, t),
                },
              }))}
            />
            {named.length > 0 ? (
              <ul
                aria-label={t("breakGlassReport.needs")}
                className="m-0 flex list-none flex-col gap-2 p-0"
              >
                {named.map((p) => (
                  <li key={p.id} className="flex flex-col gap-1">
                    <span className="font-semibold">{names.get(p.id)}</span>
                    <PersonNeeds person={p} />
                  </li>
                ))}
              </ul>
            ) : null}
            <ReasonTable
              caption={t("breakGlassReport.byReason.caption")}
              header={t("breakGlassReport.column.times")}
              lines={summary.byReason}
            />
          </>
        )}
      </Section>

      <Section title={t("breakGlassReport.searches.title")}>
        {summary.searches.total === 0 && summary.searches.byUser.length === 0 ? (
          <p className="m-0">{t("breakGlassReport.searches.none")}</p>
        ) : (
          <>
            <p className="m-0">{t("breakGlassReport.searches.about")}</p>
            <CountTable
              caption={t("breakGlassReport.searches.byUser")}
              columns={[
                { id: "who", header: t("breakGlassReport.column.staff") },
                { id: "searches", header: t("breakGlassReport.column.searches"), numeric: true },
                { id: "flags", header: t("breakGlassReport.column.flags") },
              ]}
              rows={summary.searches.byUser.map((line) => ({
                id: line.tenantUserId,
                cells: {
                  who: staff(line.tenantUserId),
                  searches: line.searches,
                  flags: flagsText(line.flags, t),
                },
              }))}
            />
            <ReasonTable
              caption={t("breakGlassReport.searches.byReason")}
              header={t("breakGlassReport.column.searches")}
              lines={summary.searches.byReason}
            />
          </>
        )}
      </Section>

      <Section title={t("breakGlassReport.review.title")}>
        {review ? (
          <>
            <p className="m-0">
              {t("breakGlassReport.review.by", {
                name: staff(review.reviewedBy),
                dateTime: formatDateTime(review.reviewedAt) ?? "",
              })}
            </p>
            <h3 className="m-0 text-body font-semibold">{t("breakGlassReport.review.actions")}</h3>
            <p className="m-0 whitespace-pre-line break-words">{review.actionsTaken}</p>
          </>
        ) : offer.kind === "own" ? (
          <p className="m-0">{t("breakGlassReport.review.own")}</p>
        ) : (
          <>
            <p className="m-0 max-w-prose">{t("breakGlassReport.review.intro")}</p>
            <BreakGlassReview reportId={report.id} path={path} />
          </>
        )}
      </Section>
    </div>
  );
}
