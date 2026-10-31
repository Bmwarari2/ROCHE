import { ButtonLink, Card, EmptyState, PageHeader, StatusChip } from "@harbour/ui";
import { FileDown, Info, Lock, PenLine } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { NewVersionForm, SignDocumentForm } from "@/components/documents/DocumentForms";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import {
  DOCUMENT_MANAGE,
  DOCUMENTS_PAGE,
  documentChip,
  documentDownload,
  documentPage,
  fileSize,
  versionChain,
} from "@/lib/documents";
import { isFamilyMember } from "@/lib/family-feed";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { firstParam } from "@/lib/record-metadata";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata: Metadata = { title: t("documents.details.title") };

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;
const DONE = new Set(["uploaded", "version", "signed"]);

/**
 * One document (PLAT-009): its details, retention class and legal hold, its versions, who signed
 * it and when (each signature bound to the SHA-256 of the version signed), a signing form for the
 * latest version, and for holders of `platform.document.manage` a new version. An earlier version
 * says so and links to the latest; it is not offered for signing.
 */
export default async function DocumentDetailsPage({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { me } = await getShellContext();
  if (isFamilyMember(me)) return <SafetyForbidden title={t("documents.details.title")} />;
  const here = documentPage(id);
  const api = await tenantApi();
  const found = await api.GET("/v1/documents/{id}", { params: { path: { id } } });
  if (!found.data) {
    if (problemCode(found.error) === "not_found") notFound();
    if (problemCode(found.error) === "missing_permission") {
      return <SafetyForbidden title={t("documents.details.title")} />;
    }
    failWith(found.error, found.response, here);
  }
  const doc = found.data;
  const organisation = doc.category === "organisation_document";
  const library = organisation
    ? ((
        await api.GET("/v1/documents", { params: { query: { category: "organisation_document" } } })
      ).data?.items ?? [])
    : [];
  const newer = library.find((d) => d.previousVersionId === doc.id) ?? null;
  const chain = versionChain(doc, library);
  const available = doc.status === "available";
  const mayManage = organisation && me.permissions.includes(DOCUMENT_MANAGE);
  const done = firstParam((await searchParams).done);
  const when = (iso: string | null) => formatDateTime(iso) ?? "";

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={<Link href={DOCUMENTS_PAGE}>{t("documents.title")}</Link>}
        title={doc.title}
        description={t("documents.details.description", { version: doc.documentVersion })}
      />
      {done && DONE.has(done) ? (
        <RecordedArrival message={t("documents.done", { done })} param="done" />
      ) : null}
      {newer ? (
        <div
          role="note"
          className="flex gap-3 rounded-input border-s-4 border-info bg-bg-secondary p-4"
        >
          <Info {...icon} className="mt-0.5 shrink-0" />
          <p className="m-0">
            {t("documents.details.superseded", { version: doc.documentVersion })}{" "}
            <Link href={documentPage(newer.id)}>
              {t("documents.details.openLatest", { version: newer.documentVersion })}
            </Link>
          </p>
        </div>
      ) : null}
      <Card as="section" title={t("documents.details.about")} headingLevel={2}>
        <div className="flex flex-col gap-4">
          <p className="m-0 flex flex-wrap items-center gap-2">
            <SafetyChip chip={documentChip(doc.status, t)} />
            {doc.legalHold ? (
              <StatusChip status="info" label={t("documents.legalHold")} icon={Lock} />
            ) : null}
          </p>
          <dl className="m-0 grid grid-cols-1 gap-x-4 gap-y-1 text-body-dense sm:grid-cols-[max-content_1fr]">
            <dt className="font-semibold">{t("documents.details.version")}</dt>
            <dd className="m-0">{doc.documentVersion}</dd>
            <dt className="font-semibold">{t("documents.details.stored")}</dt>
            <dd className="m-0 tabular-nums">{when(doc.createdAt)}</dd>
            {doc.fileName ? (
              <>
                <dt className="font-semibold">{t("documents.details.fileName")}</dt>
                <dd className="m-0 break-all">{doc.fileName}</dd>
              </>
            ) : null}
            <dt className="font-semibold">{t("documents.details.size")}</dt>
            <dd className="m-0">{fileSize(doc.sizeBytes, t)}</dd>
            <dt className="font-semibold">{t("documents.details.retention")}</dt>
            <dd className="m-0">
              {t("documents.retentionClass", { recordClass: doc.retentionClass })}
            </dd>
            <dt className="font-semibold">{t("documents.details.fingerprint")}</dt>
            <dd className="m-0 break-all font-mono text-body-dense">{doc.sha256}</dd>
          </dl>
          {available && doc.contentType === "application/pdf" ? (
            <div>
              <ButtonLink
                href={documentDownload(doc.id)}
                variant="secondary"
                icon={<FileDown {...icon} />}
              >
                {t("documents.details.download")}
              </ButtonLink>
            </div>
          ) : null}
          {doc.status === "quarantined" ? (
            <p className="m-0">{t("documents.details.quarantined")}</p>
          ) : null}
        </div>
      </Card>
      <Card as="section" title={t("documents.signatures.title")} headingLevel={2}>
        {doc.signatures.length === 0 ? (
          <EmptyState
            headingLevel={3}
            icon={<PenLine size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("documents.signatures.empty")}
          />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {doc.signatures.map((s) => (
              <li
                key={`${s.signerName}-${s.signedAt}`}
                className="flex flex-col gap-1 border-b border-border pb-3"
              >
                <p className="m-0 font-semibold">
                  {t("documents.signatures.item", {
                    name: s.signerName,
                    dateTime: when(s.signedAt),
                  })}
                </p>
                <p className="m-0 text-body-dense">{s.statement}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {available && !newer ? (
        <Card as="section" title={t("documents.sign.title")} headingLevel={2}>
          <SignDocumentForm id={doc.id} sha256={doc.sha256} />
        </Card>
      ) : null}
      {chain.length > 1 ? (
        <Card as="section" title={t("documents.versions.title")} headingLevel={2}>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {chain.map((v) => (
              <li key={v.id}>
                {v.id === doc.id ? (
                  <span aria-current="page" className="font-semibold">
                    {t("documents.versions.item", {
                      version: v.documentVersion,
                      dateTime: when(v.createdAt),
                    })}{" "}
                    {t("documents.versions.shown")}
                  </span>
                ) : (
                  <Link href={documentPage(v.id)}>
                    {t("documents.versions.item", {
                      version: v.documentVersion,
                      dateTime: when(v.createdAt),
                    })}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      {mayManage && available && !newer ? (
        <Card as="section" title={t("documents.version.title")} headingLevel={2}>
          <NewVersionForm id={doc.id} />
        </Card>
      ) : null}
    </div>
  );
}
