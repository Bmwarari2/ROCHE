import { TriangleAlert } from "lucide-react";
import { Notice } from "@/components/care/Notice";
import { t } from "@/lib/i18n";
import { CdRecordingForm } from "./CdRecordingForm";

/**
 * Which register is the record at a home, and the way to change it (H-1518; HZ-115, HZ-008). A
 * state the API could not give (`null`) says so, in words with a warning icon, and offers no change
 * (clinical review of H-1518, M3).
 */
export function CdRecordingSetting({
  locationId,
  enabled,
}: {
  readonly locationId: string;
  readonly enabled: boolean | null;
}) {
  if (enabled === null) {
    return (
      <Notice
        tone="warning"
        icon={<TriangleAlert size={20} strokeWidth={1.5} aria-hidden="true" />}
        title={t("medicines.cdRecording.unreadable")}
      />
    );
  }
  return <CdRecordingForm locationId={locationId} enabled={enabled} />;
}
