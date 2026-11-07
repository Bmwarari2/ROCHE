import { PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { getShellContext } from "@/lib/api";
import { t } from "@/lib/i18n";
import { locationRoundHref, medicinesRoundShown } from "@/lib/medicine-round";

export const metadata: Metadata = { title: t("medicines.round.title") };

/** The medicines round: the chosen location's, or which location when the shell shows every one. */
export default async function MedicinesRoundIndexPage() {
  const { me, locationId } = await getShellContext();
  const title = t("medicines.round.title");
  if (!medicinesRoundShown(me.permissions)) return <SafetyForbidden title={title} />;
  if (locationId) redirect(locationRoundHref(locationId));
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={me.tenant.name}
        title={title}
        description={t("medicines.round.choose")}
      />
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {me.locations.map((location) => (
          <li key={location.id}>
            <Link
              href={locationRoundHref(location.id)}
              className="inline-flex min-h-target items-center underline"
            >
              {location.name}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
