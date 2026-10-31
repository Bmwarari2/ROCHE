import { ButtonLink, Card, EmptyState, PageHeader } from "@harbour/ui";
import { ClipboardCheck } from "lucide-react";
import type { Metadata } from "next";
import { ApproveEntryForm } from "@/components/pay-time/PayTimeForms";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { hoursAndMinutes, ROTA_APPROVE, timesheetChip, timesheetsShown } from "@/lib/pay-time";
import { addDays, ukToday } from "@/lib/uk-time";

export const metadata: Metadata = { title: t("payTime.timesheets.title") };

/**
 * Timesheet approval at a home (Phase 2 slice 60; SCHED-004; scheduling.md section 16 rules 4 to
 * 7): the last fortnight's entries, drafts first, each with where it stands in an icon and a
 * word and any pairing problem in words. A corrected entry is struck through. Approving runs the
 * working time check as advice; nobody approves their own (the API refuses it).
 */
export default async function TimesheetsPage() {
  const { me, locationId } = await getShellContext();
  const title = t("payTime.timesheets.title");
  if (!timesheetsShown(me.permissions)) return <SafetyForbidden title={title} />;
  const location = me.locations.find((l) => l.id === locationId) ?? me.locations[0];
  if (!location) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const today = ukToday();
  const { data, error, response } = await api.GET("/v1/locations/{id}/timesheets", {
    params: { path: { id: location.id }, query: { from: addDays(today, -13), to: today } },
  });
  if (!data) {
    if (problemCode(error) === "missing_permission") return <SafetyForbidden title={title} />;
    return failWith(error, response, "/timesheets");
  }
  const canApprove = me.permissions.includes(ROTA_APPROVE);
  const entries = [...data.items].sort(
    (a, b) =>
      Number(a.status !== "draft" || a.superseded) - Number(b.status !== "draft" || b.superseded) ||
      a.startedAt.localeCompare(b.startedAt),
  );
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={location.name}
        title={title}
        description={t("payTime.timesheets.description")}
      />
      {entries.length === 0 ? (
        <Card>
          <EmptyState
            headingLevel={2}
            icon={<ClipboardCheck size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("payTime.timesheets.empty")}
          />
        </Card>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {entries.map((e) => {
            const span = t("payTime.entry.span", {
              from: formatDateTime(e.startedAt) ?? "",
              to: formatDateTime(e.endedAt) ?? "",
            });
            return (
              <li key={e.id}>
                <Card
                  as="article"
                  headingLevel={2}
                  title={e.workerName ?? t("payTime.member.unnamed")}
                >
                  <div className="flex flex-col gap-2">
                    <p className="m-0 flex flex-wrap items-center gap-2">
                      <SafetyChip chip={timesheetChip(e, t)} />
                    </p>
                    <p className="m-0 text-body-dense">{e.superseded ? <s>{span}</s> : span}</p>
                    <p className="m-0 text-body-dense text-text-secondary">
                      {t("payTime.entry.worked", { time: hoursAndMinutes(e.workedMinutes, t) })}
                      {" · "}
                      {t("payTime.entry.kind", { kind: e.kind })}
                    </p>
                    {e.correctionReason ? (
                      <p className="m-0 text-body-dense">
                        {t("payTime.entry.correction", { reason: e.correctionReason })}
                      </p>
                    ) : null}
                    {e.problems.map((p) => (
                      <p key={p} className="m-0 text-body-dense">
                        {t("payTime.entry.problem", { problem: p })}
                      </p>
                    ))}
                    <div className="flex flex-wrap items-start gap-3">
                      {canApprove && e.status === "draft" && !e.superseded ? (
                        <ApproveEntryForm id={e.id} version={e.version} />
                      ) : null}
                      <ButtonLink
                        href={`/timesheets/working-time/${e.workerId}`}
                        variant="secondary"
                      >
                        {t("payTime.workingTime.link")}
                      </ButtonLink>
                    </div>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
