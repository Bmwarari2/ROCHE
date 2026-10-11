import { EmptyState } from "@harbour/ui";
import { Lock } from "lucide-react";
import { t } from "@/lib/i18n";

/** A tab the person may not read: says so in words rather than showing an empty record. */
export function NoAccess() {
  return (
    <EmptyState
      headingLevel={2}
      icon={<Lock size={32} strokeWidth={1.5} aria-hidden="true" />}
      title={t("care.noAccess.title")}
      description={t("care.noAccess.body")}
    />
  );
}
