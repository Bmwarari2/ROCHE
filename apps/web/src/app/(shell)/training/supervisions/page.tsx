import { Button, Card, Checkbox, EmptyState, PageHeader, SelectField } from "@harbour/ui";
import { CalendarClock } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import {
  byMeetingUrgency,
  developmentShown,
  meetingChip,
  meetingCounts,
  ukDate,
} from "@/lib/development";
import { t } from "@/lib/i18n";
import { firstParam } from "@/lib/record-metadata";

export const metadata: Metadata = { title: t("development.supervisionsDue.title") };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Supervisions and appraisals due across staff (WORK-009; workforce.md rule 7): each member's next
 * supervision and appraisal, as an icon and a word, with when it falls due and when the last was
 * held, most urgent first; filtered by home and to those needing attention. Each name opens the
 * member's training record, where a supervision is recorded. The same readers as the matrix.
 */
export default async function SupervisionsDuePage({
  searchParams,
}: {
  readonly searchParams: SearchParams;
}) {
  const { me } = await getShellContext();
  const title = t("development.supervisionsDue.title");
  if (!developmentShown(me.permissions)) return <SafetyForbidden title={title} />;
  const raw = await searchParams;
  const locationId = firstParam(raw.location);
  const attention = firstParam(raw.attention) === "yes";
  const api = await tenantApi();
  const due = await api.GET("/v1/workforce/supervisions-due", {
    params: {
      query: {
        ...(locationId && isUuid(locationId) ? { locationId } : {}),
        ...(attention ? { attention: "true" as const } : {}),
      },
    },
  });
  if (!due.data) failWith(due.error, due.response, "/training/supervisions");
  const { asOf, dueWindowDays, truncated } = due.data;
  const members = byMeetingUrgency(
    due.data.members.flatMap((m) => (m.member ? [{ ...m, member: m.member }] : [])),
  );
  const counts = meetingCounts(members);
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={me.tenant.name}
        title={title}
        description={t("development.supervisionsDue.description", {
          date: ukDate(asOf),
          days: dueWindowDays,
        })}
      />
      <p className="m-0">
        <Link href="/training" className="inline-flex min-h-target items-center underline">
          {t("development.supervisionsDue.back")}
        </Link>
      </p>
      <Card as="section" title={t("development.supervisionsDue.filter")} headingLevel={2}>
        <form
          method="get"
          action="/training/supervisions"
          className="flex flex-wrap items-end gap-4"
        >
          <SelectField
            name="location"
            label={t("development.matrix.location")}
            emptyOption={t("development.matrix.anyLocation")}
            defaultValue={locationId ?? ""}
            options={me.locations.map((l) => ({ value: l.id, label: l.name }))}
            className="min-w-56"
          />
          <Checkbox
            name="attention"
            value="yes"
            label={t("development.supervisionsDue.attention")}
            defaultChecked={attention}
          />
          <Button type="submit" variant="secondary">
            {t("development.supervisionsDue.apply")}
          </Button>
        </form>
      </Card>
      <p className="m-0 text-body-dense" aria-live="polite">
        {t("development.supervisionsDue.summary", {
          members: members.length,
          overdue: counts.overdue,
          due: counts.due,
          none: counts.none_recorded,
        })}
      </p>
      {truncated ? (
        <p className="m-0 text-body-dense font-semibold">
          {t("development.supervisionsDue.truncated")}
        </p>
      ) : null}
      {members.length === 0 ? (
        <Card>
          <EmptyState
            headingLevel={2}
            icon={<CalendarClock size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("development.supervisionsDue.empty")}
            description={t("development.supervisionsDue.emptyHint")}
          />
        </Card>
      ) : (
        <section aria-label={t("development.supervisionsDue.caption")}>
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {members.map((m) => (
              <li key={m.member.id}>
                <Card>
                  <div className="flex flex-col gap-3">
                    <h2 className="m-0 text-body font-semibold">
                      <Link
                        href={`/training/${m.member.id}`}
                        className="inline-flex min-h-target items-center underline"
                      >
                        {m.member.displayName}
                      </Link>
                      {m.member.jobTitle ? (
                        <span className="ms-2 font-normal text-text-secondary">
                          {m.member.jobTitle}
                        </span>
                      ) : null}
                    </h2>
                    <dl className="m-0 grid gap-3 sm:grid-cols-3">
                      {m.meetings.map((meeting) => (
                        <div key={meeting.kind} className="flex flex-col gap-1">
                          <dt className="font-semibold">
                            {t("development.supervisionsDue.kind", { kind: meeting.kind })}
                          </dt>
                          <dd className="m-0 flex flex-col gap-1">
                            <span>
                              <SafetyChip chip={meetingChip(meeting.state, t)} />
                            </span>
                            <span className="text-body-dense">
                              {meeting.dueOn
                                ? t("development.supervisionsDue.dueOn", {
                                    date: ukDate(meeting.dueOn),
                                  })
                                : t("development.supervisionsDue.noneHeld")}
                            </span>
                            {meeting.lastHeldOn ? (
                              <span className="text-body-dense text-text-secondary">
                                {t("development.supervisionsDue.lastHeld", {
                                  date: ukDate(meeting.lastHeldOn),
                                })}
                              </span>
                            ) : null}
                          </dd>
                        </div>
                      ))}
                      <div className="flex flex-col gap-1">
                        <dt className="font-semibold">
                          {t("development.supervisionsDue.spotCheck")}
                        </dt>
                        <dd className="m-0 text-body-dense">
                          {m.lastSpotCheckOn
                            ? ukDate(m.lastSpotCheckOn)
                            : t("development.supervisionsDue.noSpotCheck")}
                        </dd>
                      </div>
                    </dl>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
