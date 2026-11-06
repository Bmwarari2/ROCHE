import { Card, PageHeader } from "@harbour/ui";
import { CircleAlert, Clock, Send, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Notice } from "@/components/care/Notice";
import { PersonNeeds } from "@/components/safety/PersonNeeds";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { AutoRefresh } from "@/components/safety-events/AutoRefresh";
import { CloseEpisodeForm, TimelineEntryForm } from "@/components/safety-events/MissingForms";
import { SiloStatus } from "@/components/safety-events/SiloStatus";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import {
  kindsFor,
  MISSING_MANAGE,
  missingShown,
  missingStatusChip,
  policeCallState,
} from "@/lib/missing";
import { personNames } from "@/lib/people";
import { getPerson } from "@/lib/person-record";

export const metadata: Metadata = { title: t("missing.episodeTitle") };

const noticeIcon = { size: 20, strokeWidth: 1.5, "aria-hidden": true } as const;

/**
 * One missing person episode (SAFE-015; HZ-127). The police call comes first: its target, overdue
 * or call now in words, or the reference once called. Then who it is, the timeline oldest first,
 * adding to it, the CQC notification prompt and the incident's notifications as links to the
 * notification centre (never completed here), the Herbert Protocol profile, and closing.
 */
export default async function EpisodePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { me } = await getShellContext();
  const title = t("missing.episodeTitle");
  if (!missingShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const { data, error, response } = await api.GET("/v1/missing-episodes/{id}", {
    params: { path: { id } },
  });
  if (!data) {
    if (problemCode(error) === "missing_permission") return <SafetyForbidden title={title} />;
    if (response.status === 404) notFound();
    return failWith(error, response, `/missing/${id}`);
  }
  const { person } = await getPerson(data.personId);
  const police = policeCallState(data);
  const due = formatDateTime(data.policeCallDueAt) ?? "";
  const kinds = data.status === "closed" ? [] : kindsFor(me.permissions);
  const timeline = [...data.timeline].sort((a, b) => a.at.localeCompare(b.at));
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <SiloStatus />
      <AutoRefresh active={data.status === "open"} />
      <PageHeader
        title={person ? t("missing.itemTitle", { name: personNames(person).full }) : title}
      />
      <Notice
        tone={police === "called" || police === "not_needed" ? "info" : "warning"}
        icon={
          police === "overdue" || police === "missed" ? (
            <CircleAlert {...noticeIcon} />
          ) : police === "now" ? (
            <TriangleAlert {...noticeIcon} />
          ) : police === "called" ? (
            <Send {...noticeIcon} />
          ) : (
            <Clock {...noticeIcon} />
          )
        }
        title={t("missing.police.title", { state: police, when: due })}
      >
        <p className="m-0">
          {police === "called"
            ? t("missing.police.reference", { reference: data.policeReference ?? "" })
            : t("missing.police.body", { state: police, when: due })}
        </p>
      </Notice>
      {data.immediateRisk ? (
        <Notice
          tone="warning"
          icon={<TriangleAlert {...noticeIcon} />}
          title={t("missing.immediateRisk")}
        />
      ) : null}
      <p className="m-0 flex flex-wrap gap-2">
        <SafetyChip chip={missingStatusChip(data.status, t)} />
      </p>
      {person ? (
        <Card as="section" headingLevel={2} title={personNames(person).full}>
          <PersonNeeds person={person} />
        </Card>
      ) : null}
      <Card as="section" headingLevel={2} title={t("missing.timeline.title")}>
        {timeline.length === 0 ? (
          <p className="m-0">{t("missing.timeline.empty")}</p>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-3 p-0">
            {timeline.map((entry) => (
              <li key={entry.id} className="flex flex-col gap-1 border-s-2 border-border ps-3">
                <p className="m-0 font-semibold">
                  {t("missing.timeline.kindLabel", { kind: entry.kind })}
                  {" · "}
                  {formatDateTime(entry.at)}
                </p>
                {entry.reference ? (
                  <p className="m-0 text-body-dense">
                    {t("missing.timeline.referenceShown", { reference: entry.reference })}
                  </p>
                ) : null}
                {entry.area ? (
                  <p className="m-0 text-body-dense">
                    {t("missing.timeline.areaShown", { area: entry.area })}
                  </p>
                ) : null}
                {entry.note ? <p className="m-0 whitespace-pre-wrap">{entry.note}</p> : null}
              </li>
            ))}
          </ol>
        )}
      </Card>
      {kinds.length > 0 ? (
        <Card as="section" headingLevel={2} title={t("missing.timeline.add")}>
          <TimelineEntryForm episodeId={data.id} kinds={kinds} />
        </Card>
      ) : null}
      <Card as="section" headingLevel={2} title={t("missing.notifications.title")}>
        <div className="flex flex-col gap-3">
          {data.cqcNotificationPrompt ? (
            <p className="m-0 font-semibold">{t("missing.notifications.cqcPrompt")}</p>
          ) : null}
          {data.notifications.length === 0 ? (
            <p className="m-0">{t("missing.notifications.none")}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {data.notifications.map((n) => (
                <li key={n.id}>
                  <Link
                    href={`/notifications/statutory/${n.id}`}
                    className="inline-flex min-h-target items-center underline"
                  >
                    {t("missing.notifications.link", {
                      kind: t("safety.notification.kind", { kind: n.kind }),
                      status: t("safety.notification.status", { status: n.status }),
                    })}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <p className="m-0">
            <Link
              href={`/incidents/${data.incidentId}`}
              className="inline-flex min-h-target items-center underline"
            >
              {t("missing.incidentLink")}
            </Link>
          </p>
        </div>
      </Card>
      <Card as="section" headingLevel={2} title={t("missing.herbert.title")}>
        <div className="flex flex-col gap-2">
          <p className="m-0">{t("missing.herbert.state", { state: data.herbertProfile })}</p>
          <p className="m-0">
            <Link
              href={`/people/${data.personId}/herbert`}
              className="inline-flex min-h-target items-center underline"
            >
              {t("missing.herbert.link")}
            </Link>
          </p>
        </div>
      </Card>
      {data.status !== "closed" && me.permissions.includes(MISSING_MANAGE) ? (
        <Card as="section" headingLevel={2} title={t("missing.close.title")}>
          {data.canClose ? (
            <CloseEpisodeForm episodeId={data.id} version={data.version} />
          ) : (
            <div className="flex flex-col gap-2">
              <p className="m-0">{t("missing.close.needsIntro")}</p>
              <ul className="m-0 flex flex-col gap-1 ps-5">
                {data.closeProblems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      ) : null}
    </div>
  );
}
