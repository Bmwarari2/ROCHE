import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { RecordCertificateForm } from "@/components/quality/DataSecurityForms";
import { QualityChip } from "@/components/quality/QualityChip";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { getShellContext, tenantApi } from "@/lib/api";
import { dataSecurityShown, latestOfKind, renewalChip, replacedChip } from "@/lib/data-security";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { readOrFail } from "@/lib/person-record";
import { qualityDone } from "@/lib/quality-done";

export const metadata: Metadata = { title: t("quality.dataSecurity.certificates.pageTitle") };

/**
 * Cyber Essentials and ICO registration records (QUAL-012; rule 36): each kind's status from the
 * overview (a missing one said as missing, never current), every record newest first, and a form
 * to add one with an optional copy from the organisation's documents.
 */
export default async function CertificatesPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ done?: string | string[] }>;
}) {
  const { me } = await getShellContext();
  const title = t("quality.dataSecurity.certificates.pageTitle");
  if (!dataSecurityShown(me.permissions))
    return <SafetyForbidden title={title} hint={t("quality.dataSecurity.organisationOnly")} />;
  const api = await tenantApi();
  const path = "/quality/data-security/certificates";
  const [records, overview, docs] = await Promise.all([
    api.GET("/v1/data-security/certificates"),
    api.GET("/v1/data-security"),
    api.GET("/v1/documents", { params: { query: { category: "organisation_document" } } }),
  ]);
  const list = readOrFail(records, path);
  const now = readOrFail(overview, path);
  if (!list || !now)
    return <SafetyForbidden title={title} hint={t("quality.dataSecurity.organisationOnly")} />;
  const documents = docs.data?.items.filter((d) => d.status === "available") ?? [];
  const items = list.items.flatMap((c) => (c ? [c] : []));
  const latest = latestOfKind(items);
  const kindStatus = new Map(now.certificates.map((c) => [c.kind, c.status] as const));
  const done = qualityDone((await searchParams).done);

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6 break-words">
      <PageHeader title={title} description={t("quality.dataSecurity.certificates.description")} />
      {done ? <RecordedArrival message={t("quality.done", { done })} param="done" /> : null}
      <p className="m-0">
        <Link
          href="/quality/data-security"
          className="inline-flex min-h-target items-center underline"
        >
          {t("quality.dataSecurity.back")}
        </Link>
      </p>
      <Card
        as="section"
        title={t("quality.dataSecurity.certificates.statusTitle")}
        headingLevel={2}
      >
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {now.certificates.map((c) => (
            <li key={c.kind} className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">
                {t("quality.dataSecurity.kind", { kind: c.kind })}
              </span>
              <QualityChip chip={renewalChip(c.status, t)} />
            </li>
          ))}
        </ul>
      </Card>
      <Card as="section" title={t("quality.dataSecurity.certificates.records")} headingLevel={2}>
        {list.items.length === 0 ? (
          <p className="m-0">{t("quality.dataSecurity.certificates.none")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {items.map((c) => {
              const status = kindStatus.get(c.kind);
              return (
                <li key={c.id} className="flex flex-col gap-1 border-b border-border pb-3">
                  <span className="font-semibold">
                    {t("quality.dataSecurity.certificates.item", {
                      kind: c.kind,
                      reference: c.reference,
                    })}
                  </span>
                  <span>
                    <QualityChip
                      chip={latest.has(c.id) && status ? renewalChip(status, t) : replacedChip(t)}
                    />
                  </span>
                  <span className="text-body-dense text-text-secondary">
                    {t("quality.dataSecurity.certificates.dates", {
                      issued: formatDate(c.issuedOn) ?? "",
                      expires: formatDate(c.expiresOn) ?? "",
                      hasExpiry: String(c.expiresOn !== null),
                    })}
                  </span>
                  {c.documentId ? (
                    <Link
                      href={`/documents/${c.documentId}/details`}
                      className="inline-flex min-h-target items-center underline"
                    >
                      {t("quality.dataSecurity.certificates.copy", { reference: c.reference })}
                    </Link>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <Card as="section" title={t("quality.dataSecurity.certificates.recordCard")} headingLevel={2}>
        <RecordCertificateForm
          documents={documents.map((d) => ({ id: d.id, title: d.title }))}
          path={path}
        />
      </Card>
    </div>
  );
}
