import { buttonClassName, Card, PageHeader } from "@harbour/ui";
import { CircleAlert, Info } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Notice } from "@/components/care/Notice";
import { AnswersForm, CompleteAuditForm } from "@/components/quality/ProgrammeForms";
import { QualityChip } from "@/components/quality/QualityChip";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { getShellContext, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { formatDate, formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { readOrFail } from "@/lib/person-record";
import { qualityDone } from "@/lib/quality-done";
import {
  auditStateChip,
  auditsShown,
  evidenceManaged,
  scoreText,
  statementRows,
} from "@/lib/quality-programme";

export const metadata: Metadata = { title: t("quality.audits.title") };

/**
 * One audit or mock inspection (QUAL-004; rules 4 and 9 to 14): scored against the questions and
 * framework version it started with, the score with its method in words, the answers that fell
 * short by quality statement, and the actions with their owners and due dates. In progress: the
 * answers form, then completion with an action for each shortfall and the self-rating, given by a
 * person and never worked out from the score. Completed: fixed, and taggable as evidence.
 */
export default async function AuditPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ id: string }>;
  readonly searchParams: Promise<{ done?: string | string[] }>;
}) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { me } = await getShellContext();
  const title = t("quality.audits.title");
  if (!auditsShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const path = `/quality/audits/${id}`;
  const audit = readOrFail(
    await api.GET("/v1/quality/audits/{id}", { params: { path: { id } } }),
    path,
  );
  if (!audit) return <SafetyForbidden title={title} />;
  const framework = (
    await api.GET("/v1/quality/frameworks/{id}", {
      params: { path: { id: audit.frameworkVersionId } },
    })
  ).data;
  const titles = new Map(framework ? statementRows(framework).map((s) => [s.id, s.title]) : []);
  const questions = new Map(audit.questions.map((q) => [q.key, q.text]));
  // Action owners: the auditor, and the organisation's members where the reader may list them.
  const members = me.permissions.includes("platform.user.manage")
    ? ((await api.GET("/v1/members", { params: { query: { locationId: audit.locationId } } })).data
        ?.items ?? [])
    : [];
  const owners = [
    { id: me.tenantUserId, name: t("quality.complete.me", { name: me.user.name }) },
    ...members
      .filter((m) => m.state === "active" && m.id !== me.tenantUserId)
      .map((m) => ({ id: m.id, name: m.displayName })),
  ];
  const names = new Map(owners.map((o) => [o.id, o.name]));
  const place = me.locations.find((l) => l.id === audit.locationId)?.name;
  const done = qualityDone((await searchParams).done);
  const inProgress = audit.state === "in_progress";

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6 break-words">
      <PageHeader
        eyebrow={t("quality.audits.kind", { kind: audit.kind })}
        title={audit.title}
        description={t("quality.audit.where", {
          place: place ?? t("quality.audits.unknownPlace"),
          date: formatDate(audit.auditedOn) ?? "",
        })}
        {...(!inProgress && evidenceManaged(me.permissions)
          ? {
              primaryAction: (
                <Link
                  href={`/quality/evidence/tag?recordType=audit&recordId=${audit.id}`}
                  className={buttonClassName({ variant: "secondary" })}
                >
                  {t("quality.audit.tagAsEvidence")}
                </Link>
              ),
            }
          : {})}
      />
      {done ? <RecordedArrival message={t("quality.done", { done })} param="done" /> : null}
      <p className="m-0">
        <Link href="/quality/audits" className="underline">
          {t("quality.templates.back")}
        </Link>
      </p>
      <div>
        <QualityChip chip={auditStateChip(audit.state, t)} />
      </div>
      {audit.frameworkInForce ? null : (
        <Notice
          icon={<Info size={20} aria-hidden="true" />}
          title={t("quality.audit.olderFrameworkTitle")}
        >
          <p className="m-0">{t("quality.audit.olderFramework")}</p>
        </Notice>
      )}

      <Card as="section" title={t("quality.audit.scoreTitle")} headingLevel={2}>
        <div className="flex flex-col gap-2">
          <p className="m-0 text-heading-3 font-semibold">{scoreText(audit.score.percent, t)}</p>
          <p className="m-0 max-w-prose">{audit.score.method}</p>
          {audit.score.unanswered.length > 0 ? (
            <p className="m-0">
              {t("quality.audit.unanswered", { count: audit.score.unanswered.length })}
            </p>
          ) : null}
          {audit.selfRating !== null ? (
            <p className="m-0 font-semibold">
              {t("quality.audit.selfRating", {
                value: audit.selfRating,
                word: audit.selfRatingWords ?? "",
              })}
            </p>
          ) : null}
          {audit.completedAt ? (
            <p className="m-0 text-body-dense text-text-secondary">
              {t("quality.audit.completedAt", { when: formatDateTime(audit.completedAt) ?? "" })}
            </p>
          ) : null}
        </div>
      </Card>

      {audit.findings.length > 0 ? (
        <Card as="section" title={t("quality.audit.findings")} headingLevel={2}>
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {audit.findings.map((f) => (
              <li key={f.statementId} className="flex flex-col gap-1">
                <span className="font-semibold">{titles.get(f.statementId) ?? f.statementId}</span>
                <ul className="m-0 pl-5">
                  {f.questionKeys.map((k) => (
                    <li key={k}>
                      {t("quality.audit.findingAnswer", {
                        text: questions.get(k) ?? k,
                        answer: audit.answers[k] ?? "none",
                      })}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {audit.actions.length > 0 ? (
        <Card as="section" title={t("quality.audit.actions")} headingLevel={2}>
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {audit.actions.map((a) => (
              <li key={a.id} className="flex flex-col gap-1 border-b border-border pb-3">
                <span className="font-semibold">{a.description}</span>
                <span className="text-body-dense text-text-secondary">
                  {t("quality.audit.actionDetail", {
                    question: questions.get(a.questionKey) ?? a.questionKey,
                    owner: names.get(a.ownerId) ?? t("quality.audit.someoneElse"),
                    due: formatDate(a.dueOn) ?? "",
                  })}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {inProgress ? (
        <>
          <Card as="section" title={t("quality.answers.cardTitle")} headingLevel={2}>
            <AnswersForm audit={audit} path={path} />
          </Card>
          <Card as="section" title={t("quality.complete.cardTitle")} headingLevel={2}>
            {audit.score.complete ? (
              <CompleteAuditForm audit={audit} owners={owners} path={path} />
            ) : (
              <Notice
                icon={<CircleAlert size={20} aria-hidden="true" />}
                title={t("quality.complete.notYetTitle")}
                tone="warning"
              >
                <p className="m-0">{t("quality.complete.notYet")}</p>
              </Notice>
            )}
          </Card>
        </>
      ) : null}
    </div>
  );
}
