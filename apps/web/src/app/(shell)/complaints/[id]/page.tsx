import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { ComplaintStepForm } from "@/components/safety-silos/ComplaintForms";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import {
  complaintMoves,
  complaintStateChip,
  complaintsShown,
  complaintTargets,
} from "@/lib/complaints";
import { isUuid } from "@/lib/context-cookies";
import { formatDate, formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: t("complaints.recordTitle") };

function Row({ term, value }: { readonly term: string; readonly value: string | null }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-body-dense font-semibold">{term}</dt>
      <dd className="m-0 whitespace-pre-wrap break-words">
        {value ?? t("complaints.notRecorded")}
      </dd>
    </div>
  );
}

/**
 * One complaint: who made it and how, what it is about, its targets and the Ombudsman's time
 * limit in words, any response and appeal, and the steps the reader may take next. The API checks
 * each step, and refuses a response without the Ombudsman signposted and a kept copy.
 */
export default async function ComplaintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { me } = await getShellContext();
  const title = t("complaints.recordTitle");
  if (!complaintsShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const { data, error, response } = await api.GET("/v1/complaints/{id}", {
    params: { path: { id } },
  });
  if (!data) {
    if (problemCode(error) === "missing_permission") return <SafetyForbidden title={title} />;
    if (response.status === 404) notFound();
    return failWith(error, response, `/complaints/${id}`);
  }
  const moves = complaintMoves(data.state);
  const needsDocument = moves.some((m) => m === "responded" || m === "appeal_responded");
  const documents = needsDocument
    ? ((await api.GET("/v1/documents", {})).data?.items ?? []).map((d) => ({
        id: d.id,
        title: d.title,
      }))
    : [];
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        title={t("complaints.itemTitle", { when: formatDateTime(data.receivedAt) ?? "" })}
        description={complaintTargets(data, t).join(" ")}
      />
      <p className="m-0 flex flex-wrap gap-2">
        <SafetyChip chip={complaintStateChip(data.state, t)} />
      </p>
      <Card as="section" headingLevel={2} title={t("complaints.detail.about")}>
        <dl className="m-0 flex flex-col gap-3">
          <Row term={t("complaints.form.name")} value={data.complainantName} />
          <Row
            term={t("complaints.form.relationship")}
            value={t("complaints.relationship", { value: data.complainantRelationship })}
          />
          <Row term={t("complaints.form.contact")} value={data.complainantContact} />
          <Row
            term={t("complaints.form.channel")}
            value={t("complaints.channel", { value: data.channel })}
          />
          <Row term={t("complaints.form.knew")} value={formatDate(data.knewOfMatterOn)} />
          <Row term={t("complaints.form.summary")} value={data.summary} />
        </dl>
      </Card>
      <Card as="section" headingLevel={2} title={t("complaints.detail.clocks")}>
        <p className="m-0">{data.clocks.wording}</p>
        {data.ombudsman ? <p className="m-0 mt-2">{data.ombudsman.wording}</p> : null}
      </Card>
      {data.response || data.appealReason ? (
        <Card as="section" headingLevel={2} title={t("complaints.detail.response")}>
          <dl className="m-0 flex flex-col gap-3">
            {data.response ? (
              <>
                <Row
                  term={t("complaints.step.outcome")}
                  value={t("complaints.outcome", { value: data.response.outcome })}
                />
                <Row term={t("complaints.step.actions")} value={data.response.actionsTaken} />
              </>
            ) : null}
            {data.appealReason ? (
              <Row term={t("complaints.step.appealReason")} value={data.appealReason} />
            ) : null}
            {data.appealResponse ? (
              <Row
                term={t("complaints.detail.appealOutcome")}
                value={t("complaints.outcome", { value: data.appealResponse.outcome })}
              />
            ) : null}
            {data.closedReason ? (
              <Row term={t("complaints.step.reason")} value={data.closedReason} />
            ) : null}
          </dl>
        </Card>
      ) : null}
      {moves.map((to) => (
        <Card key={to} as="section" headingLevel={2} title={t("complaints.step.title", { to })}>
          <ComplaintStepForm id={data.id} version={data.version} to={to} documents={documents} />
        </Card>
      ))}
    </div>
  );
}
