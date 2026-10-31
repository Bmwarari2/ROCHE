import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PersonNeeds } from "@/components/safety/PersonNeeds";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { OpenEpisodeForm } from "@/components/safety-events/MissingForms";
import { getShellContext } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import { MISSING_REPORT } from "@/lib/missing";
import { personNames } from "@/lib/people";
import { getPerson } from "@/lib/person-record";

export const metadata: Metadata = { title: t("missing.new") };

/**
 * Opening a missing person episode from its incident (`?incident=&person=`; safety.incident.report):
 * the police call target starts from when the person was noticed missing.
 */
export default async function OpenEpisodePage({
  searchParams,
}: {
  searchParams: Promise<{ incident?: string; person?: string }>;
}) {
  const { incident, person: personId } = await searchParams;
  if (!incident || !personId || !isUuid(incident) || !isUuid(personId)) notFound();
  const { me } = await getShellContext();
  const title = t("missing.new");
  if (!me.permissions.includes(MISSING_REPORT)) return <SafetyForbidden title={title} />;
  const { person } = await getPerson(personId);
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader title={title} description={t("missing.newDescription")} />
      {person ? (
        <Card as="section" headingLevel={2} title={personNames(person).full}>
          <PersonNeeds person={person} />
        </Card>
      ) : null}
      <Card>
        <OpenEpisodeForm incidentId={incident} personId={personId} />
      </Card>
    </div>
  );
}
