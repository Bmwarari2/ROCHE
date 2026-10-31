import { ButtonLink, EmptyState, PageHeader } from "@harbour/ui";
import { Lock } from "lucide-react";
import type { Metadata } from "next";
import { PeopleTable } from "@/components/people/PeopleTable";
import { isPreAdmissionStage, preAdmissionShown } from "@/lib/admission";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { can } from "@/lib/care-record";
import { peopleLabel, t } from "@/lib/i18n";
import { toPersonListItem } from "@/lib/people";

export async function generateMetadata(): Promise<Metadata> {
  const { me } = await getShellContext();
  return { title: peopleLabel(me.tenant.terminology) };
}

/** Everyone in the person's scope (assigned people for care workers), for the chosen location. */
export default async function PeoplePage() {
  const { me, locationId } = await getShellContext();
  const title = peopleLabel(me.tenant.terminology);
  const api = await tenantApi();
  const { data, error, response } = await api.GET("/v1/people", {
    params: { query: locationId ? { locationId } : {} },
  });

  if (!data) {
    if (problemCode(error) === "missing_permission") {
      return (
        <div className="mx-auto flex w-full max-w-content flex-col gap-8">
          <PageHeader title={title} />
          <EmptyState
            icon={<Lock size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("errors.forbidden")}
          />
        </div>
      );
    }
    failWith(error, response, "/people");
  }

  const locationNames = new Map(me.locations.map((l) => [l.id, l.name]));
  // People not yet admitted are listed under enquiries and pre-admission (PEOP-005), not here.
  const people = data.items
    .filter((person) => !isPreAdmissionStage(person.status))
    .map((person) => toPersonListItem(person, t, locationNames));
  const location = me.locations.find((l) => l.id === locationId);

  return (
    <div className="flex w-full flex-col gap-6">
      <PageHeader
        eyebrow={location ? location.name : me.tenant.name}
        title={title}
        description={t("people.list.count", { count: people.length })}
        // Enquiries and pre-admission (PEOP-005) for those who work with them; the reviews tracker
        // (PEOP-008) for those who read care plans.
        secondaryActions={
          preAdmissionShown(me.permissions) || can(me.permissions, "care.plan.read") ? (
            <>
              {preAdmissionShown(me.permissions) ? (
                <ButtonLink href="/people/pre-admission" variant="secondary">
                  {t("people.preAdmission.list.title")}
                </ButtonLink>
              ) : null}
              {can(me.permissions, "care.plan.read") ? (
                <ButtonLink href="/people/reviews" variant="secondary">
                  {t("people.reviews.tracker.link")}
                </ButtonLink>
              ) : null}
            </>
          ) : undefined
        }
      />
      <PeopleTable
        people={people}
        showLocation={me.locations.length > 1 && !locationId}
        labels={{
          caption: title,
          photo: t("people.list.photo"),
          name: t("people.list.name"),
          room: t("people.list.room"),
          dateOfBirth: t("people.list.dateOfBirth"),
          allergies: t("people.list.allergies"),
          communication: t("people.header.communicationNeeds"),
          communicationFlag: t("people.header.communicationNeeds"),
          notRecorded: t("common.notRecorded"),
          empty: t("people.list.empty"),
        }}
      />
    </div>
  );
}
