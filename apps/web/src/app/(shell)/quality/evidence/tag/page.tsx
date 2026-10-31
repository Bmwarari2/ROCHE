import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { TagForm, UntagForm } from "@/components/quality/ProgrammeForms";
import { QualityChip } from "@/components/quality/QualityChip";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { getShellContext, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { readOrFail } from "@/lib/person-record";
import { qualityDone } from "@/lib/quality-done";
import { evidenceManaged, isTaggable, recordHref, statementRows } from "@/lib/quality-programme";

export const metadata: Metadata = { title: t("quality.tag.title") };

/**
 * Tagging a record as evidence (QUAL-002; rule 6), reached from the record itself: the record's
 * current tags with the statements they name (each removable with a reason), and a form to tag it
 * against statements of the framework version in force. The API reads the record in the tagger's
 * own scope; a record they cannot see is refused as not found.
 */
export default async function TagEvidencePage({
  searchParams,
}: {
  readonly searchParams: Promise<{
    recordType?: string | string[];
    recordId?: string | string[];
    done?: string | string[];
  }>;
}) {
  const query = await searchParams;
  const recordType = typeof query.recordType === "string" ? query.recordType : "";
  const recordId = typeof query.recordId === "string" ? query.recordId : "";
  if (!isTaggable(recordType) || !isUuid(recordId)) notFound();
  const { me } = await getShellContext();
  const title = t("quality.tag.title");
  if (!evidenceManaged(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const path = `/quality/evidence/tag?recordType=${recordType}&recordId=${recordId}`;
  const versions = readOrFail(await api.GET("/v1/quality/frameworks"), path);
  if (!versions) return <SafetyForbidden title={title} />;
  const inForce = versions.items.find((v) => v.inForce && v.regulator === "cqc");
  const [detail, links] = await Promise.all([
    inForce
      ? api.GET("/v1/quality/frameworks/{id}", { params: { path: { id: inForce.id } } })
      : null,
    api.GET("/v1/evidence-links", { params: { query: { recordType, recordId } } }),
  ]);
  const version = detail ? readOrFail(detail, path) : null;
  const tags = readOrFail(links, path);
  if (!tags) return <SafetyForbidden title={title} />;
  const titles = new Map(version ? statementRows(version).map((s) => [s.id, s.title]) : []);
  const href = recordHref(recordType, recordId);
  const done = qualityDone(query.done);

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6 break-words">
      <PageHeader
        title={title}
        description={t("quality.tag.description", {
          type: t("quality.tag.recordType", { type: recordType }),
        })}
      />
      {done ? <RecordedArrival message={t("quality.done", { done })} param="done" /> : null}
      {href ? (
        <p className="m-0">
          <Link href={href} className="inline-flex min-h-target items-center underline">
            {t("quality.tag.backToRecord")}
          </Link>
        </p>
      ) : null}
      <Card as="section" title={t("quality.tag.currentTags")} headingLevel={2}>
        {tags.items.length === 0 ? (
          <p className="m-0">{t("quality.tag.noTags")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-6 p-0">
            {tags.items.map((link) => (
              <li key={link.id} className="flex flex-col gap-2 border-b border-border pb-4">
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
                <ul className="m-0 pl-5">
                  {link.statementIds.map((s) => (
                    <li key={s}>{titles.get(s) ?? s}</li>
                  ))}
                </ul>
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
                  <UntagForm
                    link={link}
                    what={link.statementIds.map((s) => titles.get(s) ?? s).join("; ")}
                    path={path}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card as="section" title={t("quality.tag.addTitle")} headingLevel={2}>
        {version && version.state === "published" ? (
          <TagForm recordType={recordType} recordId={recordId} detail={version} path={path} />
        ) : (
          <p className="m-0">{t("quality.tag.noFramework")}</p>
        )}
      </Card>
    </div>
  );
}
