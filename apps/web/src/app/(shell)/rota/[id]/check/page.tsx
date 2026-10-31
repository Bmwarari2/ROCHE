import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PublishRota } from "@/components/rota/PublishRota";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { formatDate, formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import {
  comparisonChip,
  hoursWords,
  mayCheck,
  periodKey,
  rotaCheckPage,
  rotaPage,
} from "@/lib/rota";

export const metadata: Metadata = { title: t("rota.check.title") };

type Params = Promise<{ id: string }>;

/**
 * The check before publishing (HZ-123, HZ-124): for each date and shift period, the rota against
 * the organisation's own dependency scale, labelled as theirs and never a Harbour score, with its
 * status as an icon and a word, the figures, the source, the notice, every warning and the method;
 * each member's working time as advice; and each assignment's eligibility again. Then publishing,
 * with each shortfall acknowledged by name.
 */
export default async function RotaCheckPage({ params }: { readonly params: Params }) {
  const { me } = await getShellContext();
  const title = t("rota.check.title");
  if (!mayCheck(me.permissions)) return <SafetyForbidden title={title} />;
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const api = await tenantApi();
  const [rotaGot, checkGot] = await Promise.all([
    api.GET("/v1/rotas/{id}", { params: { path: { id } } }),
    api.GET("/v1/rotas/{id}/check", { params: { path: { id } } }),
  ]);
  if (rotaGot.response.status === 404 || checkGot.response.status === 404) notFound();
  if (!rotaGot.data) failWith(rotaGot.error, rotaGot.response, rotaCheckPage(id));
  if (!checkGot.data) failWith(checkGot.error, checkGot.response, rotaCheckPage(id));
  const rota = rotaGot.data;
  const check = checkGot.data;
  const names = new Map(
    rota.shifts.flatMap((s) =>
      s.assignment ? [[s.assignment.worker.id, s.assignment.worker.displayName] as const] : [],
    ),
  );
  const shiftLabel = new Map(rota.shifts.map((s) => [s.id, s.label]));
  const periodWords = (item: (typeof check.staffing)[number]) =>
    t("rota.check.periodName", {
      date: formatDate(item.date) ?? item.date,
      period: item.periodLabel ?? "",
      hasPeriod: item.periodLabel ? "yes" : "no",
    });
  const toAcknowledge = new Set(check.periodsToAcknowledge);
  const periods = check.staffing
    .filter((item) => toAcknowledge.has(periodKey(item)))
    .map((item) => ({ key: periodKey(item), label: `${periodWords(item)}: ${item.word}` }));
  const workingTime = check.workingTime.filter(
    (w) => w.status === "cannot_check" || w.findings.length > 0,
  );
  const eligibility = check.eligibility.filter((e) => !e.allowed);

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        title={title}
        description={t("rota.check.description", { asAt: formatDateTime(check.asAt) ?? "" })}
      />
      <p className="m-0">
        <Link href={rotaPage(id)} className="inline-flex min-h-target items-center underline">
          {t("rota.check.back")}
        </Link>
      </p>
      <Card as="section" title={t("rota.check.staffing")} headingLevel={2}>
        <div className="flex flex-col gap-4">
          <p className="m-0 max-w-prose font-semibold">{t("rota.check.ownScale")}</p>
          <ul className="hb-long-list m-0 flex list-none flex-col gap-4 p-0">
            {check.staffing.map((item) => (
              <li key={periodKey(item)} className="flex flex-col gap-2 border-b border-border pb-3">
                <h3 className="m-0 text-body font-semibold">{periodWords(item)}</h3>
                <p className="m-0">
                  <SafetyChip chip={comparisonChip(item)} />
                </p>
                <p className="m-0">
                  {t("rota.check.figures", {
                    hasRequired: item.requiredMinutes === null ? "no" : "yes",
                    required: hoursWords(item.requiredMinutes ?? 0, t),
                    atLeast: item.figure === "at_least" ? "yes" : "no",
                    provided: hoursWords(item.providedMinutes, t),
                    short: hoursWords(item.shortMinutes ?? 0, t),
                    hasShort: item.shortMinutes && item.shortMinutes > 0 ? "yes" : "no",
                  })}
                </p>
                {item.source ? (
                  <p className="m-0 text-body-dense">
                    {t("rota.check.source", {
                      name: item.source.scaleName,
                      version: item.source.versionNumber,
                    })}
                  </p>
                ) : null}
                <p className="m-0 text-body-dense">{item.notice}</p>
                {item.skills.filter((s) => s.short > 0).length > 0 ? (
                  <ul className="m-0 flex flex-col gap-1 pl-5">
                    {item.skills
                      .filter((s) => s.short > 0)
                      .map((s) => (
                        <li key={s.skill}>
                          {t("rota.check.skillShort", {
                            skill: s.label,
                            minimum: s.minimumStaff,
                            rostered: s.rostered,
                          })}
                        </li>
                      ))}
                  </ul>
                ) : null}
                {item.openShiftIds.length > 0 ? (
                  <p className="m-0">
                    {t("rota.check.openShifts", { count: item.openShiftIds.length })}
                  </p>
                ) : null}
                {item.warnings.length > 0 ? (
                  <ul className="m-0 flex flex-col gap-1 pl-5">
                    {item.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                ) : null}
                {item.method.length > 0 ? (
                  <details>
                    <summary className="inline-flex min-h-target cursor-pointer items-center underline">
                      {t("rota.check.method")}
                    </summary>
                    <ol className="m-0 mt-2 flex flex-col gap-1 pl-5">
                      {item.method.map((m) => (
                        <li key={m}>{m}</li>
                      ))}
                    </ol>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      </Card>
      <Card as="section" title={t("rota.check.workingTime")} headingLevel={2}>
        {workingTime.length === 0 ? (
          <p className="m-0">{t("rota.check.workingTimeNone")}</p>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="m-0 max-w-prose">{t("rota.check.workingTimeAbout")}</p>
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {workingTime.map((w) => (
                <li key={w.workerId} className="flex flex-col gap-1">
                  <h3 className="m-0 text-body font-semibold">
                    {names.get(w.workerId) ?? t("rota.check.someone")}
                  </h3>
                  {w.status === "cannot_check" ? (
                    <p className="m-0">{t("rota.check.cannotCheck")}</p>
                  ) : null}
                  <ul className="m-0 flex flex-col gap-1 pl-5">
                    {w.findings.map((f) => (
                      <li key={`${f.rule}-${f.from}`}>
                        {t("rota.check.finding", {
                          outcome: f.outcome,
                          rule: f.rule,
                          citation: f.citation,
                        })}
                      </li>
                    ))}
                    {w.notes.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>
      <Card as="section" title={t("rota.check.eligibility")} headingLevel={2}>
        {eligibility.length === 0 ? (
          <p className="m-0">{t("rota.check.eligibilityNone")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {eligibility.map((e) => (
              <li key={e.assignmentId} className="flex flex-col gap-1">
                <h3 className="m-0 text-body font-semibold">
                  {t("rota.check.eligibilityItem", {
                    name: names.get(e.workerId) ?? t("rota.check.someone"),
                    shift: shiftLabel.get(e.shiftId) ?? "",
                    date: formatDate(e.date) ?? e.date,
                  })}
                </h3>
                <p className="m-0">
                  <SafetyChip
                    chip={
                      e.covered
                        ? { status: "info", icon: "file-pen", label: t("rota.check.covered") }
                        : {
                            status: "overdue",
                            icon: "triangle-alert",
                            label: t("rota.check.notCovered"),
                          }
                    }
                  />
                </p>
                <ul className="m-0 flex flex-col gap-1 pl-5">
                  {e.blockers.map((b) => (
                    <li key={b.key}>{b.message}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card as="section" title={t("rota.publish.title")} headingLevel={2}>
        <div className="flex flex-col gap-3">
          {check.noticeMinutes !== null ? (
            <p className="m-0">
              {t("rota.publish.notice", { hours: Math.floor(check.noticeMinutes / 60) })}
            </p>
          ) : null}
          <PublishRota check={check} periods={periods} />
        </div>
      </Card>
    </div>
  );
}
