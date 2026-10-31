import { buttonClassName, Card, EmptyState, PageHeader } from "@harbour/ui";
import { BookOpen } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { QualityChip } from "@/components/quality/QualityChip";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { getShellContext, tenantApi } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { readOrFail } from "@/lib/person-record";
import { policiesManaged, reviewChip, signChip } from "@/lib/policies";
import { qualityDone } from "@/lib/quality-done";

export const metadata: Metadata = { title: t("quality.policies.title") };

/**
 * The policy library (QUAL-008; quality.md section 22; HZ-128), for every member: first the
 * policies the reader must read and sign, then every policy with its version in force only, its
 * review status and whether the reader has signed, each as an icon and a word.
 */
export default async function PoliciesPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ done?: string | string[] }>;
}) {
  const { me } = await getShellContext();
  const title = t("quality.policies.title");
  const api = await tenantApi();
  const [library, mine] = await Promise.all([api.GET("/v1/policies"), api.GET("/v1/me/policies")]);
  const list = readOrFail(library, "/policies");
  const toSign = readOrFail(mine, "/policies");
  if (!list || !toSign) return <SafetyForbidden title={title} />;
  const manage = policiesManaged(me.permissions);
  const done = qualityDone((await searchParams).done);

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6 break-words">
      <PageHeader
        title={title}
        description={t("quality.policies.description")}
        {...(manage
          ? {
              primaryAction: (
                <Link href="/policies/new" className={buttonClassName({ variant: "primary" })}>
                  {t("quality.policies.new.open")}
                </Link>
              ),
            }
          : {})}
      />
      {done ? <RecordedArrival message={t("quality.done", { done })} param="done" /> : null}
      <Card as="section" title={t("quality.policies.mine.title")} headingLevel={2}>
        {toSign.items.length === 0 ? (
          <p className="m-0">{t("quality.policies.mine.none")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {toSign.items.map((item) => (
              <li key={item.versionId} className="flex flex-col gap-1">
                <Link
                  href={`/policies/${item.policyId}`}
                  className="inline-flex min-h-target items-center font-semibold underline"
                >
                  {t("quality.policies.mine.item", { title: item.title, n: item.versionNumber })}
                </Link>
                <span className="text-body-dense text-text-secondary">
                  {t("quality.policies.mine.since", { date: formatDate(item.dueFrom) ?? "" })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {list.items.length === 0 ? (
        <EmptyState
          icon={<BookOpen size={32} strokeWidth={1.5} aria-hidden="true" />}
          title={t("quality.policies.empty")}
          description={t("quality.policies.emptyHint")}
        />
      ) : (
        <Card as="section" title={t("quality.policies.library")} headingLevel={2}>
          <ul className="m-0 flex list-none flex-col gap-4 p-0">
            {list.items.map((policy) => {
              const sign = signChip(policy, t);
              return (
                <li key={policy.id} className="flex flex-col gap-1 border-b border-border pb-3">
                  <h3 className="m-0 text-body font-semibold">
                    <Link
                      href={`/policies/${policy.id}`}
                      className="inline-flex min-h-target items-center underline"
                    >
                      {policy.title}
                    </Link>
                  </h3>
                  {policy.inForce ? (
                    <>
                      <span className="flex flex-wrap gap-2">
                        <QualityChip chip={reviewChip(policy.inForce.reviewStatus, t)} />
                        {sign ? <QualityChip chip={sign} /> : null}
                      </span>
                      <span className="text-body-dense text-text-secondary">
                        {t("quality.policies.inForce", {
                          n: policy.inForce.versionNumber,
                          date: formatDate(policy.inForce.publishedOn) ?? "",
                          review: formatDate(policy.inForce.reviewDueOn) ?? "",
                          hasReview: String(policy.inForce.reviewDueOn !== null),
                        })}
                      </span>
                    </>
                  ) : (
                    <span className="text-body-dense text-text-secondary">
                      {t("quality.policies.notYetPublished")}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}
