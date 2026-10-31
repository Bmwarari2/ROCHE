import { Card, PageHeader } from "@harbour/ui";
import { CircleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Notice } from "@/components/care/Notice";
import {
  AddAssertionForm,
  AssertionStatusForm,
  LinkEvidenceForm,
  UnlinkEvidenceButton,
} from "@/components/quality/DataSecurityForms";
import { QualityChip } from "@/components/quality/QualityChip";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { getShellContext, tenantApi } from "@/lib/api";
import {
  assertionChip,
  dataSecurityShown,
  isFinancialYear,
  metWithoutEvidence,
} from "@/lib/data-security";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { readOrFail } from "@/lib/person-record";
import { qualityDone } from "@/lib/quality-done";

export const metadata: Metadata = { title: t("quality.dataSecurity.assertions.title") };

/**
 * The DSPT assertions for a financial year (QUAL-012; rule 34): each with its status as an icon
 * and a word, its notes and the organisation documents linked as evidence now; met with no
 * evidence is said apart. Change where one stands (met needs evidence, not met and not applicable
 * need notes), link or stop using a document, and track another assertion.
 */
export default async function AssertionsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ year?: string | string[]; done?: string | string[] }>;
}) {
  const query = await searchParams;
  const { me } = await getShellContext();
  const title = t("quality.dataSecurity.assertions.title");
  if (!dataSecurityShown(me.permissions))
    return <SafetyForbidden title={title} hint={t("quality.dataSecurity.organisationOnly")} />;
  const api = await tenantApi();
  const year = isFinancialYear(query.year) ? query.year : undefined;
  const base = "/quality/data-security/assertions";
  const listed = readOrFail(
    await api.GET("/v1/data-security/dspt/assertions", {
      params: { query: year ? { financialYear: year } : {} },
    }),
    base,
  );
  if (!listed)
    return <SafetyForbidden title={title} hint={t("quality.dataSecurity.organisationOnly")} />;
  const path = `${base}?year=${encodeURIComponent(listed.financialYear)}`;
  const documents =
    (
      await api.GET("/v1/documents", { params: { query: { category: "organisation_document" } } })
    ).data?.items.filter((d) => d.status === "available") ?? [];
  const titles = new Map(documents.map((d) => [d.id, d.title]));
  const done = qualityDone(query.done);

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6 break-words">
      <PageHeader
        title={title}
        description={t("quality.dataSecurity.assertions.description", {
          year: listed.financialYear,
        })}
      />
      {done ? <RecordedArrival message={t("quality.done", { done })} param="done" /> : null}
      <p className="m-0">
        <Link
          href="/quality/data-security"
          className="inline-flex min-h-target items-center underline"
        >
          {t("quality.dataSecurity.back")}
        </Link>
      </p>
      {listed.items.length === 0 ? (
        <p className="m-0">{t("quality.dataSecurity.assertions.none")}</p>
      ) : (
        listed.items.map((a) => (
          <Card
            key={a.id}
            as="section"
            title={t("quality.dataSecurity.assertion.heading", {
              ref: a.assertionRef,
              title: a.title,
            })}
            headingLevel={2}
          >
            <div className="flex flex-col gap-4">
              <span>
                <QualityChip chip={assertionChip(a.status, t)} />
              </span>
              {metWithoutEvidence(a) ? (
                <Notice
                  icon={<CircleAlert size={20} aria-hidden="true" />}
                  title={t("quality.dataSecurity.assertion.metNoEvidenceTitle")}
                  tone="warning"
                >
                  <p className="m-0">{t("quality.dataSecurity.assertion.metNoEvidence")}</p>
                </Notice>
              ) : null}
              {a.notes ? <p className="m-0 max-w-prose">{a.notes}</p> : null}
              <section aria-labelledby={`evidence-${a.id}`} className="flex flex-col gap-2">
                <h3 id={`evidence-${a.id}`} className="m-0 text-body font-semibold">
                  {t("quality.dataSecurity.evidence.title", { count: a.evidence.length })}
                </h3>
                {a.evidence.length === 0 ? (
                  <p className="m-0">{t("quality.dataSecurity.evidence.none")}</p>
                ) : (
                  <ul className="m-0 flex list-none flex-col gap-3 p-0">
                    {a.evidence.map((e) => {
                      const name =
                        titles.get(e.documentId) ?? t("quality.dataSecurity.evidence.document");
                      return (
                        <li key={e.documentId} className="flex flex-col gap-2">
                          <Link
                            href={`/documents/${e.documentId}/details`}
                            className="inline-flex min-h-target items-center underline"
                          >
                            {name}
                          </Link>
                          <span className="text-body-dense text-text-secondary">
                            {t("quality.dataSecurity.evidence.linkedAt", {
                              when: formatDateTime(e.linkedAt) ?? "",
                            })}
                          </span>
                          <UnlinkEvidenceButton
                            assertionId={a.id}
                            documentId={e.documentId}
                            title={name}
                            path={path}
                          />
                        </li>
                      );
                    })}
                  </ul>
                )}
                <LinkEvidenceForm
                  assertionId={a.id}
                  assertionRef={a.assertionRef}
                  documents={documents
                    .filter((d) => !a.evidence.some((e) => e.documentId === d.id))
                    .map((d) => ({ id: d.id, title: d.title }))}
                  path={path}
                />
              </section>
              <AssertionStatusForm assertion={a} path={path} />
            </div>
          </Card>
        ))
      )}
      <Card as="section" title={t("quality.dataSecurity.assertions.addCard")} headingLevel={2}>
        <AddAssertionForm financialYear={listed.financialYear} path={path} />
      </Card>
    </div>
  );
}
