import { Card, EmptyState, PageHeader } from "@harbour/ui";
import { Scale } from "lucide-react";
import type { Metadata } from "next";
import { PayNotOrganisationWide } from "@/components/pay-time/PayNotOrganisationWide";
import { ApproveRuleSetForm, RuleSetForm } from "@/components/pay-time/PayTimeForms";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { SiloStatus } from "@/components/safety-silos/SiloStatus";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { PAY_APPROVE, PAY_MANAGE, payShown, pounds, ruleSetChip } from "@/lib/pay-time";

export const metadata: Metadata = { title: t("payTime.ruleSets.title") };

/**
 * Pay rule sets (Phase 2 slice 60; SCHED-006; scheduling.md section 18 rules 1 to 4): the
 * tenant's own role rates and enhancements, effective from a date, drafted by a pay manager and
 * approved by someone else. Statutory figures are not here: they come from the rate table.
 */
export default async function RuleSetsPage() {
  const { me } = await getShellContext();
  const title = t("payTime.ruleSets.title");
  if (!payShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const { data, error, response } = await api.GET("/v1/pay-rule-sets");
  if (!data) {
    if (problemCode(error) === "missing_permission") return <SafetyForbidden title={title} />;
    if (problemCode(error) === "pay_not_organisation_wide") {
      return <PayNotOrganisationWide title={title} />;
    }
    return failWith(error, response, "/pay/rule-sets");
  }
  const canManage = me.permissions.includes(PAY_MANAGE);
  const canApprove = me.permissions.includes(PAY_APPROVE);
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={t("payTime.pay.title")}
        title={title}
        description={t("payTime.ruleSets.description")}
      />
      <SiloStatus />
      {canManage ? (
        <Card as="section" headingLevel={2} title={t("payTime.ruleSets.newTitle")}>
          <RuleSetForm />
        </Card>
      ) : null}
      {data.items.length === 0 ? (
        <Card>
          <EmptyState
            headingLevel={2}
            icon={<Scale size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("payTime.ruleSets.empty")}
          />
        </Card>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {data.items.map((r) => (
            <li key={r.id}>
              <Card
                as="article"
                headingLevel={2}
                title={t("payTime.ruleSet.heading", { name: r.name, number: r.versionNumber })}
              >
                <div className="flex flex-col gap-2">
                  <p className="m-0 flex flex-wrap items-center gap-2">
                    <SafetyChip chip={ruleSetChip(r.status, t)} />
                  </p>
                  <p className="m-0 text-body-dense">
                    {t("payTime.ruleSet.effective", { date: formatDate(r.effectiveFrom) ?? "" })}
                  </p>
                  <ul className="m-0 flex flex-col gap-1 pl-5 text-body-dense">
                    {Object.entries(r.roleRates).map(([role, pence]) => (
                      <li key={role}>
                        {t("payTime.ruleSet.roleRate", { role, amount: pounds(pence) })}
                      </li>
                    ))}
                  </ul>
                  {canApprove && r.status === "draft" ? (
                    <ApproveRuleSetForm
                      id={r.id}
                      version={r.version}
                      context={t("payTime.ruleSet.heading", {
                        name: r.name,
                        number: r.versionNumber,
                      })}
                    />
                  ) : null}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
