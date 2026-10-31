import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import { BrandingDetailsForm, BrandingLogoForm } from "@/components/branding/BrandingForms";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { BRANDING_PAGE, brandingShown } from "@/lib/branding";
import { t } from "@/lib/i18n";
import { firstParam } from "@/lib/record-metadata";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata: Metadata = { title: t("branding.title") };

const DONE = new Set(["saved", "logo", "removed"]);

/**
 * White-label branding (PLAT-002; platform.md, white-label branding): the organisation's display
 * name, accent colour and logo, for platform.tenant.manage. The accent is checked as it is typed,
 * in both themes; the API checks the permission and every rule again.
 */
export default async function BrandingPage({
  searchParams,
}: {
  readonly searchParams: SearchParams;
}) {
  const { me } = await getShellContext();
  const title = t("branding.title");
  if (!brandingShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const read = await api.GET("/v1/branding");
  if (!read.data) failWith(read.error, read.response, BRANDING_PAGE);
  const branding = read.data;
  const done = firstParam((await searchParams).done);

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader eyebrow={me.tenant.name} title={title} description={t("branding.description")} />
      {done && DONE.has(done) ? (
        <RecordedArrival message={t("branding.done", { done })} param="done" />
      ) : null}
      <Card as="section" title={t("branding.details.title")} headingLevel={2}>
        <BrandingDetailsForm key={branding.version} branding={branding} />
      </Card>
      <Card as="section" title={t("branding.logo.title")} headingLevel={2}>
        <BrandingLogoForm key={branding.logo?.documentId ?? "none"} logo={branding.logo} />
      </Card>
    </div>
  );
}
