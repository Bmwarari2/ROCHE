import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CdRecordingSetting } from "@/components/medicines/CdRecordingSetting";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { getShellContext } from "@/lib/api";
import { cdRecordingStateAt } from "@/lib/cd-recording";
import { isUuid } from "@/lib/context-cookies";
import { cdRecordingSettingsShown } from "@/lib/controlled-drugs";
import { t } from "@/lib/i18n";

type Params = Promise<{ locationId: string }>;

export const metadata: Metadata = { title: t("medicines.cdRecording.title") };

/**
 * Controlled drug recording at one home (H-1517, H-1518; HZ-115, HZ-008): whether Thapsus Care's
 * register or the paper register is the record there, and the way to change it, for the Owner and
 * the Registered Manager. The state comes from the API's flags at the home; one it cannot read
 * shows as the paper register.
 */
export default async function MedicinesSettingsPage({ params }: { readonly params: Params }) {
  const { locationId } = await params;
  if (!isUuid(locationId)) notFound();
  const { me } = await getShellContext();
  const title = t("medicines.cdRecording.title");
  const location = me.locations.find((l) => l.id === locationId);
  if (!location) notFound();
  if (!cdRecordingSettingsShown(me.permissions)) return <SafetyForbidden title={title} />;
  const enabled = await cdRecordingStateAt(locationId);
  return (
    <>
      <PageHeader
        eyebrow={location.name}
        title={title}
        description={t("medicines.cdRecording.description")}
      />
      <Card as="section" title={t("medicines.cdRecording.cardTitle")} headingLevel={2}>
        <CdRecordingSetting locationId={locationId} enabled={enabled} />
      </Card>
    </>
  );
}
