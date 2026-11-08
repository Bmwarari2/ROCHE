import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CdRecordingForm } from "@/components/medicines/CdRecordingForm";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { getShellContext } from "@/lib/api";
import { cdRecordingAt } from "@/lib/cd-recording";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";

type Params = Promise<{ locationId: string }>;

export const metadata: Metadata = { title: t("medicines.cdRecording.title") };

/** Who may turn controlled drug recording on or off at a home: the API checks both again. */
const NEEDS = ["medicines.record.manage", "platform.location.manage"] as const;

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
  if (!NEEDS.every((p) => me.permissions.includes(p))) return <SafetyForbidden title={title} />;
  const enabled = await cdRecordingAt(locationId);
  return (
    <>
      <PageHeader
        eyebrow={location.name}
        title={title}
        description={t("medicines.cdRecording.description")}
      />
      <Card as="section" title={t("medicines.cdRecording.cardTitle")} headingLevel={2}>
        <CdRecordingForm locationId={locationId} enabled={enabled} />
      </Card>
    </>
  );
}
