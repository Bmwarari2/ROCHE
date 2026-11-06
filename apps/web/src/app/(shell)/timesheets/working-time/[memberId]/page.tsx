import { Card, EmptyState, PageHeader } from "@harbour/ui";
import { Scale } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { formatDate, formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { hoursAndMinutes } from "@/lib/pay-time";

export const metadata: Metadata = { title: t("payTime.workingTime.title") };

interface Finding {
  readonly rule?: string;
  readonly citation?: string;
  readonly outcome?: string;
  readonly actualMinutes?: number;
  readonly limitMinutes?: number;
}

/**
 * A member's stored working time results (Phase 2 slice 60; SCHED-003; scheduling.md section 16
 * rule 7): advice only, never a block. Each finding says the rule and its citation, whether it is
 * a breach or depends on a condition (an icon and a word), and the minutes against the limit.
 */
export default async function WorkingTimePage({
  params,
}: {
  readonly params: Promise<{ memberId: string }>;
}) {
  const { memberId } = await params;
  if (!isUuid(memberId)) notFound();
  const { me } = await getShellContext();
  const title = t("payTime.workingTime.title");
  const api = await tenantApi();
  const { data, error, response } = await api.GET("/v1/members/{id}/working-time", {
    params: { path: { id: memberId } },
  });
  if (!data) {
    if (problemCode(error) === "missing_permission") return <SafetyForbidden title={title} />;
    if (response.status === 404) notFound();
    return failWith(error, response, `/timesheets/working-time/${memberId}`);
  }
  const heading = data.memberName
    ? t("payTime.workingTime.titleFor", { name: data.memberName })
    : title;
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <title>{heading}</title>
      <PageHeader eyebrow={me.tenant.name} title={heading} />
      <Card headingLevel={2} title={t("payTime.workingTime.adviceTitle")}>
        <p className="m-0 text-body">{t("payTime.workingTime.advice")}</p>
      </Card>
      {data.items.length === 0 ? (
        <Card>
          <EmptyState
            headingLevel={2}
            icon={<Scale size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("payTime.workingTime.empty")}
          />
        </Card>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {data.items.map((r) => (
            <li key={r.id}>
              <Card
                as="article"
                headingLevel={2}
                title={t("payTime.workingTime.range", {
                  from: formatDate(r.evaluateFrom) ?? "",
                  to: formatDate(r.evaluateTo) ?? "",
                })}
              >
                <div className="flex flex-col gap-2">
                  <p className="m-0 text-body-dense text-text-secondary">
                    {t("payTime.workingTime.checkedAt", {
                      when: formatDateTime(r.createdAt) ?? "",
                    })}
                  </p>
                  {r.findings.length === 0 ? (
                    <p className="m-0 flex flex-wrap items-center gap-2">
                      <SafetyChip
                        chip={{
                          status: "done",
                          icon: "circle-check",
                          label: t("payTime.workingTime.noFindings"),
                        }}
                      />
                    </p>
                  ) : (
                    <ul className="m-0 flex list-none flex-col gap-2 p-0">
                      {(r.findings as Finding[]).map((f, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: findings are a fixed ordered list.
                        <li key={i} className="flex flex-col gap-1">
                          <p className="m-0 flex flex-wrap items-center gap-2">
                            <SafetyChip
                              chip={
                                f.outcome === "breach"
                                  ? {
                                      status: "overdue",
                                      icon: "triangle-alert",
                                      label: t("payTime.workingTime.breach"),
                                    }
                                  : {
                                      status: "due",
                                      icon: "circle-alert",
                                      label: t("payTime.workingTime.conditional"),
                                    }
                              }
                            />
                            <span>
                              {t("payTime.workingTime.rule", { rule: f.rule ?? "other" })}
                            </span>
                          </p>
                          <p className="m-0 text-body-dense text-text-secondary">
                            {t("payTime.workingTime.minutes", {
                              actual: hoursAndMinutes(f.actualMinutes, t),
                              limit: hoursAndMinutes(f.limitMinutes, t),
                            })}
                            {f.citation ? ` (${f.citation})` : ""}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
