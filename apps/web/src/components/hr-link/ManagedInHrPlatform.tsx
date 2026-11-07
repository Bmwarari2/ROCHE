import { StatusChip } from "@harbour/ui";
import { Lock } from "lucide-react";
import { t } from "@/lib/i18n";

/**
 * Says that a record is a read-only copy kept by the HR platform (integrations.md section 11.5
 * rule 2; HZ-133): an icon and words, never colour alone, so nobody tries to change it here. The
 * API refuses a change to it (`managed_in_thapsus_hr`); it is changed in the HR platform and the
 * copy follows at the next sync.
 */
export function ManagedInHrPlatform({ detail }: { readonly detail?: "absence" | "payRun" }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <StatusChip status="info" icon={Lock} label={t("hrLink.managed.label")} />
      {detail ? (
        <span className="text-body-dense text-text-secondary">
          {t("hrLink.managed.detail", { detail, app: t("app.name") })}
        </span>
      ) : null}
    </span>
  );
}
