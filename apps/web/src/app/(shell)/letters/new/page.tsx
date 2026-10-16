import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { MergeFieldHelp } from "@/components/comms/MergeFieldHelp";
import { TemplateForm } from "@/components/comms/TemplateForm";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { getShellContext } from "@/lib/api";
import { t } from "@/lib/i18n";
import { TEMPLATE_WRITE } from "@/lib/letters";

export const metadata: Metadata = { title: t("comms.templates.newTitle") };

/** A new template and its first draft (`comms.template.write`). */
export default async function NewTemplatePage() {
  const { me } = await getShellContext();
  const title = t("comms.templates.newTitle");
  if (!me.permissions.includes(TEMPLATE_WRITE)) return <SafetyForbidden title={title} />;
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <nav aria-label={t("common.breadcrumb")} className="text-body-dense">
        <Link href="/letters" className="inline-flex min-h-target items-center underline">
          {t("comms.templates.title")}
        </Link>
      </nav>
      <PageHeader
        eyebrow={me.tenant.name}
        title={title}
        description={t("comms.templates.newIntro")}
      />
      <Card as="section" title={t("comms.templates.draftTitle")} headingLevel={2}>
        <TemplateForm mode={{ kind: "create" }} path="/letters/new" />
      </Card>
      <MergeFieldHelp />
    </div>
  );
}
