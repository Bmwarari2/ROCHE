import type { IncidentDetail, InvestigationItem } from "@harbour/contracts";
import { Card } from "@harbour/ui";
import type { ReactNode } from "react";
import { tenantApi } from "@/lib/api";
import { can } from "@/lib/care-record";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import {
  actionDue,
  actionStatusChip,
  investigationManageable,
  investigationStatusChip,
  staffName,
  staffOptions,
} from "@/lib/investigation";
import { ukToday } from "@/lib/uk-time";
import { InvestigationForm } from "./InvestigationForm";
import { SafetyChip } from "./SafetyChip";

/** One labelled value of the investigation, in a description list. */
function Detail({ field, children }: { readonly field: string; readonly children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-body-dense font-semibold">
        {t("safety.investigation.label", { field })}
      </dt>
      <dd className="m-0 whitespace-pre-line break-words">{children}</dd>
    </div>
  );
}

/**
 * An incident's investigation (safety.md section 5; SAFE-010; hazard HZ-091): its status, lead
 * and method, findings, contributing factors and lessons, whether the lessons were published as a
 * bulletin, and each action with its status, owner and date in words and icons (an open action
 * past its date is overdue). Staff are named only where the reader's own list of staff names them
 * (`/v1/members`, for those who manage the team), else "you" or "a colleague". A manager records
 * it here; it may continue after the incident closes.
 */
export async function InvestigationSection({
  incident,
  record,
  viewer,
  now,
}: {
  readonly incident: IncidentDetail;
  readonly record: InvestigationItem | null;
  readonly viewer: { readonly tenantUserId: string; readonly permissions: readonly string[] };
  readonly now: Date;
}) {
  if (incident.restricted) return null;
  const manage = investigationManageable(incident, viewer.permissions);
  // The team at the incident's location, by name, for those who manage the team.
  const listed =
    can(viewer.permissions, "platform.user.manage") && (manage || record)
      ? await (await tenantApi()).GET("/v1/members", {
          params: { query: { locationId: incident.locationId } },
        })
      : null;
  const members = (listed?.data?.items ?? []).filter((m) => m.state === "active");
  const names = new Map(members.map((m) => [m.id, m.displayName]));
  const name = (id: string | null) => staffName(id, viewer.tenantUserId, names, t);
  const today = ukToday(now);
  const actionLine = (action: InvestigationItem["actions"][number]) =>
    t("safety.investigation.actionLine", {
      owner: name(action.ownerTenantUserId),
      due: actionDue(action.dueOn, t),
    });

  return (
    <Card as="section" aria-labelledby="investigation">
      <div className="flex flex-col gap-4 break-words">
        <h2 id="investigation" tabIndex={-1} className="hb-card__title scroll-mt-nav">
          {t("safety.investigation.title")}
        </h2>
        {record ? (
          <>
            <p className="m-0 flex flex-wrap items-center gap-2">
              <SafetyChip chip={investigationStatusChip(record.status, t)} />
            </p>
            <dl className="m-0 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Detail field="lead">{name(record.leadTenantUserId)}</Detail>
              <Detail field="method">
                {t("safety.investigation.method", { method: record.method ?? "none" })}
              </Detail>
              <Detail field="findings">{record.findings ?? t("common.notRecorded")}</Detail>
              <Detail field="factors">
                {record.contributingFactors.length > 0 ? (
                  <ul className="m-0 flex list-disc flex-col gap-1 ps-5">
                    {record.contributingFactors.map((factor) => (
                      <li key={factor}>{factor}</li>
                    ))}
                  </ul>
                ) : (
                  t("common.notRecorded")
                )}
              </Detail>
              <Detail field="lessons">{record.lessons ?? t("common.notRecorded")}</Detail>
              <Detail field="bulletinRow">
                {record.bulletinPublishedAt ? (
                  <time dateTime={record.bulletinPublishedAt}>
                    {t("safety.investigation.bulletinAt", {
                      dateTime: formatDateTime(record.bulletinPublishedAt) ?? "",
                    })}
                  </time>
                ) : (
                  t("safety.investigation.bulletinNot")
                )}
              </Detail>
              {record.completedAt ? (
                <Detail field="completedAt">
                  <time dateTime={record.completedAt}>{formatDateTime(record.completedAt)}</time>
                </Detail>
              ) : null}
            </dl>
            <div className="flex flex-col gap-2">
              <h3 className="m-0 text-body font-semibold">
                {t("safety.investigation.label", { field: "actions" })}
              </h3>
              {record.actions.length === 0 ? (
                <p className="m-0">{t("safety.investigation.noActions")}</p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-3 p-0">
                  {record.actions.map((action) => (
                    <li key={action.id} className="flex flex-col gap-1 border-b border-border pb-3">
                      <span className="whitespace-pre-line">{action.action}</span>
                      <span className="flex flex-wrap items-center gap-2 text-body-dense">
                        <SafetyChip chip={actionStatusChip(action, today, t)} />
                        {actionLine(action)}
                      </span>
                      {action.taskId ? (
                        <span className="text-body-dense text-text-secondary">
                          {t("safety.investigation.taskMade")}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        ) : (
          <p className="m-0">{t("safety.investigation.none", { manage: String(manage) })}</p>
        )}
        {manage ? (
          <InvestigationForm
            incidentId={incident.id}
            record={record}
            staff={staffOptions(
              viewer.tenantUserId,
              members,
              [
                record?.leadTenantUserId ?? null,
                ...(record?.actions ?? []).map((a) => a.ownerTenantUserId),
              ],
              t,
            )}
            actionLabels={(record?.actions ?? []).map((action) =>
              t("safety.investigation.actionStatusLabel", {
                action: action.action,
                details: actionLine(action),
              }),
            )}
          />
        ) : null}
      </div>
    </Card>
  );
}
