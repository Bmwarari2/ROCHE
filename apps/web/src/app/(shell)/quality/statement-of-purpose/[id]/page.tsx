import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { QualityChip } from "@/components/quality/QualityChip";
import {
  NotificationStatus,
  StatementChanges,
  StatementContent,
} from "@/components/quality/StatementView";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { getShellContext, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { readOrFail } from "@/lib/person-record";
import { statementShown, versionStateChip } from "@/lib/statement-of-purpose";

export const metadata: Metadata = { title: t("quality.sop.versionPageTitle") };

const PATH = "/quality/statement-of-purpose";

/**
 * One version of the statement of purpose (QUAL-009): its content, state, approval, where it
 * stands with CQC and what it changed against the version before it, with the registration
 * prompts.
 */
export default async function StatementVersionPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { me } = await getShellContext();
  const listTitle = t("quality.sop.title");
  if (!statementShown(me.permissions)) return <SafetyForbidden title={listTitle} />;
  const api = await tenantApi();
  const list = readOrFail(await api.GET("/v1/statement-of-purpose/versions"), `${PATH}/${id}`);
  if (!list) return <SafetyForbidden title={listTitle} />;
  const version = list.items.find((v) => v.id === id);
  if (!version) notFound();
  const changes = (
    await api.GET("/v1/statement-of-purpose/versions/{id}/changes", { params: { path: { id } } })
  ).data;
  const title = t("quality.sop.versionTitle", { n: version.versionNumber, kind: version.kind });
  const now = new Date();

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6 break-words">
      <nav aria-label={t("common.breadcrumb")} className="text-body-dense">
        <Link href={PATH} className="inline-flex min-h-target items-center underline">
          {listTitle}
        </Link>
        <span aria-hidden="true" className="px-2 text-text-secondary">
          ›
        </span>
        <span aria-current="page">{title}</span>
      </nav>
      <PageHeader title={title} />
      <div className="flex flex-col gap-2">
        <span>
          <QualityChip chip={versionStateChip(version.state, t)} />
        </span>
        {version.approvedAt ? (
          <span>
            {t("quality.sop.approvedAt", { when: formatDateTime(version.approvedAt) ?? "" })}
          </span>
        ) : null}
        {version.state === "approved" || version.state === "superseded" ? (
          <NotificationStatus version={version} now={now} />
        ) : null}
        {version.discardReason ? (
          <span>{t("quality.sop.discardedBecause", { reason: version.discardReason })}</span>
        ) : null}
      </div>
      {changes ? (
        <Card as="section" title={t("quality.sop.changes.title")} headingLevel={2}>
          <StatementChanges changes={changes} />
        </Card>
      ) : null}
      <Card as="section" title={t("quality.sop.contentTitle")} headingLevel={2}>
        <StatementContent content={version.content} />
      </Card>
    </div>
  );
}
