import { Banner } from "@harbour/ui";
import type { tenantApi } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";

/**
 * The Thapsus-HR link's staleness note on rota and staffing screens (integrations.md section 11.5
 * rule 9; HZ-133): when leave, sickness and staff changes from the HR platform are older than the
 * organisation's limit, it says so in words, with an icon and the time, never by colour alone. It
 * is part of the page, not news, so it has no live region (it never talks over a save
 * confirmation) and follows the page heading. Nothing shows without the link (403 or 404); any
 * other failure to check shows the note, since the data may be at its least reliable then.
 */
export async function HrLinkStaleness({ api }: { api: Awaited<ReturnType<typeof tenantApi>> }) {
  const got = await api.GET("/v1/integrations/hr-link/staleness");
  const state = got.data;
  const status = got.response.status;
  if (!state && (status === 403 || status === 404)) return null;
  if (state && (!state.linked || !state.stale)) return null;
  const at = state?.lastGoodSyncAt ?? null;
  const description = !state
    ? t("rota.hrLink.uncheckedBody", { app: t("app.name") })
    : at
      ? // The time is said once, in UK time, in the detail line below (one conversion).
        t("rota.hrLink.staleBody", { app: t("app.name") })
      : t("rota.hrLink.neverBody", { app: t("app.name") });
  return (
    <Banner
      variant="stale"
      announce={false}
      title={t("rota.hrLink.staleTitle")}
      description={description}
      detail={
        at ? (
          <>
            {t("rota.hrLink.lastUpdated")} <time dateTime={at}>{formatDateTime(at)}</time>
          </>
        ) : undefined
      }
    />
  );
}
