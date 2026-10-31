import { Card, EmptyState, PageHeader } from "@harbour/ui";
import { Wallet } from "lucide-react";
import type { Metadata } from "next";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { difference, myTimeShown, pounds } from "@/lib/pay-time";

export const metadata: Metadata = { title: t("payTime.myPay.title") };

/**
 * My pay lines in locked runs (Phase 2 slice 60; scheduling.md section 18 rule 13): each
 * period's total with its working in words. Only locked runs; nothing here is a payslip.
 */
export default async function MyPayPage() {
  const { me } = await getShellContext();
  const title = t("payTime.myPay.title");
  if (!myTimeShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const { data, error, response } = await api.GET("/v1/me/pay-lines");
  if (!data) {
    if (problemCode(error) === "missing_permission") return <SafetyForbidden title={title} />;
    return failWith(error, response, "/my-pay");
  }
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader title={title} description={t("payTime.myPay.description")} />
      {data.items.length === 0 ? (
        <Card>
          <EmptyState
            headingLevel={2}
            icon={<Wallet size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("payTime.myPay.empty")}
          />
        </Card>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {data.items.map((item) => (
            <li key={item.line.id}>
              <Card
                as="article"
                headingLevel={2}
                title={t("payTime.myPay.period", {
                  from: formatDate(item.periodStart) ?? "",
                  to: formatDate(item.periodEnd) ?? "",
                  kind: item.kind,
                })}
              >
                <div className="flex flex-col gap-2">
                  <p className="m-0 text-heading-4">
                    {t("payTime.line.total", { amount: pounds(item.line.totalPence) })}
                  </p>
                  {item.line.differencePence !== null ? (
                    <p className="m-0 text-body-dense">
                      {difference(item.line.differencePence, t)}
                    </p>
                  ) : null}
                  <details>
                    <summary className="min-h-target cursor-pointer underline">
                      {t("payTime.line.working")}
                    </summary>
                    <ol className="mt-2 flex flex-col gap-1 text-body-dense">
                      {item.line.working.map((w, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: the working is a fixed ordered list.
                        <li key={i}>
                          {w.pence !== null
                            ? t("payTime.line.step", { step: w.step, amount: pounds(w.pence) })
                            : w.step}
                        </li>
                      ))}
                    </ol>
                  </details>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
