import { Card, EmptyState, PageHeader } from "@harbour/ui";
import { Scale } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { CreateScaleForm } from "@/components/dependency/DependencyForms";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import {
  DEPENDENCY_PAGE,
  dependencyScalePage,
  dependencyShown,
  mayManageScales,
  versionChip,
} from "@/lib/dependency";
import { t } from "@/lib/i18n";
import { firstParam } from "@/lib/record-metadata";

export const metadata: Metadata = { title: t("dependency.title") };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * The organisation's dependency scales (scheduling.md section 12; CARE-004; HZ-123): the
 * organisation's own tool, said so on the page, with each scale's version in use and open draft
 * as an icon and a word. A holder of scheduling.dependency.manage makes one for a home or the
 * whole organisation.
 */
export default async function DependencyPage({
  searchParams,
}: {
  readonly searchParams: SearchParams;
}) {
  const { me } = await getShellContext();
  const title = t("dependency.title");
  if (!dependencyShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const listed = await api.GET("/v1/dependency-scales");
  if (!listed.data) failWith(listed.error, listed.response, DEPENDENCY_PAGE);
  const homes = new Map(me.locations.map((l) => [l.id, l.name]));
  const done = firstParam((await searchParams).done);

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={me.tenant.name}
        title={title}
        description={t("dependency.description")}
      />
      {done === "archived" ? (
        <RecordedArrival message={t("dependency.done", { done })} param="done" />
      ) : null}
      <p className="m-0 max-w-prose font-semibold">{listed.data.notice}</p>
      <Card as="section" title={t("dependency.list")} headingLevel={2}>
        {listed.data.items.length === 0 ? (
          <EmptyState
            headingLevel={3}
            icon={<Scale size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("dependency.empty")}
          />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {listed.data.items.map((s) => (
              <li key={s.id} className="flex flex-col gap-2 border-b border-border pb-3">
                <h3 className="m-0 text-body font-semibold">
                  <Link href={dependencyScalePage(s.id)}>{s.name}</Link>
                </h3>
                <p className="m-0 text-body-dense">
                  {s.locationId
                    ? t("dependency.where", {
                        home: homes.get(s.locationId) ?? "",
                        known: homes.has(s.locationId) ? "yes" : "no",
                      })
                    : t("dependency.whereOrganisation")}
                </p>
                <p className="m-0 flex flex-wrap gap-2">
                  {s.archivedAt ? (
                    <SafetyChip
                      chip={{
                        status: "notApplicable",
                        icon: "circle-minus",
                        label: t("dependency.archived"),
                      }}
                    />
                  ) : s.current ? (
                    <SafetyChip chip={versionChip("approved", t)} />
                  ) : (
                    <SafetyChip
                      chip={{
                        status: "overdue",
                        icon: "circle-alert",
                        label: t("dependency.noneApproved"),
                      }}
                    />
                  )}
                  {s.draft ? <SafetyChip chip={versionChip("draft", t)} /> : null}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {mayManageScales(me.permissions) ? (
        <Card as="section" title={t("dependency.create.title")} headingLevel={2}>
          <CreateScaleForm
            locations={me.locations.map((l) => ({ id: l.id, name: l.name }))}
            wholeOrganisation={me.scope === "tenant"}
          />
        </Card>
      ) : null}
    </div>
  );
}
