import { ButtonLink, Card, EmptyState, PageHeader } from "@harbour/ui";
import { ShieldCheck, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Notice } from "@/components/care/Notice";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import {
  safeguardingClockChip,
  safeguardingShown,
  safeguardingStateChip,
} from "@/lib/safeguarding";

export const metadata: Metadata = { title: t("safeguarding.title") };

/**
 * The safeguarding log (SAFE-006; Care Act 2014 s.42): open concerns first, each with its state
 * and its referral clock in an icon and words. Titled by when it was raised, never by the person.
 */
export default async function SafeguardingPage() {
  const { me, locationId } = await getShellContext();
  const title = t("safeguarding.title");
  if (!safeguardingShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const { data, error, response } = await api.GET("/v1/safeguarding/concerns", {});
  if (!data) {
    if (problemCode(error) === "missing_permission") return <SafetyForbidden title={title} />;
    return failWith(error, response, "/safeguarding");
  }
  const location = me.locations.find((l) => l.id === locationId);
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={location ? location.name : me.tenant.name}
        title={title}
        description={t("safeguarding.description")}
        primaryAction={<ButtonLink href="/safeguarding/new">{t("safeguarding.new")}</ButtonLink>}
      />
      {data.truncated ? (
        <Notice
          tone="warning"
          icon={<TriangleAlert size={20} strokeWidth={1.5} aria-hidden="true" />}
          title={t("safeguarding.truncated")}
        />
      ) : null}
      {data.concerns.length === 0 ? (
        <Card>
          <EmptyState
            headingLevel={2}
            icon={<ShieldCheck size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("safeguarding.empty")}
          />
        </Card>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {data.concerns.map((item) => (
            <li key={item.id}>
              <Card
                as="article"
                headingLevel={2}
                className="break-words"
                title={
                  <Link
                    href={`/safeguarding/${item.id}`}
                    className="inline-flex min-h-target items-center underline"
                  >
                    {t("safeguarding.itemTitle", { when: formatDateTime(item.raisedAt) ?? "" })}
                  </Link>
                }
              >
                <div className="flex flex-col gap-2">
                  <p className="m-0 flex flex-wrap items-center gap-2">
                    <SafetyChip chip={safeguardingStateChip(item.state, t)} />
                    <SafetyChip chip={safeguardingClockChip(item.clock, t)} />
                  </p>
                  <p className="m-0 text-body-dense text-text-secondary">
                    {item.abuseTypes
                      .map((value) => t("safeguarding.abuseType", { value }))
                      .join(", ")}
                  </p>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
