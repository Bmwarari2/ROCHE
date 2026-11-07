import { PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { getShellContext } from "@/lib/api";
import { t } from "@/lib/i18n";
import { locationStockHref, stockShown } from "@/lib/medicine-stock";

export const metadata: Metadata = { title: t("medicines.stock.title") };

/** Medicines stock: the chosen location's, or which location when the shell shows every one. */
export default async function MedicinesStockIndexPage() {
  const { me, locationId } = await getShellContext();
  const title = t("medicines.stock.title");
  if (!stockShown(me.permissions)) return <SafetyForbidden title={title} />;
  if (locationId) redirect(locationStockHref(locationId));
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={me.tenant.name}
        title={title}
        description={t("medicines.stock.choose")}
      />
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {me.locations.map((location) => (
          <li key={location.id}>
            <Link
              href={locationStockHref(location.id)}
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
