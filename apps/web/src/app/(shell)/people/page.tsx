import { EmptyState, PageHeader } from "@harbour/ui";
import { Lock } from "lucide-react";
import type { Metadata } from "next";
import { PeopleTable } from "@/components/people/PeopleTable";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
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
  const people = data.items.map((person) => toPersonListItem(person, t, locationNames));
  const location = me.locations.find((l) => l.id === locationId);

  return (
    <div className="flex w-full flex-col gap-6">
      <PageHeader
        eyebrow={location ? location.name : me.tenant.name}
        title={title}
        description={
          people.length === 1 ? "1 person in your care." : `${people.length} people in your care.`
        }
      />
      <PeopleTable
        people={people}
        showLocation={me.locations.length > 1 && !locationId}
        labels={{
          caption: title,
          photo: "Photo",
          name: "Name",
          room: "Room",
          dateOfBirth: "Date of birth",
          allergies: "Allergies",
          communication: t("people.header.communicationNeeds"),
          communicationFlag: t("people.header.communicationNeeds"),
          notRecorded: t("common.notRecorded"),
          none: t("common.none"),
          empty: t("people.list.empty"),
        }}
      />
    </div>
  );
}
