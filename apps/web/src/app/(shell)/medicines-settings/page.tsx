import { PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { getShellContext } from "@/lib/api";
import { cdRecordingSettingsHref, cdRecordingSettingsShown } from "@/lib/controlled-drugs";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: t("medicines.cdRecording.title") };

/**
 * Controlled drug recording (H-1518): the chosen home's page, or which home when the shell shows
 * every one. Offered only to those who may turn it on or off; the API checks again at the home.
 */
export default async function MedicinesSettingsIndexPage() {
  const { me, locationId } = await getShellContext();
  const title = t("medicines.cdRecording.title");
  if (!cdRecordingSettingsShown(me.permissions)) return <SafetyForbidden title={title} />;
  if (locationId) redirect(cdRecordingSettingsHref(locationId));
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={me.tenant.name}
        title={title}
        description={t("medicines.cdRecording.choose")}
      />
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {me.locations.map((location) => (
          <li key={location.id}>
            <Link
              href={cdRecordingSettingsHref(location.id)}
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
