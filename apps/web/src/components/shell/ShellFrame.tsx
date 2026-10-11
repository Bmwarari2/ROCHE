"use client";

import {
  AppBar,
  type AppBarSwitcher,
  Sidebar,
  type SidebarItem,
  type SwitcherOption,
} from "@harbour/ui";
import { Bell, House, ShieldCheck, Users } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState, useTransition } from "react";
import { switchLocation, switchOrganisation } from "@/app/actions/context";
import { AccountMenu } from "./AccountMenu";

const icon = { size: 20, strokeWidth: 1.5, "aria-hidden": true } as const;

/** Value used in the location switcher for "All locations". Never a valid location id. */
const ALL_LOCATIONS = "all";

export interface ShellFrameProps {
  readonly user: { readonly name: string; readonly email: string };
  readonly organisation: { readonly id: string; readonly name: string };
  readonly memberships: readonly { readonly tenantId: string; readonly tenantName: string }[];
  readonly locations: readonly {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
  }[];
  readonly locationId: string | null;
  readonly labels: {
    readonly organisation: string;
    readonly location: string;
    readonly allLocations: string;
    readonly home: string;
    readonly people: string;
    readonly notifications: string;
    readonly settings: string;
    readonly signOut: string;
  };
  readonly unreadNotifications: number;
  readonly children: ReactNode;
}

function currentSection(pathname: string): string {
  if (pathname.startsWith("/people")) return "people";
  if (pathname.startsWith("/notifications")) return "notifications";
  if (pathname.startsWith("/settings")) return "settings";
  return "home";
}

/**
 * The product shell (section 8): the 44 px app bar with the organisation and location switchers
 * and the account menu, the module sidebar, and the main landmark.
 */
export function ShellFrame({
  user,
  organisation,
  memberships,
  locations,
  locationId,
  labels,
  unreadNotifications,
  children,
}: ShellFrameProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [collapsed, setCollapsed] = useState(false);

  // Icons only on phones, so the content keeps the width (the labels stay as tooltips).
  useEffect(() => {
    const query = window.matchMedia("(max-width: 734px)");
    setCollapsed(query.matches);
  }, []);

  const tenantSwitcher: AppBarSwitcher = {
    label: labels.organisation,
    options: memberships.map((m) => ({ id: m.tenantId, label: m.tenantName })),
    value: organisation.id,
    onValueChange: (id) => {
      if (id === organisation.id) return;
      startTransition(async () => {
        const result = await switchOrganisation(id);
        if (result.ok) {
          router.push("/");
          router.refresh();
        }
      });
    },
  };

  const locationOptions: SwitcherOption[] = [
    ...(locations.length > 1 ? [{ id: ALL_LOCATIONS, label: labels.allLocations }] : []),
    ...locations.map((l) => ({
      id: l.id,
      label: l.name,
      ...(l.description ? { description: l.description } : {}),
    })),
  ];

  const locationSwitcher: AppBarSwitcher | undefined =
    locations.length > 0
      ? {
          label: labels.location,
          options: locationOptions,
          value: locationId ?? (locations.length > 1 ? ALL_LOCATIONS : (locations[0]?.id ?? "")),
          onValueChange: (id) => {
            startTransition(async () => {
              const result = await switchLocation(id === ALL_LOCATIONS ? null : id);
              if (result.ok) router.refresh();
            });
          },
        }
      : undefined;

  const items: SidebarItem[] = [
    { id: "home", label: labels.home, href: "/", icon: <House {...icon} /> },
    { id: "people", label: labels.people, href: "/people", icon: <Users {...icon} /> },
    {
      id: "notifications",
      label: labels.notifications,
      href: "/notifications",
      icon: <Bell {...icon} />,
      ...(unreadNotifications > 0
        ? { badge: String(unreadNotifications), badgeLabel: `${unreadNotifications} unread` }
        : {}),
    },
    {
      id: "settings",
      label: labels.settings,
      href: "/settings/security",
      icon: <ShieldCheck {...icon} />,
    },
  ];

  return (
    <div className="flex min-h-dvh flex-col bg-bg-secondary">
      <AppBar
        tenant={tenantSwitcher}
        {...(locationSwitcher ? { location: locationSwitcher } : {})}
        linkComponent={Link}
        actions={
          <AccountMenu
            user={user}
            organisationName={organisation.name}
            signOutLabel={labels.signOut}
          />
        }
      />
      <div className="flex flex-1">
        <div className="sticky top-nav h-[calc(100dvh-var(--nav-height))] shrink-0 self-start">
          <Sidebar
            items={items}
            currentId={currentSection(pathname)}
            collapsed={collapsed}
            onCollapsedChange={setCollapsed}
            linkComponent={Link}
          />
        </div>
        <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 p-shell max-sm:p-4">
          {children}
        </main>
      </div>
    </div>
  );
}
