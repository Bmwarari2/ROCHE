import { Card, PageHeader, StatusChip } from "@harbour/ui";
import { CircleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Notice } from "@/components/care/Notice";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { LoneWorkerRouteForm } from "@/components/scheduling/LoneWorkerRouteForm";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { t } from "@/lib/i18n";
import { loneWorkerAccess, routeRoleOptions } from "@/lib/lone-worker";

export const metadata: Metadata = { title: t("scheduling.loneWorker.route.title") };

/**
 * The on-call route for lone-worker alarms (H-539; scheduling.md section 15.3 rules 1, 4 and 5).
 * Until a valid route is saved no session can start. Roles are the staff roles that can see and
 * acknowledge alarms; a named person is offered only to those who may list the team, from the
 * active members. The API checks both again and refuses a role or person that cannot monitor.
 */
export default async function LoneWorkerRoutePage() {
  const { me } = await getShellContext();
  const title = t("scheduling.loneWorker.route.title");
  if (!loneWorkerAccess(me.permissions).manage) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const route = await api.GET("/v1/lone-worker/route");
  if (!route.data) failWith(route.error, route.response);
  const listed = me.permissions.includes("platform.user.manage")
    ? await api.GET("/v1/members", { params: { query: {} } })
    : null;
  // Active members; the API refuses anyone who cannot see and acknowledge alarms, in words.
  const people = (listed?.data?.items ?? [])
    .filter((m) => m.state === "active")
    .map((m) => ({ value: `person:${m.id}`, label: m.displayName }));
  const roles = routeRoleOptions().map((r) => ({ value: `role:${r.key}`, label: r.name }));
  const { on, steps, problems, version, locationEvidence } = route.data;

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={me.tenant.name}
        title={title}
        description={t("scheduling.loneWorker.route.description")}
      />
      <p className="m-0">
        <Link href="/lone-working" className="inline-flex min-h-target items-center underline">
          {t("scheduling.loneWorker.backToLoneWorking")}
        </Link>
      </p>
      <Card as="section" aria-labelledby="route-state">
        <div className="flex flex-col gap-3">
          <h2 id="route-state" className="hb-card__title">
            {t("scheduling.loneWorker.route.state")}
          </h2>
          <div>
            <StatusChip
              status={on ? "done" : "overdue"}
              label={t("scheduling.loneWorker.route.on", { on: on ? "yes" : "no" })}
            />
          </div>
          {problems.length > 0 ? (
            <Notice
              tone="warning"
              icon={<CircleAlert size={20} strokeWidth={1.5} aria-hidden="true" />}
              title={t("scheduling.loneWorker.route.problems")}
            >
              <ul className="m-0 pl-5">
                {problems.map((p) => (
                  <li key={p.code}>{p.message}</li>
                ))}
              </ul>
            </Notice>
          ) : null}
          <p className="m-0">
            {t("scheduling.loneWorker.route.locationEvidence", {
              on: locationEvidence ? "yes" : "no",
            })}
          </p>
          <p className="m-0 text-body-dense text-text-secondary">
            {t("scheduling.loneWorker.route.order")}
          </p>
        </div>
      </Card>
      <Card as="section" aria-labelledby="route-steps">
        <div className="flex flex-col gap-4">
          <h2 id="route-steps" className="hb-card__title">
            {t("scheduling.loneWorker.route.steps")}
          </h2>
          <LoneWorkerRouteForm steps={steps} version={version} roles={roles} people={people} />
        </div>
      </Card>
    </div>
  );
}
