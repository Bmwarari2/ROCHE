import { ButtonLink, Card, EmptyState, PageHeader } from "@harbour/ui";
import { Banknote } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PayNotOrganisationWide } from "@/components/pay-time/PayNotOrganisationWide";
import { NewPayRunForm } from "@/components/pay-time/PayTimeForms";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { PAY_MANAGE, payRunChip, payShown } from "@/lib/pay-time";

export const metadata: Metadata = { title: t("payTime.pay.title") };

/**
 * Pay runs (Phase 2 slice 60; SCHED-006, SCHED-007; scheduling.md section 18): each run's period
 * and where it stands in an icon and a word. Pay managers start a run; the rule sets are a link
 * away. The API asks for multi-factor sign-in on every pay screen.
 */
export default async function PayPage() {
  const { me } = await getShellContext();
  const title = t("payTime.pay.title");
  if (!payShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const { data, error, response } = await api.GET("/v1/pay-runs");
  if (!data) {
    if (problemCode(error) === "missing_permission") return <SafetyForbidden title={title} />;
    if (problemCode(error) === "pay_not_organisation_wide") {
      return <PayNotOrganisationWide title={title} />;
    }
    return failWith(error, response, "/pay");
  }
  const canManage = me.permissions.includes(PAY_MANAGE);
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={me.tenant.name}
        title={title}
        description={t("payTime.pay.description")}
      />
      <div className="flex flex-wrap gap-3">
        <ButtonLink href="/pay/rule-sets" variant="secondary">
          {t("payTime.ruleSets.link")}
        </ButtonLink>
      </div>
      {canManage ? (
        <Card headingLevel={2} title={t("payTime.pay.newTitle")}>
          <NewPayRunForm />
        </Card>
      ) : null}
      {data.items.length === 0 ? (
        <Card>
          <EmptyState
            headingLevel={2}
            icon={<Banknote size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("payTime.pay.empty")}
          />
        </Card>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {data.items.map((r) => (
            <li key={r.id}>
              <Card as="article">
                <div className="flex flex-col gap-2">
                  <h2 className="m-0 text-heading-4">
                    <Link
                      href={`/pay/${r.id}`}
                      className="inline-flex min-h-target items-center underline"
                    >
                      {t("payTime.run.heading", {
                        from: formatDate(r.periodStart) ?? "",
                        to: formatDate(r.periodEnd) ?? "",
                        frequency: r.frequency,
                        kind: r.kind,
                      })}
                    </Link>
                  </h2>
                  <p className="m-0 flex flex-wrap items-center gap-2">
                    <SafetyChip chip={payRunChip(r, t)} />
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
