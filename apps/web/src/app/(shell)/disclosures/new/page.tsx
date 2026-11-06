import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { LogRequestForm } from "@/components/safety-events/DisclosureForms";
import { getShellContext, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { canManageDisclosures } from "@/lib/disclosures";
import { t } from "@/lib/i18n";
import { personNames } from "@/lib/people";

export const metadata: Metadata = { title: t("disclosures.new") };

/** Logging a disclosure request (safety.incident.manage where the person is). `?person=` chooses one. */
export default async function NewDisclosurePage({
  searchParams,
}: {
  searchParams: Promise<{ person?: string }>;
}) {
  const { person } = await searchParams;
  const { me, locationId } = await getShellContext();
  const title = t("disclosures.new");
  if (!canManageDisclosures(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const listed = await api.GET("/v1/people", {
    params: { query: locationId ? { locationId } : {} },
  });
  const people = (listed.data?.items ?? []).map((p) => ({ id: p.id, name: personNames(p).full }));
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader title={title} description={t("disclosures.newDescription")} />
      <Card>
        {people.length === 0 ? (
          <p className="m-0">{t("disclosures.form.noPeople")}</p>
        ) : (
          <LogRequestForm people={people} personId={person && isUuid(person) ? person : null} />
        )}
      </Card>
    </div>
  );
}
