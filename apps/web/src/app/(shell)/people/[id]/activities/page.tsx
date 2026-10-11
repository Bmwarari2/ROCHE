import { Card } from "@harbour/ui";
import { ActivityForm } from "@/components/care/ActivityForm";
import { EntryBadges } from "@/components/care/EntryBadges";
import { NoAccess } from "@/components/care/NoAccess";
import { VisitForm } from "@/components/care/VisitForm";
import { WindowNote } from "@/components/care/WindowNote";
import { getShellContext, tenantApi } from "@/lib/api";
import { can, entryAuthor, readingWindow, tabHref, windowStart } from "@/lib/care-record";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { personNames } from "@/lib/people";
import { getPerson, readOrFail } from "@/lib/person-record";
import { formatUkTime, ukDateTimeInput } from "@/lib/uk-time";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * The activities and visits tab (register row CARE-014): what the person took part in and how,
 * and the Regulation 9A visiting log, with forms for staff who write the daily record.
 */
export default async function ActivitiesPage({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id } = await params;
  const { person } = await getPerson(id);
  if (!person) return null;
  const { me } = await getShellContext();
  if (!can(me.permissions, "care.note.read")) return <NoAccess />;
  const days = readingWindow((await searchParams).days);
  const path = tabHref(id, "activities");
  const from = windowStart(days);
  const api = await tenantApi();
  const [activities, visits] = await Promise.all([
    api
      .GET("/v1/people/{id}/activities", { params: { path: { id }, query: { from } } })
      .then((r) => readOrFail(r, path)),
    api
      .GET("/v1/people/{id}/visits", { params: { path: { id }, query: { from } } })
      .then((r) => readOrFail(r, path)),
  ]);
  if (!activities || !visits) return <NoAccess />;
  const names = personNames(person);
  const canWrite = can(me.permissions, "care.note.write");
  const nowLocal = ukDateTimeInput();
  const by = (recordedBy: string | null) =>
    t("care.entry.recordedBy", { who: entryAuthor(recordedBy, me.tenantUserId) });

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-eyebrow">{t("care.activities.title")}</h2>
        <p className="m-0 text-text-secondary">
          {t("care.activities.description", { name: names.preferred })}
        </p>
      </div>
      <WindowNote days={days} href={path} />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <section aria-labelledby="activities-list" className="flex min-w-0 flex-col gap-3">
          <h3 id="activities-list" className="m-0 text-intro font-semibold">
            {t("care.activities.list.title")}
          </h3>
          {canWrite ? (
            <Card as="section" title={t("care.activities.form.title")} headingLevel={4}>
              <ActivityForm personId={id} nowLocal={nowLocal} name={names.preferred} />
            </Card>
          ) : null}
          {activities.items.length === 0 ? (
            <p className="m-0 text-text-secondary">{t("care.activities.empty", { days })}</p>
          ) : (
            <ol
              aria-label={t("care.activities.list.label", { name: names.preferred })}
              className="hb-long-list m-0 flex list-none flex-col gap-2 p-0"
            >
              {activities.items.map((item) => (
                <li
                  key={item.id}
                  className="flex flex-col gap-1 rounded-input border border-border px-4 py-3"
                >
                  <p className="m-0 flex flex-wrap items-center gap-2 text-callout text-text-secondary">
                    <time
                      dateTime={item.occurredAt}
                      className="font-semibold text-text tabular-nums"
                    >
                      {formatDateTime(item.occurredAt)}
                    </time>
                    <span>{by(item.recordedBy)}</span>
                    <EntryBadges entry={item} />
                  </p>
                  <p className="m-0 font-semibold">{item.activity}</p>
                  <p className="m-0 flex flex-wrap gap-x-4 text-callout">
                    <span>{t("care.activities.formatOption", { format: item.format })}</span>
                    <span>
                      {t("care.activities.attendanceOption", { attendance: item.attendance })}
                    </span>
                    {item.engagement ? (
                      <span>
                        {t("care.activities.engagementOption", { engagement: item.engagement })}
                      </span>
                    ) : null}
                    {item.durationMinutes ? (
                      <span>
                        {t("care.activities.duration", { minutes: item.durationMinutes })}
                      </span>
                    ) : null}
                  </p>
                  {item.notes ? <p className="m-0 whitespace-pre-line">{item.notes}</p> : null}
                </li>
              ))}
            </ol>
          )}
        </section>
        <section aria-labelledby="visits-list" className="flex min-w-0 flex-col gap-3">
          <h3 id="visits-list" className="m-0 text-intro font-semibold">
            {t("care.visits.list.title")}
          </h3>
          {canWrite ? (
            <Card as="section" title={t("care.visits.form.title")} headingLevel={4}>
              <VisitForm personId={id} nowLocal={nowLocal} name={names.preferred} />
            </Card>
          ) : null}
          {visits.items.length === 0 ? (
            <p className="m-0 text-text-secondary">{t("care.visits.empty", { days })}</p>
          ) : (
            <ol
              aria-label={t("care.visits.list.label", { name: names.preferred })}
              className="hb-long-list m-0 flex list-none flex-col gap-2 p-0"
            >
              {visits.items.map((item) => (
                <li
                  key={item.id}
                  className="flex flex-col gap-1 rounded-input border border-border px-4 py-3"
                >
                  <p className="m-0 flex flex-wrap items-center gap-2 text-callout text-text-secondary">
                    <time
                      dateTime={item.occurredAt}
                      className="font-semibold text-text tabular-nums"
                    >
                      {formatDateTime(item.occurredAt)}
                    </time>
                    {item.endedAt ? (
                      <span>
                        {t("care.visits.until", { time: formatUkTime(item.endedAt) ?? "" })}
                      </span>
                    ) : null}
                    <span>{by(item.recordedBy)}</span>
                    <EntryBadges entry={item} />
                  </p>
                  <p className="m-0 font-semibold">
                    {t("care.visits.kindShort", { kind: item.kind })}
                  </p>
                  {item.visitorName ? (
                    <p className="m-0">
                      {item.visitorRelationship
                        ? t("care.visits.withRelationship", {
                            visitor: item.visitorName,
                            relationship: item.visitorRelationship,
                          })
                        : t("care.visits.with", { visitor: item.visitorName })}
                    </p>
                  ) : null}
                  {item.restrictionsApplied ? (
                    <p className="m-0 font-semibold">
                      {t("care.visits.restriction", {
                        reason: item.restrictionReason ?? t("common.notRecorded"),
                      })}
                    </p>
                  ) : null}
                  {item.notes ? <p className="m-0 whitespace-pre-line">{item.notes}</p> : null}
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </>
  );
}
