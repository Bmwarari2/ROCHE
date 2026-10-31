import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { StarterForm } from "@/components/quality/ProgrammeForms";
import { QualityChip } from "@/components/quality/QualityChip";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { getShellContext, tenantApi } from "@/lib/api";
import { t } from "@/lib/i18n";
import { readOrFail } from "@/lib/person-record";
import { qualityDone } from "@/lib/quality-done";
import { auditsShown } from "@/lib/quality-programme";

export const metadata: Metadata = { title: t("quality.templates.title") };

/**
 * Audit templates (QUAL-004; rule 8): the organisation's own, active and retired, each opening its
 * questions and schedules, and a form to add one from Harbour's starters.
 */
export default async function TemplatesPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ done?: string | string[] }>;
}) {
  const { me } = await getShellContext();
  const title = t("quality.templates.title");
  if (!auditsShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const path = "/quality/audits/templates";
  const [templates, starters] = await Promise.all([
    api.GET("/v1/quality/audit-templates"),
    api.GET("/v1/quality/audit-starters"),
  ]);
  const own = readOrFail(templates, path);
  const offered = readOrFail(starters, path);
  if (!own || !offered) return <SafetyForbidden title={title} />;
  const done = qualityDone((await searchParams).done);

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6 break-words">
      <PageHeader title={title} description={t("quality.templates.description")} />
      {done ? <RecordedArrival message={t("quality.done", { done })} param="done" /> : null}
      <p className="m-0">
        <Link href="/quality/audits" className="inline-flex min-h-target items-center underline">
          {t("quality.templates.back")}
        </Link>
      </p>
      <Card as="section" title={t("quality.templates.yours")} headingLevel={2}>
        {own.items.length === 0 ? (
          <p className="m-0">{t("quality.templates.none")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-4 p-0">
            {own.items.map((template) => (
              <li key={template.id} className="flex flex-col gap-1 border-b border-border pb-3">
                <h3 className="m-0 text-body font-semibold">
                  <Link
                    href={`/quality/audits/templates/${template.id}`}
                    className="inline-flex min-h-target items-center underline"
                  >
                    {template.title}
                  </Link>
                </h3>
                <span>
                  <QualityChip
                    chip={
                      template.state === "active"
                        ? {
                            status: "done",
                            icon: "circle-check",
                            label: t("quality.templates.active"),
                          }
                        : {
                            status: "neutral",
                            icon: "circle-minus",
                            label: t("quality.templates.retired"),
                          }
                    }
                  />
                </span>
                <span className="text-body-dense text-text-secondary">
                  {t("quality.templates.itemDetail", {
                    kind: template.kind,
                    questions: template.questions.length,
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card as="section" title={t("quality.templates.fromStarter")} headingLevel={2}>
        <StarterForm starters={offered.items} />
      </Card>
    </div>
  );
}
