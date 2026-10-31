import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { RetireTemplateForm, ScheduleForm } from "@/components/quality/ProgrammeForms";
import { QualityChip } from "@/components/quality/QualityChip";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { getShellContext, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { readOrFail } from "@/lib/person-record";
import { qualityDone } from "@/lib/quality-done";
import { auditsShown, scheduleChip, statementRows } from "@/lib/quality-programme";

export const metadata: Metadata = { title: t("quality.templates.title") };

/**
 * One audit template (QUAL-004; rules 8 and 13): its questions with their weights, the quality
 * statements each evidences and whether a shortfall needs an action; its schedules with when each
 * is next due; a form to schedule it at a location; and retiring it (final).
 */
export default async function TemplatePage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ id: string }>;
  readonly searchParams: Promise<{ done?: string | string[] }>;
}) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { me } = await getShellContext();
  const title = t("quality.templates.title");
  if (!auditsShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const path = `/quality/audits/templates/${id}`;
  const [templates, schedules] = await Promise.all([
    api.GET("/v1/quality/audit-templates"),
    api.GET("/v1/quality/audit-schedules", { params: { query: {} } }),
  ]);
  const own = readOrFail(templates, path);
  const due = readOrFail(schedules, path);
  if (!own || !due) return <SafetyForbidden title={title} />;
  const template = own.items.find((tpl) => tpl.id === id);
  if (!template) notFound();
  const framework = (
    await api.GET("/v1/quality/frameworks/{id}", {
      params: { path: { id: template.frameworkVersionId } },
    })
  ).data;
  const titles = new Map(framework ? statementRows(framework).map((s) => [s.id, s.title]) : []);
  const places = new Map(me.locations.map((l) => [l.id, l.name]));
  const mine = due.items.filter((s) => s.templateId === id);
  const done = qualityDone((await searchParams).done);
  const date = (iso: string) => formatDate(iso) ?? iso;

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6 break-words">
      <PageHeader
        title={template.title}
        description={t("quality.templates.detailDescription", { kind: template.kind })}
      />
      {done ? <RecordedArrival message={t("quality.done", { done })} param="done" /> : null}
      <p className="m-0">
        <Link href="/quality/audits/templates" className="underline">
          {t("quality.templates.backToList")}
        </Link>
      </p>
      <div>
        <QualityChip
          chip={
            template.state === "active"
              ? { status: "done", icon: "circle-check", label: t("quality.templates.active") }
              : { status: "neutral", icon: "circle-minus", label: t("quality.templates.retired") }
          }
        />
      </div>
      <Card as="section" title={t("quality.templates.questions")} headingLevel={2}>
        <ol className="m-0 flex flex-col gap-4 pl-5">
          {template.questions.map((q) => (
            <li key={q.key} className="flex flex-col gap-1">
              <span className="font-semibold">{q.text}</span>
              <span className="text-body-dense text-text-secondary">
                {t("quality.templates.questionDetail", {
                  weight: q.weight,
                  actionRequired: String(q.actionRequired),
                })}
              </span>
              {q.statementIds.length > 0 ? (
                <span className="text-body-dense text-text-secondary">
                  {t("quality.templates.evidences", {
                    statements: q.statementIds.map((s) => titles.get(s) ?? s).join("; "),
                  })}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      </Card>
      <Card as="section" title={t("quality.templates.schedules")} headingLevel={2}>
        <div className="flex flex-col gap-6">
          {mine.length === 0 ? (
            <p className="m-0">{t("quality.templates.notScheduled")}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {mine.map((s) => (
                <li key={s.id} className="flex flex-col gap-1 border-b border-border pb-3">
                  <span className="font-semibold">
                    {places.get(s.locationId) ?? t("quality.audits.unknownPlace")}
                  </span>
                  <span>
                    <QualityChip chip={scheduleChip(s, date, t)} />
                  </span>
                  <span className="text-body-dense text-text-secondary">
                    {t("quality.audits.scheduleDetail", {
                      months: s.frequencyMonths,
                      last: s.lastCompletedOn ? date(s.lastCompletedOn) : "",
                      hasLast: String(s.lastCompletedOn !== null),
                    })}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {template.state === "active" ? (
            <ScheduleForm
              templateId={id}
              locations={me.locations.filter((l) => !mine.some((s) => s.locationId === l.id))}
              path={path}
            />
          ) : null}
        </div>
      </Card>
      {template.state === "active" ? (
        <Card as="section" title={t("quality.templates.retireCard")} headingLevel={2}>
          <RetireTemplateForm template={template} path={path} />
        </Card>
      ) : null}
    </div>
  );
}
