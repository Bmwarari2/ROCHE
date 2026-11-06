import { Banner } from "@harbour/ui";
import type { tenantApi } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";

/**
 * The Thapsus-HR link's staleness note on rota and staffing screens (integrations.md section 11.5
 * rule 9; HZ-133): when leave, sickness and staff changes from the HR platform are older than the
 * organisation's limit, it says so in words, with an icon and the time, never by colour alone.
 * Nothing shows for an organisation without the link, or when the note cannot be read.
 */
export async function HrLinkStaleness({ api }: { api: Awaited<ReturnType<typeof tenantApi>> }) {
  const got = await api.GET("/v1/integrations/hr-link/staleness");
  const state = got.data;
  if (!state?.linked || !state.stale) return null;
  const time = formatDateTime(state.lastGoodSyncAt);
  return (
    <Banner
      variant="stale"
      title={t("rota.hrLink.staleTitle")}
      description={
        time
          ? t("rota.hrLink.staleBody", { app: t("app.name"), time })
          : t("rota.hrLink.neverBody", { app: t("app.name") })
      }
    />
  );
}
