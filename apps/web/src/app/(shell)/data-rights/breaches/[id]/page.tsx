import { Card, StatusChip } from "@harbour/ui";
import { Lightbulb } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  AcknowledgeNotice,
  AssessBreachForm,
  CloseBreachForm,
  DecideBreachForm,
  ReportBreachForm,
  TellIndividualsForm,
} from "@/components/breaches/BreachForms";
import { DataRightsFrame } from "@/components/data-rights/DataRightsFrame";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import {
  type Breach,
  breachChip,
  breachClockWords,
  breachForms,
  breachPath,
  FACTOR_FLAGS,
  noticeNumbers,
  suggestionWords,
} from "@/lib/breaches";
import { isUuid } from "@/lib/context-cookies";
import { BREACHES_PAGE, dataRightsShown } from "@/lib/data-rights";
import { formatDate, formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { firstParam } from "@/lib/record-metadata";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata: Metadata = { title: t("dataRights.breach.detail.title") };

const DONE = new Set([
  "recorded",
  "assessed",
  "decided",
  "reported",
  "told",
  "closed",
  "acknowledged",
]);

/** A label and its value, as one row of a description list. */
function Row({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-body-dense font-semibold">{label}</dt>
      <dd className="m-0 whitespace-pre-wrap break-words">{value}</dd>
    </div>
  );
}

function Facts({ breach }: { readonly breach: Breach }) {
  return (
    <dl className="m-0 flex flex-col gap-3">
      <Row label={t("dataRights.breach.detail.summary")} value={breach.summary} />
      <Row
        label={t("dataRights.breach.detail.aware")}
        value={formatDateTime(breach.awareAt) ?? ""}
      />
      <Row
        label={t("dataRights.breach.detail.occurred")}
        value={formatDateTime(breach.occurredAt) ?? t("dataRights.breach.detail.notKnown")}
      />
      <Row
        label={t("dataRights.breach.detail.source")}
        value={t("dataRights.breach.source", { source: breach.source })}
      />
    </dl>
  );
}

/**
 * One breach (PLAT-022; platform.md rules 19 to 24; breach-response.md): its ICO clock in words,
 * the facts, Thapsus's notices with an acknowledgement, and each step of the procedure: the
 * assessment factors, Harbour's suggestion as decision support only, the person's decision with
 * reasons, the ICO report, the notice to the people affected and closure with lessons. Each form
 * is offered only while it applies; the API checks every rule again.
 */
export default async function BreachPage({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { me } = await getShellContext();
  const listTitle = t("dataRights.breaches.title");
  if (!dataRightsShown(me)) {
    return <SafetyForbidden title={listTitle} hint={t("dataRights.orgWideOnly")} />;
  }
  const path = breachPath(id);
  const api = await tenantApi();
  const read = await api.GET("/v1/data-protection/breaches/{id}", { params: { path: { id } } });
  if (read.response.status === 404) notFound();
  if (!read.data) failWith(read.error, read.response, path);
  const breach = read.data;
  const forms = breachForms(breach);
  let draft = "";
  if (forms.tell) {
    const drafted = await api.GET("/v1/data-protection/breaches/{id}/subject-notice-draft", {
      params: { path: { id } },
    });
    if (!drafted.data) failWith(drafted.error, drafted.response, path);
    draft = drafted.data.notice;
  }
  const done = firstParam((await searchParams).done);
  const clock = breachClockWords(breach, t);
  const chip = breachChip(breach, t);
  const suggestion = breach.suggestion ? suggestionWords(breach.suggestion, t) : null;
  const { decision, report, individuals } = breach;

  return (
    <DataRightsFrame
      tab="breaches"
      title={t("dataRights.breach.detail.title")}
      eyebrow={me.tenant.name}
    >
      <nav aria-label={t("common.breadcrumb")} className="text-body-dense">
        <Link href={BREACHES_PAGE} className="inline-flex min-h-target items-center underline">
          {listTitle}
        </Link>
      </nav>
      {done && DONE.has(done) ? (
        <RecordedArrival message={t("dataRights.breach.done", { done })} param="done" />
      ) : null}

      <Card as="section" title={t("dataRights.breach.detail.standing")} headingLevel={2}>
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip status={chip.status} label={chip.label} />
            <StatusChip status={clock.status} label={clock.label} />
          </div>
          <p className="m-0">{clock.words}</p>
          <Facts breach={breach} />
        </div>
      </Card>

      {breach.notices.length > 0 ? (
        <Card as="section" title={t("dataRights.breach.notice.title")} headingLevel={2}>
          <ul className="m-0 flex list-none flex-col gap-6 p-0">
            {breach.notices.map((notice) => {
              const numbers = noticeNumbers(notice, t);
              return (
                <li key={notice.id} className="flex flex-col gap-3">
                  <h3 className="m-0 text-body font-semibold">
                    {t("dataRights.breach.notice.sent", {
                      at: formatDateTime(notice.sentAt) ?? "",
                      followUp: notice.followsId ? "yes" : "no",
                    })}
                  </h3>
                  <dl className="m-0 flex flex-col gap-3">
                    <Row label={t("dataRights.breach.notice.nature")} value={notice.nature} />
                    <Row
                      label={t("dataRights.breach.notice.categories")}
                      value={notice.dataCategories}
                    />
                    {numbers ? (
                      <Row label={t("dataRights.breach.notice.howMany")} value={numbers} />
                    ) : null}
                    <Row
                      label={t("dataRights.breach.notice.consequences")}
                      value={notice.likelyConsequences}
                    />
                    <Row label={t("dataRights.breach.notice.measures")} value={notice.measures} />
                    <Row
                      label={t("dataRights.breach.notice.actions")}
                      value={notice.tenantActions}
                    />
                    <Row label={t("dataRights.breach.notice.contact")} value={notice.contact} />
                  </dl>
                  {notice.acknowledgedAt ? (
                    <StatusChip
                      status="done"
                      label={t("dataRights.breach.notice.acknowledged", {
                        at: formatDateTime(notice.acknowledgedAt) ?? "",
                      })}
                    />
                  ) : (
                    <AcknowledgeNotice breachId={breach.id} noticeId={notice.id} />
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}

      {breach.factors || forms.assess ? (
        <Card as="section" title={t("dataRights.breach.assess.title")} headingLevel={2}>
          <div className="flex flex-col gap-4">
            {breach.factors && !forms.assess ? (
              <ul className="m-0 flex flex-col gap-1 ps-5">
                <li>
                  {t("dataRights.breach.assess.peopleCount", {
                    count: breach.factors.peopleAffected,
                  })}
                </li>
                {FACTOR_FLAGS.map((flag) => (
                  <li key={flag}>
                    {t("dataRights.breach.factorAnswer", {
                      factor: flag,
                      answer: breach.factors?.[flag] ? "yes" : "no",
                    })}
                  </li>
                ))}
              </ul>
            ) : null}
            {forms.assess ? (
              <>
                <p className="m-0">{t("dataRights.breach.assess.about")}</p>
                <AssessBreachForm
                  key={breach.version}
                  id={breach.id}
                  version={breach.version}
                  factors={breach.factors}
                />
              </>
            ) : null}
          </div>
        </Card>
      ) : null}

      {suggestion ? (
        <Card as="section" title={t("dataRights.breach.suggestion.title")} headingLevel={2}>
          <div role="note" className="flex gap-3">
            <Lightbulb size={18} strokeWidth={1.5} aria-hidden="true" className="mt-0.5 shrink-0" />
            <div className="flex flex-col gap-2">
              <p className="m-0 font-semibold">{suggestion.headline}</p>
              <p className="m-0">{t("dataRights.breach.suggestion.because")}</p>
              <ul className="m-0 flex flex-col gap-1 ps-5">
                {suggestion.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </div>
          </div>
        </Card>
      ) : null}

      {decision || forms.decide ? (
        <Card as="section" title={t("dataRights.breach.decide.title")} headingLevel={2}>
          <div className="flex flex-col gap-4">
            {decision ? (
              <dl className="m-0 flex flex-col gap-3">
                <Row
                  label={t("dataRights.breach.decide.report")}
                  value={t("dataRights.breach.decide.option", {
                    question: "report",
                    value: decision.reportToIco ? "yes" : "no",
                  })}
                />
                <Row
                  label={t("dataRights.breach.decide.tell")}
                  value={t("dataRights.breach.decide.option", {
                    question: "tell",
                    value: decision.tellIndividuals ? "yes" : "no",
                  })}
                />
                <Row label={t("dataRights.breach.decide.reasoning")} value={decision.reasoning} />
                <Row
                  label={t("dataRights.breach.decide.when")}
                  value={t("dataRights.breach.decide.recorded", {
                    at: formatDateTime(decision.decidedAt) ?? "",
                    against: decision.acknowledgedSuggestion ? "yes" : "no",
                  })}
                />
              </dl>
            ) : null}
            {forms.decide && breach.suggestion ? (
              <>
                {decision ? <p className="m-0">{t("dataRights.breach.decide.change")}</p> : null}
                <DecideBreachForm
                  key={breach.version}
                  id={breach.id}
                  version={breach.version}
                  suggestion={breach.suggestion}
                  decision={decision}
                />
              </>
            ) : null}
          </div>
        </Card>
      ) : null}

      {report || forms.report ? (
        <Card as="section" title={t("dataRights.breach.report.title")} headingLevel={2}>
          {report ? (
            <dl className="m-0 flex flex-col gap-3">
              <Row
                label={t("dataRights.breach.report.when")}
                value={formatDateTime(report.reportedAt) ?? ""}
              />
              <Row label={t("dataRights.breach.report.reference")} value={report.icoReference} />
              {report.delayReason ? (
                <Row label={t("dataRights.breach.report.delay")} value={report.delayReason} />
              ) : null}
            </dl>
          ) : (
            <ReportBreachForm
              key={breach.version}
              id={breach.id}
              version={breach.version}
              deadline={breach.clock.deadline}
              deadlinePassed={breach.clock.state === "overdue"}
            />
          )}
        </Card>
      ) : null}

      {individuals || forms.tell ? (
        <Card as="section" title={t("dataRights.breach.tell.title")} headingLevel={2}>
          {individuals ? (
            <dl className="m-0 flex flex-col gap-3">
              <Row
                label={t("dataRights.breach.tell.toldOn")}
                value={formatDate(individuals.toldOn) ?? ""}
              />
              <Row label={t("dataRights.breach.tell.notice")} value={individuals.notice} />
            </dl>
          ) : (
            <TellIndividualsForm
              key={breach.version}
              id={breach.id}
              version={breach.version}
              draft={draft}
            />
          )}
        </Card>
      ) : null}

      {breach.status === "closed" || forms.close ? (
        <Card as="section" title={t("dataRights.breach.close.title")} headingLevel={2}>
          {breach.status === "closed" ? (
            <dl className="m-0 flex flex-col gap-3">
              <Row
                label={t("dataRights.breach.close.closedAt")}
                value={formatDateTime(breach.closedAt) ?? ""}
              />
              <Row label={t("dataRights.breach.close.lessons")} value={breach.lessons ?? ""} />
            </dl>
          ) : (
            <CloseBreachForm key={breach.version} id={breach.id} version={breach.version} />
          )}
        </Card>
      ) : null}
    </DataRightsFrame>
  );
}
