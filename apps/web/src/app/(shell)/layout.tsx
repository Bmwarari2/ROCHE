import type { LocationSummary } from "@harbour/contracts";
import type { ReactNode } from "react";
import { OfflineBanner } from "@/components/shell/OfflineBanner";
import { ShellFrame } from "@/components/shell/ShellFrame";
import { getShellContext, tenantApi } from "@/lib/api";
import { downtimeNavShown } from "@/lib/downtime";
import { handoverShown } from "@/lib/handover";
import { peopleLabel, t } from "@/lib/i18n";
import { incidentsNavLabel } from "@/lib/incidents";
import { templatesNavShown } from "@/lib/letters";
import { roundShown } from "@/lib/round";
import { teamShown } from "@/lib/team";

/** "CQC location 1-000000001", for the location switcher. */
function locationDescription(location: LocationSummary): string | undefined {
  return location.regulatorLocationId
    ? t("shell.locationSwitcher.regulatorLocation", {
        regulator: location.regulator,
        id: location.regulatorLocationId,
      })
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
        skipLink: t("shell.skipLink"),
        organisation: t("shell.tenantSwitcher.label"),
        organisationMenu: t("shell.tenantSwitcher.menuLabel"),
        location: t("shell.locationSwitcher.label"),
        locationMenu: t("shell.locationSwitcher.menuLabel"),
        allLocations: t("shell.locationSwitcher.all"),
        navigation: t("shell.nav.label"),
        home: t("shell.nav.home"),
        people: peopleLabel(me.tenant.terminology),
        round: roundShown(me.permissions) ? t("shell.nav.round") : undefined,
        handover: handoverShown(me.permissions) ? t("shell.nav.handover") : undefined,
        incidents: incidentsNavLabel(me.permissions, t),
        downtime: downtimeNavShown(me.permissions) ? t("shell.nav.downtime") : undefined,
        letters: templatesNavShown(me.permissions) ? t("shell.nav.letters") : undefined,
        team: teamShown(me.permissions) ? t("shell.nav.team") : undefined,
        notifications: t("shell.nav.notifications"),
        unreadNotifications: t("shell.nav.unread", { count: unread }),
        settings: t("shell.nav.settings"),
        accountMenu: t("shell.account.menu", { name: me.user.name }),
        security: t("security.title"),
        signOut: t("common.signOut"),
      }}
    >
      <OfflineBanner />
      {children}
    </ShellFrame>
  );
}
