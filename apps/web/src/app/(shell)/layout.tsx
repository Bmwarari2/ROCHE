import type { LocationSummary } from "@harbour/contracts";
import type { ReactNode } from "react";
import { OfflineBanner } from "@/components/shell/OfflineBanner";
import { SampleDataBanner } from "@/components/shell/SampleDataBanner";
import { ShellFrame } from "@/components/shell/ShellFrame";
import { getShellContext } from "@/lib/api";
import { accentStyle, brandingShown, logoSrc } from "@/lib/branding";
import { breakGlassReportShown } from "@/lib/break-glass-report";
import { readNotifications } from "@/lib/dashboard-data";
import { downtimeNavShown } from "@/lib/downtime";
import { dpiaShown } from "@/lib/dpia";
import { evidencePacksShown } from "@/lib/evidence-packs";
import { exportShown } from "@/lib/exports";
import { familyUpdatesShown, isFamilyMember } from "@/lib/family-feed";
import { handoverShown } from "@/lib/handover";
import { peopleLabel, t } from "@/lib/i18n";
import { incidentsNavLabel } from "@/lib/incidents";
import { templatesNavShown } from "@/lib/letters";
import { MANAGE, onboardingShown } from "@/lib/onboarding";
import { retentionShown } from "@/lib/retention";
import { roundShown } from "@/lib/round";
import { searchShown } from "@/lib/search";
import { statementShown } from "@/lib/statement-of-purpose";
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
  // The unread count is a convenience; the shell still renders if it cannot be fetched. Read once
  // per request, shared with the home page's alerts tile.
  const notifications = await readNotifications();
  const unread = notifications.kind === "ok" ? notifications.data.unread : 0;

  // White-label accent (PLAT-002): only a colour that passes every contrast check, both themes.
  const accent = accentStyle(me.tenant.brandAccent);
  const logo = logoSrc(me.tenant.logoDocumentId);

  return (
    <ShellFrame
      user={{ name: me.user.name, email: me.user.email }}
      organisation={{ id: me.tenant.id, name: me.tenant.name }}
      {...(logo ? { brandLogoSrc: logo } : {})}
      memberships={me.memberships}
      // A family member's portal session works at no location: no location switcher.
      locations={(isFamilyMember(me) ? [] : me.locations).map((location) => {
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
        people: me.permissions.includes("people.person.read")
          ? peopleLabel(me.tenant.terminology)
          : undefined,
        search: searchShown(me.permissions) ? t("shell.nav.search") : undefined,
        round: roundShown(me.permissions) ? t("shell.nav.round") : undefined,
        handover: handoverShown(me.permissions) ? t("shell.nav.handover") : undefined,
        incidents: incidentsNavLabel(me.permissions, t),
        downtime: downtimeNavShown(me.permissions) ? t("shell.nav.downtime") : undefined,
        updates: familyUpdatesShown(me.permissions) ? t("shell.nav.updates") : undefined,
        tasks: isFamilyMember(me) ? undefined : t("shell.nav.tasks"),
        documents: isFamilyMember(me) ? undefined : t("shell.nav.documents"),
        letters: templatesNavShown(me.permissions) ? t("shell.nav.letters") : undefined,
        evidencePacks: evidencePacksShown(me.permissions)
          ? t("shell.nav.evidencePacks")
          : undefined,
        statementOfPurpose: statementShown(me.permissions)
          ? t("shell.nav.statementOfPurpose")
          : undefined,
        team: teamShown(me.permissions) ? t("shell.nav.team") : undefined,
        retention: retentionShown(me.permissions) ? t("shell.nav.retention") : undefined,
        dataExport: exportShown(me.permissions) ? t("shell.nav.export") : undefined,
        dataProtection: dpiaShown(me.permissions) ? t("shell.nav.dataProtection") : undefined,
        branding: brandingShown(me.permissions) ? t("shell.nav.branding") : undefined,
        breakGlassReport: breakGlassReportShown(me.permissions)
          ? t("shell.nav.breakGlassReport")
          : undefined,
        onboarding: onboardingShown(me.permissions) ? t("shell.nav.onboarding") : undefined,
        notifications: t("shell.nav.notifications"),
        unreadNotifications: t("shell.nav.unread", { count: unread }),
        settings: t("shell.nav.settings"),
        accountMenu: t("shell.account.menu", { name: me.user.name }),
        security: t("security.title"),
        signOut: t("common.signOut"),
      }}
    >
      {accent ? <style>{accent}</style> : null}
      <OfflineBanner />
      <SampleDataBanner present={me.sampleData} mayManage={me.permissions.includes(MANAGE)} />
      {children}
    </ShellFrame>
  );
}
