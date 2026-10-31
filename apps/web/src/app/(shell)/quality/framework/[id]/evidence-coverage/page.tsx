import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { QualityChip } from "@/components/quality/QualityChip";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { getShellContext, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import { readOrFail } from "@/lib/person-record";
import { coverageChip, coverageRows, evidenceManaged } from "@/lib/quality-programme";

export const metadata: Metadata = { title: t("quality.coverage.title") };

/**
 * Evidence coverage (QUAL-002; rule 7): every statement of the version in the framework's own
 * order with how many records evidence it, and the gaps said in words where they fall, never
 * sorted away; each statement opens its evidence.
 */
export default async function CoveragePage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { me } = await getShellContext();
  const title = t("quality.coverage.title");
  if (!evidenceManaged(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const path = `/quality/framework/${id}/evidence-coverage`;
  const [detail, coverage] = await Promise.all([
    api.GET("/v1/quality/frameworks/{id}", { params: { path: { id } } }),
    api.GET("/v1/quality/frameworks/{id}/coverage", { params: { path: { id } } }),
  ]);
  const version = readOrFail(detail, path);
  const counts = readOrFail(coverage, path);
  if (!version || !counts) return <SafetyForbidden title={title} />;
  const rows = coverageRows(counts, version);
  const gaps = rows.filter((r) => r.records === 0).length;

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6 break-words">
      <PageHeader title={title} description={t("quality.coverage.description")} />
      <p className="m-0 font-semibold">
        {t("quality.coverage.summary", { gaps, total: rows.length })}
      </p>
      {version.keyQuestions.map((question) => (
        <Card key={question.id} as="section" title={question.title} headingLevel={2}>
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {rows
              .filter((r) => r.keyQuestionId === question.id)
              .map((row) => (
                <li
                  key={row.id}
                  className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2"
                >
                  <Link
                    href={`/quality/framework/${id}/statements/${encodeURIComponent(row.id)}`}
                    className="inline-flex min-h-target items-center underline"
                  >
                    {row.title}
                  </Link>
                  <QualityChip chip={coverageChip(row.records, t)} />
                </li>
              ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}
