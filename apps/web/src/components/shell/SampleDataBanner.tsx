import { Banner, ButtonLink } from "@harbour/ui";
import { Settings2 } from "lucide-react";
import { t } from "@/lib/i18n";
import { ONBOARDING_PAGE } from "@/lib/onboarding";

/**
 * Shown on every screen while the organisation has sample data in place (platform-completions.md
 * rules 29 to 32; HZ-072): an icon and words, never colour alone, with a way to the sample data
 * controls for whoever may manage them.
 */
export function SampleDataBanner({
  present,
  mayManage,
}: {
  readonly present: boolean;
  readonly mayManage: boolean;
}) {
  if (!present) return null;
  return (
    <Banner
      variant="sample"
      className="mb-6"
      title={t("sample.banner.title")}
      description={t("sample.banner.body")}
      action={
        mayManage ? (
          <ButtonLink
            href={`${ONBOARDING_PAGE}#sample-data`}
            variant="secondary"
            icon={<Settings2 size={16} strokeWidth={1.5} aria-hidden />}
          >
            {t("sample.banner.manage")}
          </ButtonLink>
        ) : undefined
      }
    />
  );
}
