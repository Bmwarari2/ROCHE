import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { RaiseConcernForm } from "@/components/safety-silos/SafeguardingForms";
import { getShellContext, tenantApi } from "@/lib/api";
import { can } from "@/lib/care-record";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import { personNames } from "@/lib/people";

export const metadata: Metadata = { title: t("safeguarding.new") };

/**
 * Raising a safeguarding concern about a person (safety.incident.report, as the API asks): the
 * people offered are those in the raiser's scope. `?person=` chooses one, from their record.
 */
export default async function RaiseConcernPage({
  searchParams,
}: {
  searchParams: Promise<{ person?: string }>;
}) {
  const { person } = await searchParams;
  const { me, locationId } = await getShellContext();
  const title = t("safeguarding.new");
  if (!can(me.permissions, "safety.incident.report")) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const listed = await api.GET("/v1/people", {
    params: { query: locationId ? { locationId } : {} },
  });
  const people = (listed.data?.items ?? []).map((p) => ({ id: p.id, name: personNames(p).full }));
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader title={title} description={t("safeguarding.newDescription")} />
      <Card>
        {people.length === 0 ? (
          <p className="m-0">{t("safeguarding.form.noPeople")}</p>
        ) : (
          <RaiseConcernForm people={people} personId={person && isUuid(person) ? person : null} />
        )}
      </Card>
    </div>
  );
}
