import { Card, PageHeader } from "@harbour/ui";
import { TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Notice } from "@/components/care/Notice";
import { PersonNeeds } from "@/components/safety/PersonNeeds";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { ConcernStepForm, UpdateConcernForm } from "@/components/safety-silos/SafeguardingForms";
import { SiloStatus } from "@/components/safety-silos/SiloStatus";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { personNames } from "@/lib/people";
import { getPerson } from "@/lib/person-record";
import {
  safeguardingClockChip,
  safeguardingShown,
  safeguardingStateChip,
} from "@/lib/safeguarding";

export const metadata: Metadata = { title: t("safeguarding.recordTitle") };

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
 * One safeguarding concern: what happened in the raiser's words, the referral clock, what has been
 * recorded, the protective measures, warnings, and each next step with what it still needs.
 */
export default async function ConcernPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { me } = await getShellContext();
  const title = t("safeguarding.recordTitle");
  if (!safeguardingShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const { data, error, response } = await api.GET("/v1/safeguarding/concerns/{id}", {
    params: { path: { id } },
  });
  if (!data) {
    if (problemCode(error) === "missing_permission") return <SafetyForbidden title={title} />;
    if (response.status === 404) notFound();
    return failWith(error, response, `/safeguarding/${id}`);
  }
  const person = (await getPerson(data.personId)).person;
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <SiloStatus />
      <PageHeader
        title={t("safeguarding.itemTitle", { when: formatDateTime(data.raisedAt) ?? "" })}
      />
      <p className="m-0 flex flex-wrap gap-2">
        <SafetyChip chip={safeguardingStateChip(data.state, t)} />
        <SafetyChip chip={safeguardingClockChip(data.clock, t)} />
      </p>
      <Card as="section" headingLevel={2} title={t("safeguarding.detail.person")}>
        {person ? (
          <div className="flex flex-col gap-2">
            <p className="m-0 font-semibold">{personNames(person).full}</p>
            <PersonNeeds person={person} />
          </div>
        ) : (
          <p className="m-0">{t("safeguarding.personHidden")}</p>
        )}
      </Card>
      {data.warnings.map((warning) => (
        <Notice
          key={warning}
          tone="warning"
          icon={<TriangleAlert size={20} strokeWidth={1.5} aria-hidden="true" />}
          title={warning}
        />
      ))}
      <Card as="section" headingLevel={2} title={t("safeguarding.detail.what")}>
        <dl className="m-0 flex flex-col gap-3">
          <Row
            term={t("safeguarding.form.abuseTypes")}
            value={data.abuseTypes
              .map((value) => t("safeguarding.abuseType", { value }))
              .join(", ")}
          />
          <Row term={t("safeguarding.form.description")} value={data.description} />
          <Row term={t("safeguarding.form.measures")} value={data.protectiveMeasures} />
          {data.protectiveMeasures ? (
            <Row
              term={t("safeguarding.detail.measuresOutcome")}
              value={t("safeguarding.measuresOutcome", { outcome: data.measuresOutcome ?? "none" })}
            />
          ) : null}
          {data.referral ? (
            <Row
              term={t("safeguarding.update.referral")}
              value={t("safeguarding.detail.referral", {
                authority: data.referral.localAuthority,
                when: formatDateTime(data.referral.referredAt) ?? "",
              })}
            />
          ) : null}
          {data.noReferralReason ? (
            <Row term={t("safeguarding.detail.noReferral")} value={data.noReferralReason} />
          ) : null}
          {data.enquiry ? (
            <Row
              term={t("safeguarding.update.enquiry")}
              value={t("safeguarding.detail.enquiry", {
                kind: t("safeguarding.enquiryKind", { value: data.enquiry.kind }),
                when: formatDateTime(data.enquiry.openedAt) ?? "",
              })}
            />
          ) : null}
          {data.personalOutcomes ? (
            <Row
              term={t("safeguarding.detail.outcomes")}
              value={[
                data.personalOutcomes.asked
                  ? t("safeguarding.detail.outcomesAsked", {
                      desired: data.personalOutcomes.desiredOutcomes ?? "",
                    })
                  : t("safeguarding.detail.outcomesNotAsked", {
                      reason: data.personalOutcomes.notAskedReason ?? "",
                    }),
                data.personalOutcomes.achieved
                  ? t("safeguarding.achieved", { value: data.personalOutcomes.achieved })
                  : null,
              ]
                .filter(Boolean)
                .join(" ")}
            />
          ) : null}
          {data.staffHarm ? (
            <Row
              term={t("safeguarding.update.staffHarm")}
              value={t("safeguarding.staffHarm", { value: data.staffHarm })}
            />
          ) : null}
          {data.dbsReferral ? (
            <Row
              term={t("safeguarding.update.dbs")}
              value={[
                t("safeguarding.detail.dbs", { decision: data.dbsReferral.decision }),
                data.dbsReferral.reason,
              ]
                .filter(Boolean)
                .join(": ")}
            />
          ) : null}
          {data.finding ? (
            <Row
              term={t("safeguarding.update.finding")}
              value={t("safeguarding.finding", { value: data.finding })}
            />
          ) : null}
          {data.closedReason ? (
            <Row term={t("safeguarding.step.reason")} value={data.closedReason} />
          ) : null}
        </dl>
      </Card>
      {data.state !== "closed" ? (
        <Card as="section" headingLevel={2} title={t("safeguarding.update.title")}>
          <UpdateConcernForm
            id={data.id}
            version={data.version}
            protectiveMeasures={data.protectiveMeasures}
            measuresOutcome={data.measuresOutcome}
          />
        </Card>
      ) : null}
      {data.nextSteps.map((step) => (
        <Card
          key={step.to}
          as="section"
          headingLevel={2}
          title={t("safeguarding.step.title", { to: step.to })}
        >
          <ConcernStepForm id={data.id} version={data.version} to={step.to} needs={step.needs} />
        </Card>
      ))}
    </div>
  );
}
