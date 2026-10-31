import { buttonClassName, Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MappingForm } from "@/components/quality/ProgrammeForms";
import { QualityChip } from "@/components/quality/QualityChip";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { getShellContext, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { readOrFail } from "@/lib/person-record";
import { qualityDone } from "@/lib/quality-done";
import { evidenceManaged, frameworkShown, versionChip } from "@/lib/quality-programme";

export const metadata: Metadata = { title: t("quality.framework.title") };

/**
 * One framework version (QUAL-001, QUAL-002): its key questions and statements with the source,
 * and, for those who manage evidence, the organisation's mapping (local titles, owner roles,
 * evidence expected) saved as a new version, and the way to coverage and its gaps.
 */
export default async function FrameworkVersionPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ id: string }>;
  readonly searchParams: Promise<{ done?: string | string[] }>;
}) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { me } = await getShellContext();
  const title = t("quality.framework.title");
  if (!frameworkShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const path = `/quality/framework/${id}`;
  const detail = readOrFail(
    await api.GET("/v1/quality/frameworks/{id}", { params: { path: { id } } }),
    path,
  );
  if (!detail) return <SafetyForbidden title={title} />;
  const manage = evidenceManaged(me.permissions);
  const mapping = manage
    ? (
        await api.GET("/v1/quality/frameworks/{id}/mapping", {
          params: { path: { id }, query: {} },
        })
      ).data
    : undefined;
  const done = qualityDone((await searchParams).done);
  const heading = t("quality.framework.versionTitle", {
    regulator: detail.regulator,
    version: detail.versionNumber,
  });

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6 break-words">
      <PageHeader
        title={heading}
        description={t("quality.framework.detailDescription")}
        {...(manage
          ? {
              primaryAction: (
                <Link
                  href={`${path}/coverage`}
                  className={buttonClassName({ variant: "secondary" })}
                >
                  {t("quality.coverage.open")}
                </Link>
              ),
            }
          : {})}
      />
      {done ? <RecordedArrival message={t("quality.done", { done })} param="done" /> : null}
      <div>
        <QualityChip chip={versionChip(detail, t)} />
      </div>
      <p className="m-0 max-w-prose">
        {t("quality.framework.source", { name: detail.source.name })}{" "}
        <a href={detail.source.url} className="underline" rel="noreferrer" target="_blank">
          {t("quality.framework.sourceLink")}
        </a>
      </p>
      <Card as="section" title={t("quality.framework.statements")} headingLevel={2}>
        <div className="flex flex-col gap-4">
          {detail.keyQuestions.map((question) => (
            <section key={question.id} aria-labelledby={`kq-${question.id}`}>
              <h3 id={`kq-${question.id}`} className="m-0 mb-2 text-body font-semibold">
                {question.title}
              </h3>
              <ul className="m-0 flex flex-col gap-1 pl-5">
                {question.statements.map((s) => (
                  <li key={s.id}>{s.title}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </Card>
      {manage && mapping ? (
        <Card as="section" title={t("quality.mapping.title")} headingLevel={2}>
          <div className="flex flex-col gap-4">
            <p className="m-0 text-body-dense text-text-secondary">
              {mapping.mappingVersion === 0
                ? t("quality.mapping.none")
                : t("quality.mapping.current", {
                    version: mapping.mappingVersion,
                    when: formatDateTime(mapping.madeAt) ?? "",
                  })}
            </p>
            {detail.state === "published" ? (
              <MappingForm frameworkId={id} detail={detail} mapping={mapping} path={path} />
            ) : (
              <p className="m-0">{t("quality.mapping.onlyPublished")}</p>
            )}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
