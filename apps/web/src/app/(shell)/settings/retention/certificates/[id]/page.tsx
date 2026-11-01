import { ButtonLink, Card, PageHeader, StatusChip } from "@harbour/ui";
import { Download } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { firstParam } from "@/lib/record-metadata";
import { methodWords, RETENTION_PAGE, retentionShown } from "@/lib/retention";
import { certificateHref, signatureChip } from "@/lib/shred";

export const metadata: Metadata = { title: t("shred.certificate.title") };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * One destruction certificate (PLAT-012 part 2; platform.md rule 11): every field it states, its
 * signature check as an icon and a word, the signing key version, algorithm, hash and signature,
 * the key versions and their destroy times, and when backups expire; a link to the signature
 * check as data, and the certificate as a PDF built by the API. Opaque ids and the reason only.
 */
export default async function CertificatePage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ id: string }>;
  readonly searchParams: SearchParams;
}) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { me } = await getShellContext();
  const title = t("shred.certificate.title");
  if (!retentionShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const [one, verification] = await Promise.all([
    api.GET("/v1/destruction-certificates/{id}", { params: { path: { id } } }),
    api.GET("/v1/destruction-certificates/{id}/verification", { params: { path: { id } } }),
  ]);
  if (one.response.status === 404) notFound();
  if (!one.data) failWith(one.error, one.response, certificateHref(id));
  const cert = one.data;
  const valid = verification.data ? verification.data.valid : null;
  const check = valid === true ? "valid" : valid === false ? "invalid" : "unsigned";
  const chip = signatureChip(valid, t);
  const when = (iso: string | null) => formatDateTime(iso) ?? t("shred.certificate.notRecorded");
  const failed = firstParam((await searchParams).pdf) === "failed";
  const rows: { readonly term: string; readonly value: string; readonly code?: boolean }[] = [
    { term: t("shred.certificate.carriedOut"), value: when(cert.executedAt) },
    {
      term: t("shred.certificate.what"),
      value:
        cert.subjectType === "tenant"
          ? t("shred.certificate.whatTenant")
          : t("retention.certificate.heading", {
              count: cert.recordCount,
              recordClass: cert.recordClass,
              dateTime: when(cert.executedAt),
            }),
    },
    { term: t("shred.certificate.method"), value: methodWords(cert.method, t) },
    { term: t("shred.certificate.reason"), value: cert.reason },
    ...(cert.requestedBy
      ? [
          { term: t("shred.certificate.requestedBy"), value: cert.requestedBy, code: true },
          {
            term: t("shred.certificate.approvedBy"),
            value: cert.approvedBy ?? t("shred.certificate.notRecorded"),
            code: true,
          },
        ]
      : []),
    {
      term: t("shred.certificate.keys"),
      value:
        cert.keyVersions.length === 0
          ? t("shred.certificate.keysNone")
          : cert.keyVersions
              .map((k) => t("shred.certificate.keyLine", { name: k.name, when: when(k.destroyAt) }))
              .join("\n"),
    },
    { term: t("shred.certificate.backups"), value: when(cert.backupsExpireAt) },
    {
      term: t("shred.certificate.signer"),
      value: cert.signatureKey ?? t("shred.certificate.notRecorded"),
      code: true,
    },
    {
      term: t("shred.certificate.algorithm"),
      value: cert.signatureAlgorithm ?? t("shred.certificate.notRecorded"),
      code: true,
    },
    {
      term: t("shred.certificate.sha"),
      value: cert.bodySha256 ?? t("shred.certificate.notRecorded"),
      code: true,
    },
    {
      term: t("shred.certificate.signature"),
      value: cert.signature ?? t("shred.certificate.notRecorded"),
      code: true,
    },
    { term: t("shred.certificate.reference"), value: cert.id, code: true },
  ];

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={me.tenant.name}
        title={title}
        description={t("shred.certificate.description")}
      />
      <Card as="section" title={t("shred.certificate.checkTitle")} headingLevel={2}>
        <div className="flex flex-col gap-3">
          <p className="m-0">
            <StatusChip status={chip.status} label={chip.label} icon={chip.icon} />
          </p>
          <p className="m-0">{t("shred.certificate.checkDetail", { check })}</p>
          <div className="flex flex-wrap gap-3">
            <ButtonLink
              href={`${certificateHref(cert.id)}/pdf`}
              variant="primary"
              icon={<Download size={18} strokeWidth={1.5} aria-hidden="true" />}
            >
              {t("shred.certificate.download")}
            </ButtonLink>
          </div>
          {failed ? <p className="m-0 font-semibold">{t("shred.certificate.pdfFailed")}</p> : null}
          <p className="m-0">
            <Link
              href={`${certificateHref(cert.id)}/verification`}
              className="inline-flex min-h-target items-center underline"
            >
              {t("shred.certificate.verification")}
            </Link>
          </p>
          <p className="m-0 text-body-dense break-all">
            {t("shred.certificate.verificationHint", {
              path: `/v1/destruction-certificates/${cert.id}/verification`,
            })}
          </p>
        </div>
      </Card>
      <Card as="section" title={t("shred.certificate.states")} headingLevel={2}>
        <dl className="m-0 flex flex-col gap-3">
          {rows.map((row) => (
            <div key={row.term} className="flex flex-col gap-1">
              <dt className="text-body-dense font-semibold">{row.term}</dt>
              <dd
                className={`m-0 whitespace-pre-wrap ${row.code ? "break-all font-mono text-body-dense" : "break-words"}`}
              >
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
      </Card>
      <p className="m-0">
        <Link href={RETENTION_PAGE} className="inline-flex min-h-target items-center underline">
          {t("shred.certificate.back")}
        </Link>
      </p>
    </div>
  );
}
