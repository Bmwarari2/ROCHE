import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { t } from "@/lib/i18n";

/** Pay is organisation-wide: a pay permission held for some homes only is refused, in words. */
export function PayNotOrganisationWide({ title }: { readonly title: string }) {
  return <SafetyForbidden title={title} hint={t("payTime.pay.notOrganisationWide")} />;
}
