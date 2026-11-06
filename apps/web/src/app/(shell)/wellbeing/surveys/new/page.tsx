import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { SurveyForm } from "@/components/scheduling/WellbeingForms";
import { getShellContext } from "@/lib/api";
import { t } from "@/lib/i18n";
import { wellbeingAccess } from "@/lib/wellbeing";

export const metadata: Metadata = { title: t("scheduling.wellbeing.form.pageTitle") };

/**
 * Write a staff survey as a draft (scheduling.md section 16 rule 1). The whole organisation is
 * offered as well as each home; the API refuses it for someone who manages only some homes.
 */
export default async function NewSurveyPage() {
  const { me } = await getShellContext();
  const title = t("scheduling.wellbeing.form.pageTitle");
  if (!wellbeingAccess(me.permissions).manage) return <SafetyForbidden title={title} />;
  const places = [
    { value: "organisation", label: t("scheduling.wellbeing.organisation") },
    ...me.locations.map((l) => ({ value: l.id, label: l.name })),
  ];
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={me.tenant.name}
        title={title}
        description={t("scheduling.wellbeing.form.description")}
      />
      <p className="m-0">
        <Link href="/wellbeing/surveys" className="inline-flex min-h-target items-center underline">
          {t("scheduling.wellbeing.surveys.back")}
        </Link>
      </p>
      <Card>
        <SurveyForm places={places} />
      </Card>
    </div>
  );
}
