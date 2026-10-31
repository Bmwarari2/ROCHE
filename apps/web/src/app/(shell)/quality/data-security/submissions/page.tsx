import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import {
  CorrectSubmissionForm,
  RecordSubmissionForm,
} from "@/components/quality/DataSecurityForms";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { getShellContext, tenantApi } from "@/lib/api";
import { dataSecurityShown } from "@/lib/data-security";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { readOrFail } from "@/lib/person-record";
import { qualityDone } from "@/lib/quality-done";

export const metadata: Metadata = { title: t("quality.dataSecurity.submissions.title") };

/**
 * DSPT submissions (QUAL-012; rule 35): one per financial year, newest first, with the outcome
 * and reference; correcting one keeps the earlier values in its history. Recording this year's
 * submission is offered until it is recorded.
 */
export default async function SubmissionsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ done?: string | string[] }>;
}) {
  const { me } = await getShellContext();
  const title = t("quality.dataSecurity.submissions.title");
  if (!dataSecurityShown(me.permissions))
    return <SafetyForbidden title={title} hint={t("quality.dataSecurity.organisationOnly")} />;
  const api = await tenantApi();
  const path = "/quality/data-security/submissions";
  const [submissions, overview] = await Promise.all([
    api.GET("/v1/data-security/dspt/submissions"),
    api.GET("/v1/data-security"),
  ]);
  const list = readOrFail(submissions, path);
  const now = readOrFail(overview, path);
  if (!list || !now)
    return <SafetyForbidden title={title} hint={t("quality.dataSecurity.organisationOnly")} />;
  const year = now.dspt.financialYear;
  const recorded = list.items.some((s) => s.financialYear === year);
  const done = qualityDone((await searchParams).done);

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6 break-words">
      <PageHeader title={title} description={t("quality.dataSecurity.submissions.description")} />
      {done ? <RecordedArrival message={t("quality.done", { done })} param="done" /> : null}
      <p className="m-0">
        <Link
          href="/quality/data-security"
          className="inline-flex min-h-target items-center underline"
        >
          {t("quality.dataSecurity.back")}
        </Link>
      </p>
      {recorded ? null : (
        <Card
          as="section"
          title={t("quality.dataSecurity.submissions.recordCard")}
          headingLevel={2}
        >
          <RecordSubmissionForm financialYear={year} path={path} />
        </Card>
      )}
      <Card as="section" title={t("quality.dataSecurity.submissions.listTitle")} headingLevel={2}>
        {list.items.length === 0 ? (
          <p className="m-0">{t("quality.dataSecurity.submissions.none")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-6 p-0">
            {list.items.map((s) => (
              <li key={s.id} className="flex flex-col gap-2 border-b border-border pb-4">
                <h3 className="m-0 text-body font-semibold">
                  {t("quality.dataSecurity.submissions.item", { year: s.financialYear })}
                </h3>
                <span>
                  {t("quality.dataSecurity.submissions.detail", {
                    date: formatDate(s.submittedOn) ?? "",
                    outcome: s.outcome,
                    reference: s.reference ?? "",
                    hasReference: String(s.reference !== null),
                  })}
                </span>
                <details>
                  <summary className="inline-flex min-h-target cursor-pointer items-center underline">
                    {t("quality.dataSecurity.submissions.correctOpen", { year: s.financialYear })}
                  </summary>
                  <div className="pt-4">
                    <CorrectSubmissionForm submission={s} path={path} />
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
