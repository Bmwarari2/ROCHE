import { Card } from "@harbour/ui";
import type { Metadata } from "next";
import { NoAccess } from "@/components/care/NoAccess";
import { RecordFrame } from "@/components/care/RecordFrame";
import { RecordDependencyForm } from "@/components/dependency/DependencyForms";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { SafetyChip } from "@/components/safety/SafetyChip";
import { getShellContext, tenantApi } from "@/lib/api";
import { tabHref } from "@/lib/care-record";
import { mayAssess, personDependencyShown } from "@/lib/dependency";
import { formatDate, formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { personNames } from "@/lib/people";
import { getPerson, readOrFail } from "@/lib/person-record";
import { firstParam, recordMetadata } from "@/lib/record-metadata";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata(): Promise<Metadata> {
  return recordMetadata("dependency");
}

/**
 * The person's dependency category (scheduling.md section 12; CARE-004): the organisation's own
 * tool, said so; the record in force with its category, the date it applies from, why and the
 * scale version it came from; every earlier record, a corrected one struck through; and, for a
 * holder of care.dependency.assess, recording a new one from the approved version at their home.
 */
async function DependencyTab({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id } = await params;
  const { person } = await getPerson(id);
  if (!person) return null;
  const { me } = await getShellContext();
  if (!personDependencyShown(me.permissions)) return <NoAccess />;
  const api = await tenantApi();
  const path = tabHref(id, "dependency");
  const record = readOrFail(
    await api.GET("/v1/people/{id}/dependency", { params: { path: { id } } }),
    path,
  );
  if (!record) return <NoAccess />;
  const assess = mayAssess(me.permissions);
  const scales = assess ? (await api.GET("/v1/dependency-scales")).data : undefined;
  const scale =
    scales?.items.find((s) => s.locationId === person.locationId && !s.archivedAt && s.current) ??
    scales?.items.find((s) => s.locationId === null && !s.archivedAt && s.current);
  const name = personNames(person).preferred;
  const done = firstParam((await searchParams).done);

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-eyebrow">{t("dependency.person.title")}</h2>
        <p className="m-0 max-w-prose font-semibold">{record.notice}</p>
      </div>
      {done === "recorded" ? (
        <RecordedArrival message={t("dependency.done", { done })} param="done" />
      ) : null}
      <Card as="section" title={t("dependency.person.inForce")} headingLevel={3}>
        {record.inForce ? (
          <div className="flex flex-col gap-2">
            <p className="m-0 font-semibold">
              {record.inForce.categoryLabel ?? record.inForce.categoryKey}
            </p>
            <p className="m-0">
              {t("dependency.person.line", {
                from: formatDate(record.inForce.effectiveFrom) ?? record.inForce.effectiveFrom,
                version: record.inForce.versionNumber ?? 0,
              })}
            </p>
            <p className="m-0 text-body-dense">{record.inForce.reason}</p>
          </div>
        ) : (
          <p className="m-0">{t("dependency.person.none", { name })}</p>
        )}
      </Card>
      {record.items.some(Boolean) ? (
        <Card as="section" title={t("dependency.person.history")} headingLevel={3}>
          <ul className="hb-long-list m-0 flex list-none flex-col gap-3 p-0">
            {record.items
              .flatMap((item) => (item ? [item] : []))
              .map((item) => (
                <li key={item.id} className="flex flex-col gap-1 border-b border-border pb-3">
                  <p
                    className={
                      item.corrected ? "m-0 font-semibold line-through" : "m-0 font-semibold"
                    }
                  >
                    {item.categoryLabel ?? item.categoryKey}
                  </p>
                  <p className="m-0 flex flex-wrap items-center gap-2">
                    <SafetyChip
                      chip={
                        item.corrected
                          ? {
                              status: "notApplicable",
                              icon: "circle-minus",
                              label: t("dependency.person.corrected"),
                            }
                          : item.inForce
                            ? {
                                status: "done",
                                icon: "circle-check",
                                label: t("dependency.person.inForceWord"),
                              }
                            : {
                                status: "neutral",
                                icon: "clock",
                                label: t("dependency.kind", { kind: item.kind }),
                              }
                      }
                    />
                    <span className="text-body-dense">
                      {t("dependency.person.recorded", {
                        from: formatDate(item.effectiveFrom) ?? item.effectiveFrom,
                        at: formatDateTime(item.recordedAt) ?? "",
                      })}
                    </span>
                  </p>
                  <p className="m-0 text-body-dense">{item.reason}</p>
                </li>
              ))}
          </ul>
        </Card>
      ) : null}
      {assess ? (
        <Card as="section" title={t("dependency.record.title")} headingLevel={3}>
          {scale?.current ? (
            <RecordDependencyForm
              personId={id}
              path={path}
              categories={scale.current.definition.categories.map((c) => ({
                key: c.key,
                label: c.label,
              }))}
              currentId={record.currentId}
              deciders={[{ id: me.tenantUserId, name: t("dependency.record.me") }]}
              me={me.tenantUserId}
            />
          ) : (
            <p className="m-0">{t("dependency.record.noScale")}</p>
          )}
        </Card>
      ) : null}
    </>
  );
}

export default async function DependencyPage(props: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id } = await props.params;
  return (
    <RecordFrame personId={id} tab="dependency">
      <DependencyTab {...props} />
    </RecordFrame>
  );
}
