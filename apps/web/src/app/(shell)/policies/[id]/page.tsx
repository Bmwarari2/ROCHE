import { Card, PageHeader } from "@harbour/ui";
import { Info } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Notice } from "@/components/care/Notice";
import {
  EditDraftForm,
  PublishForm,
  RetirePolicyForm,
  SignForm,
  StartDraftForm,
} from "@/components/quality/PolicyForms";
import { QualityChip } from "@/components/quality/QualityChip";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { getShellContext, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { formatDate, formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { readOrFail } from "@/lib/person-record";
import {
  inForceFor,
  policiesManaged,
  reviewChip,
  signChip,
  versionStateChip,
} from "@/lib/policies";
import { qualityDone } from "@/lib/quality-done";

export const metadata: Metadata = { title: t("quality.policies.detailTitle") };

/**
 * One policy (QUAL-008; rules 25 to 28; HZ-128): the version in force with its text or document,
 * who must read and sign it, and the reader's own read-and-sign; for those who manage policies, who
 * has signed and who is outstanding since when, the draft with its publishing (by someone else
 * where a second reviewer is needed), and retiring. The change log lists every version; a
 * superseded one names the version in force, so it is never read as current.
 */
export default async function PolicyPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ id: string }>;
  readonly searchParams: Promise<{ done?: string | string[] }>;
}) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { me } = await getShellContext();
  const api = await tenantApi();
  const path = `/policies/${id}`;
  const policy = readOrFail(await api.GET("/v1/policies/{id}", { params: { path: { id } } }), path);
  if (!policy) return <SafetyForbidden title={t("quality.policies.detailTitle")} />;
  const manage = policiesManaged(me.permissions);
  const current = policy.inForce;
  const versions = policy.versions.filter((v): v is NonNullable<typeof v> => v !== null);
  const draft = versions.find((v) => v.state === "draft") ?? null;
  const [readAndSign, documents] = await Promise.all([
    manage && current
      ? api
          .GET("/v1/policies/{id}/versions/{versionId}/read-and-sign", {
            params: { path: { id, versionId: current.id } },
          })
          .then((r) => r.data ?? null)
      : null,
    manage && draft
      ? api
          .GET("/v1/documents", { params: { query: { category: "organisation_document" } } })
          .then((r) => r.data?.items.filter((d) => d.status === "available") ?? [])
      : [],
  ]);
  const done = qualityDone((await searchParams).done);
  const sign = signChip(policy, t);
  const authorOfDraft = draft !== null && draft.authorId === me.tenantUserId;

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6 break-words">
      <PageHeader title={policy.title} description={t("quality.policies.detailDescription")} />
      {done ? <RecordedArrival message={t("quality.done", { done })} param="done" /> : null}
      <p className="m-0">
        <Link href="/policies" className="inline-flex min-h-target items-center underline">
          {t("quality.policies.back")}
        </Link>
      </p>
      {policy.retiredAt ? (
        <Notice
          icon={<Info size={20} aria-hidden="true" />}
          title={t("quality.policies.retiredTitle")}
        >
          <p className="m-0">
            {t("quality.policies.retiredOn", { when: formatDateTime(policy.retiredAt) ?? "" })}
          </p>
        </Notice>
      ) : null}

      <Card as="section" title={t("quality.policies.current.title")} headingLevel={2}>
        {current ? (
          <div className="flex flex-col gap-3">
            <p className="m-0 flex flex-wrap gap-2">
              <QualityChip chip={versionStateChip(current.state, t)} />
              {current.reviewStatus ? (
                <QualityChip chip={reviewChip(current.reviewStatus, t)} />
              ) : null}
              {sign ? <QualityChip chip={sign} /> : null}
            </p>
            <p className="m-0 text-body-dense text-text-secondary">
              {t("quality.policies.versionLine", {
                n: current.versionNumber,
                change: current.change,
                date: formatDate(current.publishedOn) ?? "",
                review: formatDate(current.reviewDueOn) ?? "",
                hasReview: String(current.reviewDueOn !== null),
              })}
            </p>
            {current.body ? (
              <div className="max-w-prose whitespace-pre-wrap rounded-card border border-border p-4">
                {current.body}
              </div>
            ) : null}
            {current.documentId ? (
              <p className="m-0">
                <Link
                  href={`/documents/${current.documentId}/details`}
                  className="inline-flex min-h-target items-center underline"
                >
                  {t("quality.policies.openDocument", { n: current.versionNumber })}
                </Link>
              </p>
            ) : null}
            <p className="m-0">
              {current.roles.length === 0
                ? t("quality.policies.rolesNone")
                : t("quality.policies.rolesList", {
                    roles: current.roles
                      .map((role) => t("quality.policies.role", { role }))
                      .join(", "),
                  })}
            </p>
            {policy.mustSign && !policy.signed ? (
              <SignForm policyId={id} version={current} path={path} />
            ) : null}
          </div>
        ) : (
          <p className="m-0">{t("quality.policies.notYetPublished")}</p>
        )}
      </Card>

      {manage && current && readAndSign ? (
        <Card as="section" title={t("quality.policies.status.title")} headingLevel={2}>
          <div className="flex flex-col gap-4">
            <p className="m-0 font-semibold">
              {t("quality.policies.status.summary", {
                signed: readAndSign.signed.length,
                required: readAndSign.required,
              })}
            </p>
            <section aria-labelledby="outstanding" className="flex flex-col gap-2">
              <h3 id="outstanding" className="m-0 text-body font-semibold">
                {t("quality.policies.status.outstanding", {
                  count: readAndSign.outstanding.length,
                })}
              </h3>
              {readAndSign.outstanding.length === 0 ? (
                <p className="m-0">{t("quality.policies.status.noneOutstanding")}</p>
              ) : (
                <ul className="m-0 flex flex-col gap-1 pl-5">
                  {readAndSign.outstanding.map((m) => (
                    <li key={m.memberId}>
                      {t("quality.policies.status.outstandingSince", {
                        name: m.displayName,
                        date: formatDate(m.dueFrom) ?? "",
                      })}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section aria-labelledby="signed" className="flex flex-col gap-2">
              <h3 id="signed" className="m-0 text-body font-semibold">
                {t("quality.policies.status.signed", { count: readAndSign.signed.length })}
              </h3>
              {readAndSign.signed.length === 0 ? (
                <p className="m-0">{t("quality.policies.status.noneSigned")}</p>
              ) : (
                <ul className="m-0 flex flex-col gap-1 pl-5">
                  {readAndSign.signed.map((m) => (
                    <li key={m.memberId}>{m.displayName}</li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </Card>
      ) : null}

      {manage && !policy.retiredAt ? (
        <Card as="section" title={t("quality.policies.draft.title")} headingLevel={2}>
          {draft ? (
            <div className="flex flex-col gap-6">
              <EditDraftForm
                policyId={id}
                draft={draft}
                documents={documents.map((d) => ({ id: d.id, title: d.title }))}
                path={path}
              />
              {policy.requireSecondReviewer && authorOfDraft ? (
                <Notice
                  icon={<Info size={20} aria-hidden="true" />}
                  title={t("quality.policies.publish.secondReviewerTitle")}
                >
                  <p className="m-0">{t("quality.policies.publish.secondReviewer")}</p>
                </Notice>
              ) : (
                <PublishForm policyId={id} draft={draft} path={path} />
              )}
            </div>
          ) : (
            <StartDraftForm policyId={id} path={path} />
          )}
        </Card>
      ) : null}

      <Card as="section" title={t("quality.policies.log.title")} headingLevel={2}>
        <ol className="m-0 flex list-none flex-col gap-4 p-0">
          {versions.map((version) => {
            const now = inForceFor({ versions }, version);
            return (
              <li key={version.id} className="flex flex-col gap-1 border-b border-border pb-3">
                <h3 className="m-0 text-body font-semibold">
                  {t("quality.policies.log.version", {
                    n: version.versionNumber,
                    change: version.change,
                  })}
                </h3>
                <span>
                  <QualityChip chip={versionStateChip(version.state, t)} />
                </span>
                <span>{version.changeSummary}</span>
                {version.publishedOn ? (
                  <span className="text-body-dense text-text-secondary">
                    {t("quality.policies.log.published", {
                      date: formatDate(version.publishedOn) ?? "",
                    })}
                  </span>
                ) : null}
                {now ? (
                  <span className="font-semibold">
                    {t("quality.policies.log.supersededBy", { n: now.versionNumber })}
                  </span>
                ) : null}
                {version.retiredReason ? (
                  <span className="text-body-dense text-text-secondary">
                    {t("quality.policies.log.retiredBecause", { reason: version.retiredReason })}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ol>
      </Card>

      {manage && !policy.retiredAt && current ? (
        <Card as="section" title={t("quality.policies.retire.cardTitle")} headingLevel={2}>
          <RetirePolicyForm policy={policy} path={path} />
        </Card>
      ) : null}
    </div>
  );
}
