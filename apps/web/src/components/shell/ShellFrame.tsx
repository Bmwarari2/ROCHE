"use client";

import {
  AccountMenu,
  type AccountMenuItem,
  AppBar,
  type AppBarSwitcher,
  Sidebar,
  type SidebarItem,
  type SwitcherOption,
} from "@harbour/ui";
import {
  Bell,
  ClipboardList,
  CloudOff,
  House,
  LogOut,
  ShieldCheck,
  TriangleAlert,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState, useTransition } from "react";
import { switchLocation, switchOrganisation } from "@/app/actions/context";
import { signOutAndForget } from "@/lib/sign-out";

const icon = { size: 20, strokeWidth: 1.5, "aria-hidden": true } as const;
const menuIcon = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;

/** Value used in the location switcher for "All locations". Never a valid location id. */
const ALL_LOCATIONS = "all";

export interface ShellFrameLabels {
  readonly skipLink: string;
  readonly organisation: string;
  readonly organisationMenu: string;
  readonly location: string;
  readonly locationMenu: string;
  readonly allLocations: string;
  readonly navigation: string;
  readonly home: string;
  readonly people: string;
  /** Shown only to people who take part in the shift handover (care.handover.manage). */
  readonly handover?: string | undefined;
  /** Shown only to people who may read incidents (safety.incident.read). */
  readonly incidents?: string | undefined;
  /** Shown only to people who open the downtime pack or manage outages. */
  readonly downtime?: string | undefined;
  readonly notifications: string;
  /** Accessible text for the unread badge, for example "3 unread". */
  readonly unreadNotifications: string;
  readonly settings: string;
  /** Accessible name of the account menu button, for example "Your account: Ada Example". */
  readonly accountMenu: string;
  readonly security: string;
  readonly signOut: string;
}

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
  readonly labels: ShellFrameLabels;
  readonly unreadNotifications: number;
  readonly children: ReactNode;
}

function currentSection(pathname: string): string {
  if (pathname.startsWith("/people")) return "people";
  if (pathname.startsWith("/handover")) return "handover";
  // Statutory notifications belong with incidents, never the notification centre.
  if (pathname.startsWith("/incidents") || /^\/notifications\/statutory(\/|$)/.test(pathname)) {
    return "incidents";
  }
  if (pathname.startsWith("/notifications")) return "notifications";
  if (pathname.startsWith("/downtime")) return "downtime";
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
  // Null until the browser has said whether this is a phone: the sidebar then collapses by CSS on a
  // narrow screen, so the first paint never lays out the full-width sidebar there.
  const [collapsed, setCollapsed] = useState<boolean | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  // Icons only on phones, so the content keeps the width (the labels stay as tooltips).
  useEffect(() => {
    const query = window.matchMedia("(max-width: 734px)");
    setCollapsed(query.matches);
  }, []);

  const tenantSwitcher: AppBarSwitcher = {
    label: labels.organisation,
    menuLabel: labels.organisationMenu,
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
  const locationValue =
    locationId ?? (locations.length > 1 ? ALL_LOCATIONS : (locations[0]?.id ?? ""));

  const locationSwitcher: AppBarSwitcher | undefined =
    locations.length > 0
      ? {
          label: labels.location,
          menuLabel: labels.locationMenu,
          options: locationOptions,
          value: locationValue,
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
    ...(labels.handover
      ? [
          {
            id: "handover",
            label: labels.handover,
            href: "/handover",
            icon: <ClipboardList {...icon} />,
          },
        ]
      : []),
    ...(labels.incidents
      ? [
          {
            id: "incidents",
            label: labels.incidents,
            href: "/incidents",
            icon: <TriangleAlert {...icon} />,
          },
        ]
      : []),
    ...(labels.downtime
      ? [
          {
            id: "downtime",
            label: labels.downtime,
            href: "/downtime",
            icon: <CloudOff {...icon} />,
          },
        ]
      : []),
    {
      id: "notifications",
      label: labels.notifications,
      href: "/notifications",
      icon: <Bell {...icon} />,
      ...(unreadNotifications > 0
        ? { badge: String(unreadNotifications), badgeLabel: labels.unreadNotifications }
        : {}),
    },
    {
      id: "settings",
      label: labels.settings,
      href: "/settings/security",
      icon: <ShieldCheck {...icon} />,
    },
  ];

  const accountItems: AccountMenuItem[] = [
    {
      id: "security",
      label: labels.security,
      href: "/settings/security",
      icon: <ShieldCheck {...menuIcon} />,
    },
    {
      id: "sign-out",
      label: labels.signOut,
      icon: <LogOut {...menuIcon} />,
      disabled: signingOut,
      onSelect: (event) => {
        // Keep the menu open, with the item disabled, while signing out.
        event.preventDefault();
        setSigningOut(true);
        void signOutAndForget();
      },
    },
  ];

  return (
    <div className="flex min-h-dvh flex-col bg-bg-secondary">
      <AppBar
        tenant={tenantSwitcher}
        {...(locationSwitcher ? { location: locationSwitcher } : {})}
        skipLinkLabel={labels.skipLink}
        linkComponent={Link}
        actions={
          <AccountMenu
            userName={user.name}
            userDetail={user.email}
            organisationName={organisation.name}
            locationName={locationOptions.find((option) => option.id === locationValue)?.label}
            organisationLabel={labels.organisation}
            locationLabel={labels.location}
            triggerLabel={labels.accountMenu}
            items={accountItems}
            linkComponent={Link}
          />
        }
      />
      <div className="flex flex-1">
        <div className="sticky top-nav h-[calc(100dvh-var(--nav-height))] shrink-0 self-start">
          <Sidebar
            items={items}
            currentId={currentSection(pathname)}
            label={labels.navigation}
            collapsed={collapsed ?? false}
            onCollapsedChange={setCollapsed}
            {...(collapsed === null ? { className: "hb-sidebar--narrow-auto" } : {})}
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
