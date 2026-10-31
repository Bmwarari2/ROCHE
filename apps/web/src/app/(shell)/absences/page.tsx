import { Card, EmptyState, PageHeader } from "@harbour/ui";
import { CalendarOff } from "lucide-react";
import type { Metadata } from "next";
import { DecisionForm, LeaveRequestForm } from "@/components/pay-time/PayTimeForms";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { SiloStatus } from "@/components/safety-silos/SiloStatus";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { absenceChip, absencesShown, coverChip, ROTA_APPROVE, SELF } from "@/lib/pay-time";
import { addDays, ukToday } from "@/lib/uk-time";

export const metadata: Metadata = { title: t("payTime.absences.title") };

/**
 * Absence requests and decisions (Phase 2 slice 60; SCHED-005; scheduling.md section 17): ask for
 * leave, and for approvers decide requests at the home. An absence that leaves shifts on the rota
 * says so in an icon and words (HZ-123) so cover is found before the shift.
 */
export default async function AbsencesPage() {
  const { me, locationId } = await getShellContext();
  const title = t("payTime.absences.title");
  if (!absencesShown(me.permissions)) return <SafetyForbidden title={title} />;
  const location = me.locations.find((l) => l.id === locationId) ?? me.locations[0];
  if (!location) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const { data, error, response } = await api.GET("/v1/absences", {
    params: { query: { locationId: location.id, from: addDays(ukToday(), -90) } },
  });
  if (!data) {
    if (problemCode(error) === "missing_permission") return <SafetyForbidden title={title} />;
    return failWith(error, response, "/absences");
  }
  const canDecide = me.permissions.includes(ROTA_APPROVE);
  const canAsk = me.permissions.includes(SELF);
  const items = [...data.items].sort(
    (a, b) =>
      Number(a.state !== "requested") - Number(b.state !== "requested") ||
      b.coverNeeded - a.coverNeeded ||
      a.startsOn.localeCompare(b.startsOn),
  );
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={location.name}
        title={title}
        description={t("payTime.absences.description")}
      />
      <SiloStatus />
      {canAsk ? (
        <Card headingLevel={2} title={t("payTime.absences.askTitle")}>
          <LeaveRequestForm locationId={location.id} />
        </Card>
      ) : null}
      {data.truncated ? (
        <p className="m-0 text-body-dense">{t("payTime.absences.truncated")}</p>
      ) : null}
      {items.length === 0 ? (
        <Card>
          <EmptyState
            headingLevel={2}
            icon={<CalendarOff size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("payTime.absences.empty")}
          />
        </Card>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {items.map((a) => {
            const cover =
              a.state === "cancelled" || a.state === "declined"
                ? null
                : coverChip(a.coverNeeded, t);
            return (
              <li key={a.id}>
                <Card as="article" headingLevel={2} title={a.member.displayName}>
                  <div className="flex flex-col gap-2">
                    <p className="m-0 flex flex-wrap items-center gap-2">
                      <SafetyChip chip={absenceChip(a.state, t)} />
                      {cover ? <SafetyChip chip={cover} /> : null}
                    </p>
                    <p className="m-0 text-body-dense">
                      {t("payTime.absence.summary", {
                        kind: a.kind,
                        from: formatDate(a.startsOn) ?? "",
                        to: a.endsOn ? (formatDate(a.endsOn) ?? "") : "",
                        open: a.endsOn ? "no" : "yes",
                      })}
                    </p>
                    {a.decisionReason ? (
                      <p className="m-0 text-body-dense text-text-secondary">
                        {t("payTime.absence.reason", { reason: a.decisionReason })}
                      </p>
                    ) : null}
                    {canDecide && a.state === "requested" && a.member.id !== me.tenantUserId ? (
                      <DecisionForm id={a.id} version={a.version} />
                    ) : null}
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
