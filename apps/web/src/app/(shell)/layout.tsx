import type { LocationSummary } from "@harbour/contracts";
import type { ReactNode } from "react";
import { OfflineBanner } from "@/components/shell/OfflineBanner";
import { ShellFrame } from "@/components/shell/ShellFrame";
import { getShellContext, tenantApi } from "@/lib/api";
import { peopleLabel, t } from "@/lib/i18n";

const REGULATOR: Record<LocationSummary["regulator"], string> = {
  cqc: "CQC",
  ciw: "CIW",
  care_inspectorate: "Care Inspectorate",
  rqia: "RQIA",
  ofsted: "Ofsted",
};

function locationDescription(location: LocationSummary): string | undefined {
  return location.regulatorLocationId
    ? `${REGULATOR[location.regulator]} location ${location.regulatorLocationId}`
    : undefined;
}

/** The signed-in product shell. Every page under it has a session and an active organisation. */
export default async function ShellLayout({ children }: { readonly children: ReactNode }) {
  const { me, locationId } = await getShellContext();
  const api = await tenantApi();
  // The unread count is a convenience; the shell still renders if it cannot be fetched.
  const notifications = await api.GET("/v1/notifications").catch(() => null);
  const unread = notifications?.data?.unread ?? 0;

  return (
    <ShellFrame
      user={{ name: me.user.name, email: me.user.email }}
      organisation={{ id: me.tenant.id, name: me.tenant.name }}
      memberships={me.memberships}
      locations={me.locations.map((location) => {
        const description = locationDescription(location);
        return { id: location.id, name: location.name, ...(description ? { description } : {}) };
      })}
      locationId={locationId}
      unreadNotifications={unread}
      labels={{
        organisation: t("shell.tenantSwitcher.label"),
        location: t("shell.locationSwitcher.label"),
        allLocations: t("shell.locationSwitcher.all"),
        home: t("shell.nav.home"),
        people: peopleLabel(me.tenant.terminology),
        notifications: t("shell.nav.notifications"),
        settings: t("shell.nav.settings"),
        signOut: t("common.signOut"),
      }}
    >
      <OfflineBanner />
      {children}
    </ShellFrame>
  );
}
