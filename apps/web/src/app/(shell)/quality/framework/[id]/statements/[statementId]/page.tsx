import { Card, EmptyState, PageHeader } from "@harbour/ui";
import { FolderSearch } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { UntagForm } from "@/components/quality/ProgrammeForms";
import { QualityChip } from "@/components/quality/QualityChip";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { getShellContext, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { readOrFail } from "@/lib/person-record";
import { qualityDone } from "@/lib/quality-done";
import { evidenceManaged, recordHref, statementRows } from "@/lib/quality-programme";

export const metadata: Metadata = { title: t("quality.statement.title") };

/**
 * The evidence for one quality statement (QUAL-002): every record tagged against it, newest
 * first, removed tags kept and marked with who removed them and why, so the history shows; a
 * current tag can be removed with a reason.
 */
export default async function StatementEvidencePage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ id: string; statementId: string }>;
  readonly searchParams: Promise<{ done?: string | string[] }>;
}) {
  const { id, statementId: raw } = await params;
  const statementId = decodeURIComponent(raw);
  if (!isUuid(id) || !/^[A-Za-z0-9._-]{1,64}$/.test(statementId)) notFound();
  const { me } = await getShellContext();
  const title = t("quality.statement.title");
  if (!evidenceManaged(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const path = `/quality/framework/${id}/statements/${encodeURIComponent(statementId)}`;
  const detail = readOrFail(
    await api.GET("/v1/quality/frameworks/{id}", { params: { path: { id } } }),
    path,
  );
  if (!detail) return <SafetyForbidden title={title} />;
  const statement = statementRows(detail).find((s) => s.id === statementId);
  if (!statement) notFound();
  const links = readOrFail(
    await api.GET("/v1/evidence-links", {
      params: { query: { frameworkVersionId: id, statementId } },
    }),
    path,
  );
  if (!links) return <SafetyForbidden title={title} />;
  const done = qualityDone((await searchParams).done);

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6 break-words">
      <PageHeader
        title={statement.title}
        description={t("quality.statement.description", {
          keyQuestion: statement.keyQuestionTitle,
        })}
      />
      {done ? <RecordedArrival message={t("quality.done", { done })} param="done" /> : null}
      <p className="m-0">
        <Link href={`/quality/framework/${id}/coverage`} className="underline">
          {t("quality.statement.back")}
        </Link>
      </p>
      {links.items.length === 0 ? (
        <EmptyState
          icon={<FolderSearch size={32} strokeWidth={1.5} aria-hidden="true" />}
          title={t("quality.statement.empty")}
          description={t("quality.statement.emptyHint")}
        />
      ) : (
        <Card as="section" title={t("quality.statement.records")} headingLevel={2}>
          <ul className="m-0 flex list-none flex-col gap-6 p-0">
            {links.items.map((link) => {
              const href = recordHref(link.recordType, link.recordId);
              const label = t("quality.tag.recordType", { type: link.recordType });
              return (
                <li key={link.id} className="flex flex-col gap-2 border-b border-border pb-4">
                  <h3 className="m-0 text-body font-semibold">
                    {href ? (
                      <Link href={href} className="inline-flex min-h-target items-center underline">
                        {label}
                      </Link>
                    ) : (
                      label
                    )}
                  </h3>
                  <span>
                    <QualityChip
                      chip={
                        link.removedAt
                          ? {
                              status: "neutral",
                              icon: "circle-minus",
                              label: t("quality.tag.removed"),
                            }
                          : { status: "done", icon: "link", label: t("quality.tag.current") }
                      }
                    />
                  </span>
                  <span className="text-body-dense text-text-secondary">
                    {t("quality.tag.taggedAt", { when: formatDateTime(link.taggedAt) ?? "" })}
                  </span>
                  {link.removedAt ? (
                    <span className="text-body-dense text-text-secondary">
                      {t("quality.tag.removedBecause", {
                        when: formatDateTime(link.removedAt) ?? "",
                        reason: link.removalReason ?? "",
                      })}
                    </span>
                  ) : (
                    <UntagForm link={link} path={path} />
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}
