import { StatusChip } from "@harbour/ui";
import { FlaskConical } from "lucide-react";
import { t } from "@/lib/i18n";

/**
 * The "Sample" badge beside an invented sample person's name (platform-completions.md rule 29;
 * HZ-072), an icon and a word, so practice data is never taken for a real person. Nothing for a
 * real person.
 */
export function SampleBadge({ sample }: { readonly sample: boolean | undefined }) {
  if (!sample) return null;
  return (
    <StatusChip status="info" icon={FlaskConical} label={t("sample.badge")} data-sample-badge="" />
  );
}
