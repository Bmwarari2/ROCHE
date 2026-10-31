import type { PersonSummary } from "@harbour/contracts";
import { Card, PageHeader } from "@harbour/ui";
import { TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Notice } from "@/components/care/Notice";
import { PersonNeeds } from "@/components/safety/PersonNeeds";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import {
  CloseOutbreakForm,
  RecordCaseForm,
  UpdateOutbreakForm,
} from "@/components/safety-events/OutbreakForms";
import { SiloStatus } from "@/components/safety-events/SiloStatus";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { formatDate, formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { notificationClockChip } from "@/lib/incidents";
import { caseRowChip, outbreakStateChip, outbreaksShown } from "@/lib/outbreaks";
import { personNames } from "@/lib/people";

export const metadata: Metadata = { title: t("outbreaks.recordTitle") };

function Row({ term, value }: { readonly term: string; readonly value: string | number | null }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-body-dense font-semibold">{term}</dt>
      <dd className="m-0 break-words">{value ?? t("outbreaks.notRecorded")}</dd>
    </div>
  );
}

/**
 * One outbreak (SAFE-013): its state, the line list (every row, current or superseded in words),
 * the UKHSA report fields Harbour fills from it with what is still missing, a link to the report in
 * the notification centre (never a second copy of it), and the forms to record a case, update the
 * organism and reference, and close.
 */
export default async function OutbreakPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { me } = await getShellContext();
  const title = t("outbreaks.recordTitle");
  if (!outbreaksShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const { data, error, response } = await api.GET("/v1/safety/outbreaks/{id}", {
    params: { path: { id } },
  });
  if (!data) {
    if (problemCode(error) === "missing_permission") return <SafetyForbidden title={title} />;
    if (response.status === 404) notFound();
    return failWith(error, response, `/outbreaks/${id}`);
  }
  const listed = await api.GET("/v1/people", {
    params: { query: { locationId: data.locationId } },
  });
  const summaries = listed.data?.items ?? [];
  const people = summaries.map((p) => ({ id: p.id, name: personNames(p).full }));
  const nameOf = new Map(people.map((p) => [p.id, p.name]));
  const personOf = new Map(summaries.map((p) => [p.id, p]));
  const open = data.state === "declared";
  const report = data.report;
  // Staff cannot be added on these screens yet, so a staff figure of 0 is not a fact (HZ-013).
  const staffNotCollected = report.staffCases === 0;
  const missing = staffNotCollected
    ? [...report.missing, t("outbreaks.report.staffMissing")]
    : report.missing;
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <SiloStatus />
      <PageHeader
        title={t("outbreaks.itemTitle", {
          syndrome: t("outbreaks.syndrome", { value: data.syndrome }),
          when: formatDateTime(data.declaredAt) ?? "",
        })}
      />
      <p className="m-0 flex flex-wrap gap-2">
        <SafetyChip chip={outbreakStateChip(data.state, t)} />
      </p>
      <Card as="section" headingLevel={2} title={t("outbreaks.report.title")}>
        <div className="flex flex-col gap-4">
          {data.notification ? (
            <div className="flex flex-col gap-2">
              <p className="m-0 flex flex-wrap items-center gap-2">
                <SafetyChip chip={notificationClockChip(data.notification, new Date(), t)} />
              </p>
              <p className="m-0">
                <Link
                  href={`/notifications/statutory/${data.notification.id}`}
                  className="inline-flex min-h-target items-center underline"
                >
                  {t("outbreaks.report.open")}
                </Link>
              </p>
            </div>
          ) : (
            <p className="m-0">{t("outbreaks.report.notShown")}</p>
          )}
          {missing.length > 0 ? (
            <Notice
              tone="warning"
              icon={<TriangleAlert size={20} strokeWidth={1.5} aria-hidden="true" />}
              title={t("outbreaks.report.missing")}
            >
              <ul className="m-0 flex flex-col gap-1 pl-5">
                {missing.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </Notice>
          ) : null}
          <dl className="m-0 grid gap-3 sm:grid-cols-2">
            <Row term={t("outbreaks.report.setting")} value={report.settingName} />
            <Row term={t("outbreaks.report.organism")} value={report.organism} />
            <Row term={t("outbreaks.report.declaredOn")} value={formatDate(report.declaredOn)} />
            <Row term={t("outbreaks.report.residentCases")} value={report.residentCases} />
            <Row
              term={t("outbreaks.report.staffCases")}
              value={
                staffNotCollected ? t("outbreaks.report.staffNotCollected") : report.staffCases
              }
            />
            <Row term={t("outbreaks.report.firstOnset")} value={formatDate(report.firstOnsetOn)} />
            <Row
              term={t("outbreaks.report.latestOnset")}
              value={formatDate(report.latestOnsetOn)}
            />
            <Row term={t("outbreaks.report.tested")} value={report.tested} />
            <Row term={t("outbreaks.report.positive")} value={report.positive} />
            <Row term={t("outbreaks.report.pending")} value={report.pending} />
            <Row term={t("outbreaks.report.hospitalised")} value={report.hospitalised} />
            <Row term={t("outbreaks.report.died")} value={report.died} />
          </dl>
          <p className="m-0 text-body-dense text-text-secondary">
            {t("outbreaks.report.source", {
              source: report.source.source,
              provision: report.source.provision,
            })}
          </p>
        </div>
      </Card>
      <Card as="section" headingLevel={2} title={t("outbreaks.lineList.title")}>
        <div className="flex flex-col gap-3">
          {data.rowsNotShown > 0 ? (
            <p className="m-0">{t("outbreaks.lineList.notShown", { count: data.rowsNotShown })}</p>
          ) : null}
          {data.cases.length === 0 ? (
            <p className="m-0">{t("outbreaks.lineList.empty")}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {data.cases.map((row) => (
                <li key={row.id} className="flex flex-col gap-1 border-l-2 border-border pl-3">
                  <p className="m-0 flex flex-wrap items-center gap-2">
                    <span className={row.current ? "font-semibold" : "font-semibold line-through"}>
                      {row.caseType === "staff"
                        ? t("outbreaks.lineList.staff")
                        : (nameOf.get(row.personId ?? "") ?? t("outbreaks.lineList.resident"))}
                    </span>
                    <SafetyChip chip={caseRowChip(row.current, t)} />
                  </p>
                  <p className="m-0 text-body-dense">
                    {t("outbreaks.lineList.summary", {
                      onset: formatDate(row.onsetOn) ?? "",
                      result: t("outbreaks.testResult", { value: row.testResult }),
                      outcome: t("outbreaks.outcome", { value: row.outcome }),
                    })}
                  </p>
                  <p className="m-0 text-body-dense text-text-secondary">
                    {row.symptoms.map((value) => t("outbreaks.symptom", { value })).join(", ")}
                  </p>
                  {row.caseType === "resident" && row.personId && personOf.get(row.personId) ? (
                    <PersonNeeds person={personOf.get(row.personId) as PersonSummary} />
                  ) : null}
                  {open && row.current && row.caseType === "resident" && row.personId ? (
                    <details className="mt-1">
                      <summary className="inline-flex min-h-target cursor-pointer items-center underline">
                        {t("outbreaks.case.update", {
                          name: nameOf.get(row.personId) ?? t("outbreaks.lineList.resident"),
                        })}
                      </summary>
                      <div className="mt-3">
                        <RecordCaseForm
                          id={data.id}
                          people={people}
                          supersedes={{
                            id: row.id,
                            personId: row.personId,
                            onsetOn: row.onsetOn,
                            symptoms: row.symptoms,
                            testType: row.testType,
                            testedOn: row.testedOn,
                            testResult: row.testResult,
                            fluVaccinated: row.fluVaccinated,
                            covidVaccinated: row.covidVaccinated,
                            outcome: row.outcome,
                            outcomeOn: row.outcomeOn,
                          }}
                        />
                      </div>
                    </details>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
      {open ? (
        <>
          <Card as="section" headingLevel={2} title={t("outbreaks.case.title")}>
            <div className="flex flex-col gap-3">
              <p className="m-0">{t("outbreaks.case.staffNote")}</p>
              {people.length === 0 ? (
                <p className="m-0">{t("outbreaks.case.noPeople")}</p>
              ) : (
                <RecordCaseForm id={data.id} people={people} />
              )}
            </div>
          </Card>
          <Card as="section" headingLevel={2} title={t("outbreaks.update.title")}>
            <UpdateOutbreakForm
              id={data.id}
              version={data.version}
              organism={data.organism}
              hptReference={data.hptReference}
            />
          </Card>
          <Card as="section" headingLevel={2} title={t("outbreaks.close.title")}>
            <CloseOutbreakForm id={data.id} version={data.version} stillUnwell={data.stillUnwell} />
          </Card>
        </>
      ) : (
        <Card as="section" headingLevel={2} title={t("outbreaks.closed.title")}>
          <dl className="m-0 flex flex-col gap-3">
            <Row term={t("outbreaks.close.date")} value={formatDate(data.closedOn)} />
            <Row term={t("outbreaks.close.reason")} value={data.closureReason} />
          </dl>
        </Card>
      )}
    </div>
  );
}
