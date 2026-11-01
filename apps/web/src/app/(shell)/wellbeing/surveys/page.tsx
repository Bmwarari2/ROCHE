import { ButtonLink, Card, EmptyState, PageHeader, StatusChip } from "@harbour/ui";
import { ClipboardList, Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { surveyStateChip, wellbeingAccess } from "@/lib/wellbeing";

export const metadata: Metadata = { title: t("scheduling.wellbeing.surveys.title") };

/** Staff surveys at the homes the reader manages (scheduling.wellbeing.manage). */
export default async function SurveysPage() {
  const { me } = await getShellContext();
  const title = t("scheduling.wellbeing.surveys.title");
  if (!wellbeingAccess(me.permissions).manage) return <SafetyForbidden title={title} />;
  const listed = await (await tenantApi()).GET("/v1/pulse-surveys", {
    params: { query: { view: "manage" } },
  });
  if (!listed.data) failWith(listed.error, listed.response);
  const where = (locationId: string | null) =>
    locationId === null
      ? t("scheduling.wellbeing.organisation")
      : (me.locations.find((l) => l.id === locationId)?.name ??
        t("scheduling.wellbeing.otherHome"));

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={me.tenant.name}
        title={title}
        description={t("scheduling.wellbeing.surveys.description")}
      />
      <div className="flex flex-wrap items-center gap-4">
        <Link href="/wellbeing" className="inline-flex min-h-target items-center underline">
          {t("scheduling.wellbeing.back")}
        </Link>
        <ButtonLink href="/wellbeing/surveys/new" icon={<Plus size={16} strokeWidth={1.5} />}>
          {t("scheduling.wellbeing.surveys.new")}
        </ButtonLink>
      </div>
      {listed.data.items.length === 0 ? (
        <Card>
          <EmptyState
            headingLevel={2}
            icon={<ClipboardList size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("scheduling.wellbeing.surveys.none")}
          />
        </Card>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {listed.data.items.map((s) => (
            <li key={s.id}>
              <Card>
                <div className="flex flex-col gap-2">
                  <h2 className="m-0 text-heading-sm">
                    <Link
                      href={`/wellbeing/surveys/${s.id}`}
                      className="inline-flex min-h-target items-center underline"
                    >
                      {s.title}
                    </Link>
                  </h2>
                  <div>
                    <StatusChip {...surveyStateChip(s.state, t)} />
                  </div>
                  <p className="m-0">
                    {t("scheduling.wellbeing.surveys.line", {
                      where: where(s.locationId),
                      opens: formatDate(s.opensOn) ?? "",
                      closes: formatDate(s.closesOn) ?? "",
                      questions: s.questions.length,
                    })}
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
