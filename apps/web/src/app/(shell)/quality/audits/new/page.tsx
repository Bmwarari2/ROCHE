import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { StartAuditForm } from "@/components/quality/ProgrammeForms";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { getShellContext, tenantApi } from "@/lib/api";
import { t } from "@/lib/i18n";
import { readOrFail } from "@/lib/person-record";
import { auditsShown } from "@/lib/quality-programme";
import { ukToday } from "@/lib/uk-time";

export const metadata: Metadata = { title: t("quality.start.title") };

/**
 * Starting an audit or mock inspection (QUAL-004; rules 4 and 14): an active template at a
 * location, dated today or earlier. The audit keeps the template's questions and framework version
 * as they stand; a mock inspection starts only on the framework version in force, and the API's
 * refusal says so in words.
 */
export default async function StartAuditPage() {
  const { me, locationId } = await getShellContext();
  const title = t("quality.start.title");
  if (!auditsShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const templates = readOrFail(await api.GET("/v1/quality/audit-templates"), "/quality/audits/new");
  if (!templates) return <SafetyForbidden title={title} />;
  const active = templates.items.filter((tpl) => tpl.state === "active");

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6 break-words">
      <PageHeader title={title} description={t("quality.start.description")} />
      <p className="m-0">
        <Link href="/quality/audits" className="underline">
          {t("quality.templates.back")}
        </Link>
      </p>
      <Card as="section" title={t("quality.start.cardTitle")} headingLevel={2}>
        {active.length === 0 ? (
          <p className="m-0">
            {t("quality.start.noTemplates")}{" "}
            <Link href="/quality/audits/templates" className="underline">
              {t("quality.audits.templates")}
            </Link>
          </p>
        ) : (
          <StartAuditForm
            templates={active}
            locations={me.locations}
            defaultLocationId={locationId ?? null}
            today={ukToday()}
          />
        )}
      </Card>
    </div>
  );
}
