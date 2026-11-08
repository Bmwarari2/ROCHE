import { TriangleAlert } from "lucide-react";
import { Notice } from "@/components/care/Notice";
import { t } from "@/lib/i18n";

/**
 * Says that controlled drug recording is not turned on at this home, so the paper controlled drugs
 * register is the record (H-1517, HZ-115, HZ-008): shown at the top of every register screen until
 * the location's release flag is on. Words and a warning icon, never colour alone.
 */
export function CdRecordingBanner({ on }: { readonly on: boolean }) {
  if (on) return null;
  return (
    <Notice
      tone="warning"
      icon={<TriangleAlert size={20} strokeWidth={1.5} aria-hidden="true" />}
      title={t("cd.notTurnedOn.title")}
    >
      {t("cd.notTurnedOn.body")}
    </Notice>
  );
}
