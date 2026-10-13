import { Card, EmptyState, PageHeader, StatusChip } from "@harbour/ui";
import { CircleAlert, Lock, ShieldCheck, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { EntryBadges } from "@/components/care/EntryBadges";
import { Notice } from "@/components/care/Notice";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { can } from "@/lib/care-record";
import { t } from "@/lib/i18n";
import {
  INCIDENT_LIST_LIMIT,
  incidentStatusChip,
  incidentsToList,
  incidentTitle,
} from "@/lib/incidents";

export const metadata: Metadata = { title: t("safety.incidents.title") };

/**
 * Incidents and near misses in the viewer's scope, newest first (register row SAFE-001; hazard
 * HZ-013): each with its status in word and icon, whether part of it is hidden from the viewer,
 * and how many notification questions are still to answer. The API returns the newest 500, so
 * when that many come back the open and under-review ones are fetched besides, and the page says
 * older incidents are not listed (#42 review). Read only for now; recording and managing
 * incidents follow (docs/plans/STATUS.md).
 */
export default async function IncidentsPage() {
  const { me, locationId } = await getShellContext();
  const title = t("safety.incidents.title");
  if (!can(me.permissions, "safety.incident.read")) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const read = async (status?: "open" | "under_review") => {
    const query = { ...(locationId ? { locationId } : {}), ...(status ? { status } : {}) };
    const { data, error, response } = await api.GET("/v1/incidents", { params: { query } });
    if (data) return data.items;
    if (problemCode(error) === "missing_permission") return null;
    return failWith(error, response, "/incidents");
  };
  const newest = await read();
  if (!newest) return <SafetyForbidden title={title} />;
  // Past the API's limit, an older incident still open could be cut off: fetch those besides.
  const unfinished =
    newest.length >= INCIDENT_LIST_LIMIT
      ? await Promise.all([read("open"), read("under_review")])
      : [];
  const data = incidentsToList(newest, ...unfinished.map((list) => list ?? []));
  const location = me.locations.find((l) => l.id === locationId);
  const locationNames = new Map(me.locations.map((l) => [l.id, l.name]));

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={location ? location.name : me.tenant.name}
        title={title}
        description={t("safety.incidents.description")}
      />
      {data.truncated ? (
        <Notice
          tone="warning"
          icon={<TriangleAlert size={20} strokeWidth={1.5} aria-hidden="true" />}
          title={t("safety.incidents.truncated", {
            reach: data.truncated,
            limit: INCIDENT_LIST_LIMIT,
          })}
        />
      ) : null}
      {data.items.length === 0 ? (
        <Card>
          <EmptyState
            headingLevel={2}
            icon={<ShieldCheck size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("safety.incidents.empty")}
          />
        </Card>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {data.items.map((item) => (
            <li key={item.id}>
              <Card
                as="article"
                headingLevel={2}
                className="break-words"
                title={
                  <Link
                    href={`/incidents/${item.id}`}
                    className="inline-flex min-h-target items-center underline"
                  >
                    {incidentTitle(item, t)}
                  </Link>
                }
              >
                <div className="flex flex-col gap-2">
                  <p className="m-0 flex flex-wrap items-center gap-2">
                    <SafetyChip chip={incidentStatusChip(item.status, t)} />
                    {item.openQuestionCount > 0 ? (
                      <StatusChip
                        status="due"
                        label={t("safety.incident.questionsChip", {
                          count: item.openQuestionCount,
                        })}
                        icon={CircleAlert}
                      />
                    ) : null}
                    {item.restricted ? (
                      <StatusChip
                        status="info"
                        label={t("safety.incident.restrictedChip")}
                        icon={Lock}
                      />
                    ) : null}
                    <EntryBadges entry={item} />
                  </p>
                  <p className="m-0 text-body-dense text-text-secondary">
                    {locationNames.get(item.locationId) ?? t("safety.incident.locationHidden")}
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
