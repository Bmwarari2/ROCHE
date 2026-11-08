import { StatusChip } from "@harbour/ui";
import { Ban, Smartphone } from "lucide-react";
import type { DeviceSummary } from "@/lib/care-devices";
import { t } from "@/lib/i18n";

/** Whether a phone is in use or withdrawn, as an icon and a word, never colour alone. */
export function DeviceStateChip({ device }: { readonly device: Pick<DeviceSummary, "revokedAt"> }) {
  return device.revokedAt ? (
    <StatusChip status="neutral" icon={Ban} label={t("devices.state", { state: "withdrawn" })} />
  ) : (
    <StatusChip
      status="info"
      icon={Smartphone}
      label={t("devices.state", { state: "notWithdrawn" })}
    />
  );
}
