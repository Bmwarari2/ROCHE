import { ButtonLink, Card, EmptyState, PageHeader, StatusChip } from "@harbour/ui";
import { FileText, Lock, Mail } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { UploadDocumentForm } from "@/components/documents/DocumentForms";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import {
  DOCUMENT_MANAGE,
  DOCUMENTS_PAGE,
  documentChip,
  documentPage,
  fileSize,
  latestVersions,
} from "@/lib/documents";
import { isFamilyMember } from "@/lib/family-feed";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { templatesNavShown } from "@/lib/letters";
import { firstParam } from "@/lib/record-metadata";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata: Metadata = { title: t("documents.title") };

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;

/**
 * The organisation's documents (PLAT-009; platform.md, document store): policies, procedures and
 * other documents about no one, which every member reads. Each shows its latest version, when it
 * was stored, its size and status as an icon and a word, and a legal hold. Holders of
 * `platform.document.manage` upload one (PDF). Merge-field letter templates live with letters
 * (COMMS-007); documents about a person stay on the person's record.
 */
export default async function DocumentsPage({
  searchParams,
}: {
  readonly searchParams: SearchParams;
}) {
  const { me } = await getShellContext();
  const title = t("documents.title");
  if (isFamilyMember(me)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const listed = await api.GET("/v1/documents", {
    params: { query: { category: "organisation_document" } },
  });
  if (!listed.data) failWith(listed.error, listed.response, DOCUMENTS_PAGE);
  const items = latestVersions(listed.data.items);
  const mayManage = me.permissions.includes(DOCUMENT_MANAGE);
  const done = firstParam((await searchParams).done);

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader eyebrow={me.tenant.name} title={title} description={t("documents.description")} />
      {done === "uploaded" ? (
        <RecordedArrival message={t("documents.done", { done })} param="done" />
      ) : null}
      {mayManage ? (
        <Card as="section" title={t("documents.upload.heading")} headingLevel={2}>
          <UploadDocumentForm />
        </Card>
      ) : null}
      <Card as="section" title={t("documents.list.title")} headingLevel={2}>
        {items.length === 0 ? (
          <EmptyState
            headingLevel={3}
            icon={<FileText size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("documents.list.empty")}
          />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {items.map((doc) => (
              <li key={doc.id} className="flex flex-col gap-2 border-b border-border pb-3">
                <h3 className="m-0 text-body font-semibold">
                  <Link href={documentPage(doc.id)}>{doc.title}</Link>
                </h3>
                <p className="m-0 flex flex-wrap items-center gap-2">
                  <SafetyChip chip={documentChip(doc.status, t)} />
                  {doc.legalHold ? (
                    <StatusChip status="info" label={t("documents.legalHold")} icon={Lock} />
                  ) : null}
                  <span className="text-body-dense">
                    {t("documents.item.meta", {
                      version: doc.documentVersion,
                      dateTime: formatDateTime(doc.createdAt) ?? "",
                      size: fileSize(doc.sizeBytes, t),
                      signatures: doc.signatures.length,
                    })}
                  </span>
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {templatesNavShown(me.permissions) ? (
        <Card as="section" title={t("documents.templates.title")} headingLevel={2}>
          <div className="flex flex-col gap-3">
            <p className="m-0 max-w-prose">{t("documents.templates.about")}</p>
            <div>
              <ButtonLink href="/letters" variant="secondary" icon={<Mail {...icon} />}>
                {t("documents.templates.link")}
              </ButtonLink>
            </div>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
