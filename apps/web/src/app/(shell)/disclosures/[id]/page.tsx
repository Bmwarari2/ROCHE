import { Card, PageHeader } from "@harbour/ui";
import { CircleAlert, Download } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PersonNeeds } from "@/components/safety/PersonNeeds";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import {
  CollectForm,
  DecideForm,
  HandOverForm,
  PreventionReportForm,
  VersionedStepForm,
  WithdrawForm,
} from "@/components/safety-events/DisclosureForms";
import { SiloStatus } from "@/components/safety-events/SiloStatus";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import {
  canApproveDisclosures,
  canManageDisclosures,
  disclosureDueChip,
  disclosureStateChip,
  disclosureSteps,
  disclosuresShown,
  handOverStep,
  itemDecisionChip,
  loggedByReader,
  preventionChip,
  recordKind,
  recordReference,
} from "@/lib/disclosures";
import { formatDate, formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { personNames } from "@/lib/people";
import { getPerson } from "@/lib/person-record";

export const metadata: Metadata = { title: t("disclosures.recordTitle") };

function Row({ term, value }: { readonly term: string; readonly value: string | null }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-body-dense font-semibold">{term}</dt>
      <dd className="m-0 whitespace-pre-wrap break-words">
        {value ?? t("disclosures.notRecorded")}
      </dd>
    </div>
  );
}

/**
 * One disclosure request: its legal basis in words, who asked and why, then the steps in order
 * (collect, review each record, prepare, approve or refuse, release) with the records and what was
 * not searched. Approval is by a holder of safety.disclosure.approve who did not prepare it; the
 * API refuses anyone else, and release needs a fresh second factor.
 */
const DOWNLOAD_PROBLEMS = {
  "step-up": "disclosures.handOver.downloadStepUp",
  already: "disclosures.handOver.downloadAlready",
  failed: "disclosures.handOver.downloadFailed",
} as const;

export default async function DisclosurePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ download?: string }>;
}) {
  const { id } = await params;
  const { download } = await searchParams;
  const downloadProblem =
    download && download in DOWNLOAD_PROBLEMS
      ? DOWNLOAD_PROBLEMS[download as keyof typeof DOWNLOAD_PROBLEMS]
      : null;
  if (!isUuid(id)) notFound();
  const { me } = await getShellContext();
  const title = t("disclosures.recordTitle");
  if (!disclosuresShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const { data, error, response } = await api.GET("/v1/disclosures/{id}", {
    params: { path: { id } },
  });
  if (!data) {
    if (problemCode(error) === "missing_permission") return <SafetyForbidden title={title} />;
    if (response.status === 404) notFound();
    return failWith(error, response, `/disclosures/${id}`);
  }
  const manage = canManageDisclosures(me.permissions);
  const approve = canApproveDisclosures(me.permissions);
  const items = data.collectedAt
    ? ((await api.GET("/v1/disclosures/{id}/items", { params: { path: { id } } })).data?.items ??
      [])
    : [];
  const pack =
    data.state === "released"
      ? (await api.GET("/v1/disclosures/{id}/pack", { params: { path: { id } } })).data
      : null;
  const person = (await getPerson(data.personId)).person;
  const steps = disclosureSteps(data);
  const handOver = handOverStep(data);
  const due = disclosureDueChip(data, t);
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <SiloStatus />
      <PageHeader
        title={t("disclosures.itemTitle", {
          type: t("disclosures.type", { value: data.type }),
          organisation: data.requester.organisation,
          when: formatDateTime(data.receivedAt) ?? "",
        })}
      />
      <p className="m-0 flex flex-wrap gap-2">
        <SafetyChip chip={disclosureStateChip(data.state, t)} />
        {due ? <SafetyChip chip={due} /> : null}
      </p>
      <Card as="section" headingLevel={2} title={t("disclosures.detail.request")}>
        {/* Communication needs sit outside the list: they are a list of their own (WCAG 1.3.1). */}
        {person ? (
          <div className="mb-3">
            <PersonNeeds person={person} />
          </div>
        ) : null}
        <dl className="m-0 flex flex-col gap-3">
          <Row
            term={t("disclosures.detail.person")}
            value={person ? personNames(person).full : t("disclosures.personHidden")}
          />
          <Row term={t("disclosures.detail.legalBasis")} value={data.legalBasis} />
          <Row term={t("disclosures.form.name")} value={data.requester.name} />
          <Row term={t("disclosures.form.organisation")} value={data.requester.organisation} />
          <Row term={t("disclosures.form.reference")} value={data.requester.reference} />
          <Row term={t("disclosures.form.purpose")} value={data.statedPurpose} />
          {data.reason ? <Row term={t("disclosures.detail.reason")} value={data.reason} /> : null}
        </dl>
      </Card>

      <Card as="section" headingLevel={2} title={t("disclosures.detail.records")}>
        <div className="flex flex-col gap-4">
          {data.collectedAt ? (
            <p className="m-0">
              {t("disclosures.detail.counts", {
                total: data.items.total,
                pending: data.items.pending,
                disclose: data.items.disclose,
                redact: data.items.redact,
                withhold: data.items.withhold,
              })}
            </p>
          ) : (
            <p className="m-0">{t("disclosures.detail.notCollected")}</p>
          )}
          {manage && steps.includes("collect") ? (
            <CollectForm id={data.id} collected={data.collectedAt !== null} />
          ) : null}
          {items.length > 0 ? (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {items.map((item) => (
                <li key={item.id} className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/disclosures/${data.id}/items/${item.id}`}
                    className="inline-flex min-h-target items-center underline"
                  >
                    {t("disclosures.item.title", {
                      kind: recordKind(item.tableName),
                      reference: recordReference(item.recordId),
                    })}
                  </Link>
                  <SafetyChip chip={itemDecisionChip(item.decision, t)} />
                </li>
              ))}
            </ul>
          ) : null}
          {data.notSearched.length > 0 ? (
            <div className="flex flex-col gap-1">
              <h3 className="m-0 text-body font-semibold">{t("disclosures.detail.notSearched")}</h3>
              <ul className="m-0 flex flex-col gap-1 pl-5">
                {data.notSearched.map((n) => (
                  <li key={n.table}>
                    {t("disclosures.detail.notSearchedItem", {
                      kind: recordKind(n.table),
                      guidance: n.guidance,
                    })}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </Card>

      {manage && steps.includes("prepare") ? (
        <Card
          as="section"
          headingLevel={2}
          title={t("disclosures.step.title", { step: "prepare" })}
        >
          <VersionedStepForm id={data.id} version={data.version} step="prepare" />
        </Card>
      ) : null}
      {steps.includes("decide") ? (
        <Card as="section" headingLevel={2} title={t("disclosures.decide.title")}>
          {approve && loggedByReader(data, me.tenantUserId) ? (
            <p className="m-0">{t("disclosures.decide.notYou")}</p>
          ) : approve ? (
            <div className="flex flex-col gap-3">
              <p className="m-0">{t("disclosures.decide.who")}</p>
              <DecideForm id={data.id} version={data.version} />
            </div>
          ) : (
            <p className="m-0">{t("disclosures.decide.waiting")}</p>
          )}
        </Card>
      ) : null}
      {manage && steps.includes("release") ? (
        <Card
          as="section"
          headingLevel={2}
          title={t("disclosures.step.title", { step: "release" })}
        >
          <VersionedStepForm id={data.id} version={data.version} step="release" />
        </Card>
      ) : null}
      {pack ? (
        <Card as="section" headingLevel={2} title={t("disclosures.pack.title")}>
          <dl className="m-0 flex flex-col gap-3">
            <Row term={t("disclosures.pack.issued")} value={formatDateTime(pack.generatedAt)} />
            <Row
              term={t("disclosures.pack.contents")}
              value={t("disclosures.pack.counts", {
                records: pack.records.length,
                redacted: pack.redactedCount,
                withheld: pack.withheldCount,
              })}
            />
            <Row term={t("disclosures.pack.fingerprint")} value={pack.sha256} />
          </dl>
        </Card>
      ) : null}
      {handOver !== "none" ? (
        <Card as="section" headingLevel={2} title={t("disclosures.handOver.title")}>
          <div className="flex flex-col gap-3">
            <p className="m-0">{t("disclosures.handOver.explain")}</p>
            {downloadProblem ? (
              <p role="alert" className="m-0 flex items-start gap-2 font-semibold">
                <CircleAlert size={18} strokeWidth={1.5} aria-hidden className="mt-1 shrink-0" />
                <span>{t(downloadProblem)}</span>
              </p>
            ) : null}
            {handOver === "download" ? (
              manage ? (
                <>
                  <p className="m-0">{t("disclosures.handOver.downloadOnce")}</p>
                  <p className="m-0">
                    <a
                      href={`/disclosures/${data.id}/pack`}
                      className="inline-flex min-h-target items-center gap-2 underline"
                    >
                      <Download size={18} strokeWidth={1.5} aria-hidden />
                      {t("disclosures.handOver.download")}
                    </a>
                  </p>
                </>
              ) : (
                <p className="m-0">{t("disclosures.handOver.notYet")}</p>
              )
            ) : null}
            {data.packDownloadedAt ? (
              <p className="m-0">
                {t("disclosures.handOver.downloaded", {
                  when: formatDateTime(data.packDownloadedAt) ?? "",
                })}
              </p>
            ) : null}
            {handOver === "record" && manage ? (
              <HandOverForm id={data.id} version={data.version} />
            ) : null}
            {data.handOver ? (
              <dl className="m-0 flex flex-col gap-3">
                <Row
                  term={t("disclosures.handOver.recorded", {
                    when: formatDateTime(data.handOver.at) ?? "",
                  })}
                  value={t("disclosures.handOver.routeOption", { route: data.handOver.route })}
                />
                {data.handOver.reference ? (
                  <Row term={t("disclosures.handOver.reference")} value={data.handOver.reference} />
                ) : null}
              </dl>
            ) : null}
          </div>
        </Card>
      ) : null}
      {data.type === "coroner" && manage ? (
        <Card as="section" headingLevel={2} title={t("disclosures.prevention.title")}>
          <div className="flex flex-col gap-3">
            <p className="m-0">{t("disclosures.prevention.explain")}</p>
            {data.prevention ? (
              <p className="m-0 flex flex-wrap gap-2">
                <SafetyChip chip={preventionChip(data.prevention, t, formatDate)} />
              </p>
            ) : null}
            <PreventionReportForm id={data.id} version={data.version} />
          </div>
        </Card>
      ) : null}
      {manage && steps.includes("withdraw") ? (
        <Card as="section" headingLevel={2} title={t("disclosures.withdraw.title")}>
          <WithdrawForm id={data.id} version={data.version} />
        </Card>
      ) : null}
    </div>
  );
}
