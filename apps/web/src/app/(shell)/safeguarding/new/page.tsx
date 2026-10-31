import type { PersonSummary } from "@harbour/contracts";
import { Card, PageHeader } from "@harbour/ui";
import { TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import { Notice } from "@/components/care/Notice";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { RaiseConcernForm } from "@/components/safety-silos/SafeguardingForms";
import { getShellContext, tenantApi } from "@/lib/api";
import { can } from "@/lib/care-record";
import { isUuid } from "@/lib/context-cookies";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { personNames } from "@/lib/people";

export const metadata: Metadata = { title: t("safeguarding.new") };

/**
 * Raising a safeguarding concern about a person (safety.incident.report, as the API asks): the
 * people offered are those at the selected home, each with their date of birth; nobody is chosen
 * until the raiser chooses. `?person=` chooses one, from their record.
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
  const option = (p: PersonSummary) => ({
    id: p.id,
    name: personNames(p).full,
    label: t("safeguarding.form.personOption", {
      name: personNames(p).full,
      born: formatDate(p.dateOfBirth) ?? "",
    }),
  });
  const people = (listed.data?.items ?? []).map(option);
  // A person chosen from their record but not at the selected home is loaded on their own, never
  // replaced by whoever is listed first (clinical review, finding 1; HZ-126).
  const wanted = person && isUuid(person) ? person : null;
  let missing = false;
  if (wanted && !people.some((p) => p.id === wanted)) {
    const one = await api.GET("/v1/people/{id}", { params: { path: { id: wanted } } });
    if (one.data) people.unshift(option(one.data));
    else missing = true;
  }
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader title={title} description={t("safeguarding.newDescription")} />
      {missing ? (
        <Notice
          tone="warning"
          icon={<TriangleAlert size={20} strokeWidth={1.5} aria-hidden="true" />}
          title={t("safeguarding.form.personNotFound")}
        />
      ) : null}
      <Card>
        {people.length === 0 ? (
          <p className="m-0">{t("safeguarding.form.noPeople")}</p>
        ) : (
          <RaiseConcernForm
            people={people}
            personId={missing ? null : wanted}
            canManage={can(me.permissions, "safety.safeguarding.manage")}
          />
        )}
      </Card>
    </div>
  );
}
