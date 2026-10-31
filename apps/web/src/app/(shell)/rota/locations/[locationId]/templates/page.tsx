import { Card, EmptyState, PageHeader } from "@harbour/ui";
import { Clock } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArchiveButton, PatternForm, TemplateForm } from "@/components/rota/RotaForms";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import { firstParam } from "@/lib/record-metadata";
import { mayManageRota, rotaHomePage, shiftTimes, templatesPage } from "@/lib/rota";

export const metadata: Metadata = { title: t("rota.templates.title") };

type Params = Promise<{ locationId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const DONE = new Set(["templateMade", "patternMade", "archived"]);

/**
 * A home's shift templates and patterns (SCHED-002): make one, see its times in 24-hour UK time
 * and archive it. Shifts already made from them stay as they are.
 */
export default async function TemplatesPage({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { me } = await getShellContext();
  const title = t("rota.templates.title");
  if (!mayManageRota(me.permissions)) return <SafetyForbidden title={title} />;
  const { locationId } = await params;
  if (!isUuid(locationId)) notFound();
  const home = me.locations.find((l) => l.id === locationId);
  if (!home) notFound();
  const path = templatesPage(locationId);
  const api = await tenantApi();
  const [templates, patterns] = await Promise.all([
    api.GET("/v1/locations/{id}/shift-templates", { params: { path: { id: locationId } } }),
    api.GET("/v1/locations/{id}/shift-patterns", { params: { path: { id: locationId } } }),
  ]);
  if (!templates.data) failWith(templates.error, templates.response, path);
  if (!patterns.data) failWith(patterns.error, patterns.response, path);
  const done = firstParam((await searchParams).done);
  const byId = new Map(templates.data.items.map((tpl) => [tpl.id, tpl.name]));

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader eyebrow={home.name} title={title} description={t("rota.templates.description")} />
      {done && DONE.has(done) ? (
        <RecordedArrival message={t("rota.done", { done })} param="done" />
      ) : null}
      <p className="m-0">
        <Link
          href={rotaHomePage(locationId)}
          className="inline-flex min-h-target items-center underline"
        >
          {t("rota.backToRotas")}
        </Link>
      </p>
      <Card as="section" title={t("rota.templates.list")} headingLevel={2}>
        {templates.data.items.length === 0 ? (
          <EmptyState
            headingLevel={3}
            icon={<Clock size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("rota.templates.empty")}
          />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {templates.data.items.map((tpl) => (
              <li key={tpl.id} className="flex flex-col gap-2 border-b border-border pb-3">
                <h3 className="m-0 text-body font-semibold">{tpl.name}</h3>
                <p className="m-0">
                  {t("rota.templates.line", {
                    kind: tpl.kind,
                    times: shiftTimes(tpl.startMinute, tpl.endMinute, t),
                    breakMinutes: tpl.breakMinutes,
                    care: tpl.countsAsCare ? "yes" : "no",
                  })}
                </p>
                <ArchiveButton
                  kind="template"
                  id={tpl.id}
                  version={tpl.version}
                  name={tpl.name}
                  path={path}
                />
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card as="section" title={t("rota.template.title")} headingLevel={2}>
        <TemplateForm locationId={locationId} path={path} />
      </Card>
      <Card as="section" title={t("rota.patterns.list")} headingLevel={2}>
        {patterns.data.items.length === 0 ? (
          <p className="m-0">{t("rota.patterns.empty")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {patterns.data.items.map((p) => (
              <li key={p.id} className="flex flex-col gap-2 border-b border-border pb-3">
                <h3 className="m-0 text-body font-semibold">{p.name}</h3>
                <p className="m-0">
                  {t("rota.patterns.line", {
                    days: p.cycleDays,
                    shifts: p.entries.reduce((n, e) => n + e.count, 0),
                    templates: [
                      ...new Set(
                        p.entries.map(
                          (e) => byId.get(e.templateId) ?? t("rota.patterns.archivedTemplate"),
                        ),
                      ),
                    ].join(", "),
                  })}
                </p>
                <ArchiveButton
                  kind="pattern"
                  id={p.id}
                  version={p.version}
                  name={p.name}
                  path={path}
                />
              </li>
            ))}
          </ul>
        )}
      </Card>
      {templates.data.items.length > 0 ? (
        <Card as="section" title={t("rota.pattern.title")} headingLevel={2}>
          <PatternForm locationId={locationId} path={path} templates={templates.data.items} />
        </Card>
      ) : null}
    </div>
  );
}
