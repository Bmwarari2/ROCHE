import { Card, PageHeader } from "@harbour/ui";
import { CircleAlert, Info } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Notice } from "@/components/care/Notice";
import { QualityChip } from "@/components/quality/QualityChip";
import {
  ApproveStatement,
  DiscardStatement,
  NotifyStatement,
  StartRevision,
} from "@/components/quality/StatementActions";
import { StatementEditor } from "@/components/quality/StatementEditor";
import {
  EnglishLines,
  NotificationStatus,
  StatementChanges,
  StatementContent,
} from "@/components/quality/StatementView";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { getShellContext, tenantApi } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { readOrFail } from "@/lib/person-record";
import { qualityDone } from "@/lib/quality-done";
import {
  approveBlock,
  awaitingNotification,
  EMPTY_CONTENT,
  SUBMIT,
  statementShown,
  statementView,
  versionStateChip,
  WRITE,
} from "@/lib/statement-of-purpose";

export const metadata: Metadata = { title: t("quality.sop.title") };

const PATH = "/quality/statement-of-purpose";
const link = "inline-flex min-h-target items-center underline";

/**
 * The statement of purpose (QUAL-009; quality.md section 16; HZ-080): first any revision waiting
 * to reach CQC, with its clock as an icon and a word and the form to record it was sent (step-up);
 * then the draft with its Schedule 3 gaps, what it changes and the registration prompts, the
 * editor, approval by someone who did not write it, and discard; then the version in force and
 * every version.
 */
export default async function StatementOfPurposePage({
  searchParams,
}: {
  readonly searchParams: Promise<{ done?: string | string[] }>;
}) {
  const { me } = await getShellContext();
  const title = t("quality.sop.title");
  if (!statementShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const list = readOrFail(await api.GET("/v1/statement-of-purpose/versions"), PATH);
  if (!list) return <SafetyForbidden title={title} />;
  const done = qualityDone((await searchParams).done);
  const now = new Date();
  const versions = list.items;
  const view = statementView(versions, me.permissions);
  const awaiting = awaitingNotification(versions);
  const draft = view.draft;
  const changes = draft
    ? (
        await api.GET("/v1/statement-of-purpose/versions/{id}/changes", {
          params: { path: { id: draft.id } },
        })
      ).data
    : undefined;
  const write = me.permissions.includes(WRITE);
  const submit = me.permissions.includes(SUBMIT);
  const block = draft ? approveBlock(draft, me) : null;

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6 break-words">
      <PageHeader title={title} description={t("quality.sop.description")} />
      {done ? <RecordedArrival message={t("quality.done", { done })} param="done" /> : null}

      {awaiting.map((v) => (
        <Card
          key={v.id}
          as="section"
          title={t("quality.sop.notify.cardTitle", { n: v.versionNumber })}
          headingLevel={2}
        >
          <div className="flex flex-col gap-4">
            <NotificationStatus version={v} now={now} />
            <p className="m-0 max-w-prose">{t("quality.sop.notify.why")}</p>
            {submit ? (
              <NotifyStatement id={v.id} versionNumber={v.versionNumber} />
            ) : (
              <p className="m-0">{t("quality.sop.notify.whoCan")}</p>
            )}
          </div>
        </Card>
      ))}

      {draft ? (
        <Card
          as="section"
          title={t("quality.sop.draftTitle", { n: draft.versionNumber, kind: draft.kind })}
          headingLevel={2}
        >
          <div className="flex flex-col gap-6">
            <p className="m-0 flex flex-wrap items-center gap-2">
              <QualityChip chip={versionStateChip(draft.state, t)} />
            </p>
            {draft.missing.length > 0 ? (
              <Notice
                tone="warning"
                icon={<CircleAlert size={20} strokeWidth={1.5} aria-hidden="true" />}
                title={t("quality.sop.missing", { count: draft.missing.length })}
              >
                <EnglishLines lines={draft.missing} />
              </Notice>
            ) : (
              <Notice
                icon={<Info size={20} strokeWidth={1.5} aria-hidden="true" />}
                title={t("quality.sop.complete")}
              />
            )}
            {draft.warnings.length > 0 ? (
              <Notice
                tone="warning"
                icon={<CircleAlert size={20} strokeWidth={1.5} aria-hidden="true" />}
                title={t("quality.sop.warnings")}
              >
                <EnglishLines lines={draft.warnings} />
              </Notice>
            ) : null}
            {changes ? (
              <section aria-labelledby="changes-title" className="flex flex-col gap-2">
                <h3 id="changes-title" className="m-0 text-body font-semibold">
                  {t("quality.sop.changes.title")}
                </h3>
                <StatementChanges changes={changes} />
              </section>
            ) : null}
            {block === null ? (
              <ApproveStatement id={draft.id} version={draft.version} />
            ) : block !== "no_permission" ? (
              <Notice
                icon={<Info size={20} strokeWidth={1.5} aria-hidden="true" />}
                title={t("quality.sop.approve.title")}
              >
                {t("quality.sop.approve.blocked", { why: block })}
              </Notice>
            ) : null}
            {write ? (
              <StatementEditor
                key={`${draft.id}-${draft.version}`}
                draft={{ id: draft.id, version: draft.version }}
                content={draft.content}
              />
            ) : (
              <StatementContent content={draft.content} />
            )}
            {write ? <DiscardStatement id={draft.id} version={draft.version} /> : null}
          </div>
        </Card>
      ) : null}

      {view.startBaseline ? (
        <Card as="section" title={t("quality.sop.baselineTitle")} headingLevel={2}>
          <StatementEditor draft={null} content={EMPTY_CONTENT} />
        </Card>
      ) : null}
      {view.startRevision ? (
        <Card as="section" title={t("quality.sop.reviseTitle")} headingLevel={2}>
          <div className="flex flex-col gap-3">
            <p className="m-0 max-w-prose">{t("quality.sop.reviseIntro")}</p>
            <StartRevision />
          </div>
        </Card>
      ) : null}

      {view.current ? (
        <Card
          as="section"
          title={t("quality.sop.currentTitle", { n: view.current.versionNumber })}
          headingLevel={2}
        >
          <div className="flex flex-col gap-4">
            <p className="m-0 text-body-dense text-text-secondary">
              {t("quality.sop.approvedAt", { when: formatDateTime(view.current.approvedAt) ?? "" })}
            </p>
            <StatementContent content={view.current.content} />
          </div>
        </Card>
      ) : versions.length === 0 && !write ? (
        <p className="m-0">{t("quality.sop.noneYet")}</p>
      ) : null}

      {versions.length > 0 ? (
        <Card as="section" title={t("quality.sop.versions")} headingLevel={2}>
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {versions.map((v) => (
              <li key={v.id} className="flex flex-col gap-1 border-b border-border pb-3">
                <h3 className="m-0 text-body font-semibold">
                  <Link href={`${PATH}/${v.id}`} className={link}>
                    {t("quality.sop.versionTitle", { n: v.versionNumber, kind: v.kind })}
                  </Link>
                </h3>
                <span className="flex flex-wrap items-center gap-2">
                  <QualityChip chip={versionStateChip(v.state, t)} />
                </span>
                {v.approvedAt ? (
                  <span className="text-body-dense text-text-secondary">
                    {t("quality.sop.approvedAt", { when: formatDateTime(v.approvedAt) ?? "" })}
                  </span>
                ) : null}
                {v.state === "approved" || v.state === "superseded" ? (
                  <NotificationStatus version={v} now={now} />
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
