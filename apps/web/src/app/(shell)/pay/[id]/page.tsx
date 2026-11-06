import { Card, EmptyState, PageHeader } from "@harbour/ui";
import { Banknote } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PayNotOrganisationWide } from "@/components/pay-time/PayNotOrganisationWide";
import { OverrideForm, RunActions } from "@/components/pay-time/PayTimeForms";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { SiloStatus } from "@/components/safety-silos/SiloStatus";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { formatDate, formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import {
  difference,
  exceptionChip,
  hoursAndMinutes,
  PAY_APPROVE,
  PAY_MANAGE,
  payRunChip,
  payShown,
  pounds,
} from "@/lib/pay-time";

export const metadata: Metadata = { title: t("payTime.run.title") };

/**
 * One pay run (Phase 2 slice 60; SCHED-006, SCHED-007; scheduling.md section 18 rules 9 to 13):
 * the latest calculation's lines with their working, the exceptions to clear or override with a
 * reason, and calculate, lock and correct. Locking waits until no exception is open; a locked run
 * changes only through a correction run.
 */
export default async function PayRunPage({ params }: { readonly params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { me } = await getShellContext();
  const title = t("payTime.run.title");
  if (!payShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const { data, error, response } = await api.GET("/v1/pay-runs/{id}", {
    params: { path: { id } },
  });
  if (!data) {
    if (problemCode(error) === "missing_permission") return <SafetyForbidden title={title} />;
    if (problemCode(error) === "pay_not_organisation_wide") {
      return <PayNotOrganisationWide title={title} />;
    }
    if (response.status === 404) notFound();
    return failWith(error, response, `/pay/${id}`);
  }
  const { run, lines, exceptions } = data;
  const canManage = me.permissions.includes(PAY_MANAGE);
  const canApprove = me.permissions.includes(PAY_APPROVE);
  const draft = run.status === "draft";
  const runName = t("payTime.run.heading", {
    from: formatDate(run.periodStart) ?? "",
    to: formatDate(run.periodEnd) ?? "",
    frequency: run.frequency,
    kind: run.kind,
  });
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <title>{runName}</title>
      <PageHeader eyebrow={t("payTime.pay.title")} title={runName} />
      <SiloStatus />
      <Card as="section" headingLevel={2} title={t("payTime.run.status")}>
        <div className="flex flex-col gap-3">
          <p className="m-0 flex flex-wrap items-center gap-2">
            <SafetyChip chip={payRunChip(run, t)} />
          </p>
          {run.calculatedAt ? (
            <p className="m-0 text-body-dense text-text-secondary">
              {t("payTime.run.calculatedAt", {
                count: run.calculation,
                when: formatDateTime(run.calculatedAt) ?? "",
              })}
            </p>
          ) : null}
          {run.lockedAt ? (
            <p className="m-0 text-body-dense text-text-secondary">
              {t("payTime.run.lockedAt", { when: formatDateTime(run.lockedAt) ?? "" })}
            </p>
          ) : null}
          <RunActions
            id={run.id}
            version={run.version}
            canCalculate={canManage && draft}
            canLock={canApprove && draft && run.calculation > 0 && run.openExceptions === 0}
            canCorrect={canManage && !draft}
            runName={runName.charAt(0).toLowerCase() + runName.slice(1)}
          />
        </div>
      </Card>
      <section aria-labelledby="pay-exceptions" className="flex flex-col gap-3">
        <h2 id="pay-exceptions" className="m-0 text-heading-3">
          {t("payTime.exception.heading")}
        </h2>
        {exceptions.length === 0 ? (
          <p className="m-0 text-body-dense">{t("payTime.exception.none")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {exceptions.map((x) => (
              <li key={x.id}>
                <Card
                  as="article"
                  headingLevel={3}
                  title={x.memberName ?? t("payTime.member.unnamed")}
                >
                  <div className="flex flex-col gap-2">
                    <p className="m-0 flex flex-wrap items-center gap-2">
                      <SafetyChip chip={exceptionChip(x.status, t)} />
                      <span>{t("payTime.exception.kind", { kind: x.kind })}</span>
                    </p>
                    <p className="m-0 text-body-dense">{x.message}</p>
                    {x.overrideReason ? (
                      <p className="m-0 text-body-dense text-text-secondary">
                        {t("payTime.exception.overrideReason", { reason: x.overrideReason })}
                      </p>
                    ) : null}
                    {canApprove && draft && x.status === "open" ? (
                      <OverrideForm
                        id={x.id}
                        version={x.version}
                        runId={run.id}
                        context={x.memberName ?? t("payTime.member.unnamed")}
                      />
                    ) : null}
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="pay-lines" className="flex flex-col gap-3">
        <h2 id="pay-lines" className="m-0 text-heading-3">
          {t("payTime.line.heading")}
        </h2>
        {lines.length === 0 ? (
          <Card>
            <EmptyState
              headingLevel={3}
              icon={<Banknote size={32} strokeWidth={1.5} aria-hidden="true" />}
              title={t("payTime.line.empty")}
            />
          </Card>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {lines.map((l) => (
              <li key={l.id}>
                <Card
                  as="article"
                  headingLevel={3}
                  title={l.memberName ?? t("payTime.member.unnamed")}
                >
                  <div className="flex flex-col gap-2">
                    <p className="m-0 text-heading-4">
                      {t("payTime.line.total", { amount: pounds(l.totalPence) })}
                    </p>
                    <p className="m-0 text-body-dense text-text-secondary">
                      {t("payTime.line.paidTime", { time: hoursAndMinutes(l.paidMinutes, t) })}
                    </p>
                    {l.differencePence !== null ? (
                      <p className="m-0 text-body-dense">{difference(l.differencePence, t)}</p>
                    ) : null}
                    <details>
                      <summary className="min-h-target cursor-pointer underline">
                        {t("payTime.line.working")}
                      </summary>
                      <ol className="mt-2 flex flex-col gap-1 text-body-dense">
                        {l.working.map((w, i) => (
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
      </section>
    </div>
  );
}
