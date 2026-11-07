import { PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { getShellContext } from "@/lib/api";
import { t } from "@/lib/i18n";
import { reportsHref, reviewsShown } from "@/lib/medication-errors";

export const metadata: Metadata = { title: t("medicines.errors.reports.title") };

/**
 * The medicines reports (slice 55; MEDS-012, MEDS-013; medicines.md section 14.3): the chosen
 * location's, or which location when the shell shows every one. For `medicines.record.manage`.
 */
export default async function MedicinesReportsIndexPage() {
  const { me, locationId } = await getShellContext();
  const title = t("medicines.errors.reports.title");
  if (!reviewsShown(me.permissions)) return <SafetyForbidden title={title} />;
  if (locationId) redirect(reportsHref(locationId));
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={me.tenant.name}
        title={title}
        description={t("medicines.errors.reports.choose")}
      />
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {me.locations.map((location) => (
          <li key={location.id}>
            <Link
              href={reportsHref(location.id)}
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
