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
  Archive,
  Bell,
  ClipboardCheck,
  ClipboardList,
  CloudOff,
  FileLock,
  FileText,
  FolderLock,
  House,
  ListChecks,
  ListTodo,
  Lock,
  LogOut,
  Mail,
  Newspaper,
  Palette,
  ScrollText,
  Search,
  ShieldAlert,
  ShieldCheck,
  Stamp,
  TriangleAlert,
  UserPlus,
  UserRoundCheck,
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
  /** Shown only to people who may read the people list (people.person.read). */
  readonly people?: string | undefined;
  /** Shown only to people who read care plans (care.plan.read), whose round it is. */
  readonly round?: string | undefined;
  /** Shown only to people who take part in the shift handover (care.handover.manage). */
  readonly handover?: string | undefined;
  /** Shown only to people who may read incidents (safety.incident.read). */
  readonly incidents?: string | undefined;
  /** Shown only to people who take a step in a listed workflow (PLAT-011 approvals). */
  readonly approvals?: string | undefined;
  /** Shown only to people who open the downtime pack or manage outages. */
  readonly downtime?: string | undefined;
  /** Shown only to people who check in alone, watch lone workers or name the on-call route. */
  readonly loneWorking?: string | undefined;
  /** Shown only in a family member's portal session (comms.feed.read). */
  readonly updates?: string | undefined;
  /** Shown only to people who may search (platform.search.use). */
  readonly search?: string | undefined;
  /** Shown only to people who write, approve or send from letter templates. */
  readonly letters?: string | undefined;
  /** Shown only to holders of quality.evidence_pack.compose or .release (QUAL-003). */
  readonly evidencePacks?: string | undefined;
  /** Shown only to those who write, approve or send the statement of purpose (QUAL-009). */
  readonly statementOfPurpose?: string | undefined;
  /** Shown only to people who invite and manage staff (platform.user.manage). */
  readonly team?: string | undefined;
  /** Shown to staff (not family portal sessions): their tasks and the team's (PLAT-011). */
  readonly tasks?: string | undefined;
  /** Shown to staff: the organisation's documents (PLAT-009). */
  readonly documents?: string | undefined;
  /** Shown only to people who manage records retention (platform.retention.manage). */
  readonly retention?: string | undefined;
  /** Shown only to people who may export the organisation's data (platform.export.create). */
  readonly dataExport?: string | undefined;
  readonly dataProtection?: string | undefined;
  /** The branding settings (PLAT-002), for platform.tenant.manage. */
  readonly branding?: string | undefined;
  /** Shown only to people who read the weekly break-glass report (platform.audit.read). */
  readonly breakGlassReport?: string | undefined;
  readonly onboarding?: string | undefined;
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
  /** The organisation's white-label logo, through the web tier (PLAT-002). */
  readonly brandLogoSrc?: string;
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
  if (pathname.startsWith("/round")) return "round";
  // Statutory notifications belong with incidents, never the notification centre.
  if (pathname.startsWith("/incidents") || /^\/notifications\/statutory(\/|$)/.test(pathname)) {
    return "incidents";
  }
  if (pathname.startsWith("/notifications")) return "notifications";
  if (pathname.startsWith("/downtime")) return "downtime";
  if (pathname.startsWith("/lone-working")) return "loneWorking";
  if (pathname.startsWith("/approvals")) return "approvals";
  if (pathname.startsWith("/letters")) return "letters";
  if (pathname.startsWith("/tasks")) return "tasks";
  if (pathname.startsWith("/documents")) return "documents";
  if (pathname.startsWith("/search")) return "search";
  if (pathname.startsWith("/updates")) return "updates";
  if (pathname.startsWith("/settings/team")) return "team";
  if (pathname.startsWith("/settings/export")) return "export";
  if (pathname.startsWith("/settings/retention")) return "retention";
  if (pathname.startsWith("/settings/data-protection")) return "data-protection";
  if (pathname.startsWith("/settings/onboarding")) return "onboarding";
  if (pathname.startsWith("/settings/branding")) return "branding";
  if (pathname.startsWith("/break-glass")) return "break-glass";
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
  brandLogoSrc,
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
    // The active organisation by its display name (PLAT-002); the others by the name listed.
    options: memberships.map((m) => ({
      id: m.tenantId,
      label: m.tenantId === organisation.id ? organisation.name : m.tenantName,
    })),
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
    ...(labels.people
      ? [{ id: "people", label: labels.people, href: "/people", icon: <Users {...icon} /> }]
      : []),
    ...(labels.search
      ? [{ id: "search", label: labels.search, href: "/search", icon: <Search {...icon} /> }]
      : []),
    ...(labels.round
      ? [{ id: "round", label: labels.round, href: "/round", icon: <ListChecks {...icon} /> }]
      : []),
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
    ...(labels.approvals
      ? [
          {
            id: "approvals",
            label: labels.approvals,
            href: "/approvals",
            icon: <Stamp {...icon} />,
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
    ...(labels.loneWorking
      ? [
          {
            id: "loneWorking",
            label: labels.loneWorking,
            href: "/lone-working",
            icon: <UserRoundCheck {...icon} />,
          },
        ]
      : []),
    ...(labels.updates
      ? [{ id: "updates", label: labels.updates, href: "/updates", icon: <Newspaper {...icon} /> }]
      : []),
    ...(labels.tasks
      ? [{ id: "tasks", label: labels.tasks, href: "/tasks", icon: <ClipboardCheck {...icon} /> }]
      : []),
    ...(labels.documents
      ? [
          {
            id: "documents",
            label: labels.documents,
            href: "/documents",
            icon: <FileText {...icon} />,
          },
        ]
      : []),
    ...(labels.letters
      ? [{ id: "letters", label: labels.letters, href: "/letters", icon: <Mail {...icon} /> }]
      : []),
    ...(labels.evidencePacks
      ? [
          {
            id: "evidence-packs",
            label: labels.evidencePacks,
            href: "/quality/evidence-packs",
            icon: <FolderLock {...icon} />,
          },
        ]
      : []),
    ...(labels.statementOfPurpose
      ? [
          {
            id: "statement-of-purpose",
            label: labels.statementOfPurpose,
            href: "/quality/statement-of-purpose",
            icon: <ScrollText {...icon} />,
          },
        ]
      : []),
    ...(labels.team
      ? [
          {
            id: "team",
            label: labels.team,
            href: "/settings/team",
            icon: <UserPlus {...icon} />,
          },
        ]
      : []),
    ...(labels.dataExport
      ? [
          {
            id: "export",
            label: labels.dataExport,
            href: "/settings/export",
            icon: <Archive {...icon} />,
          },
        ]
      : []),
    ...(labels.retention
      ? [
          {
            id: "retention",
            label: labels.retention,
            href: "/settings/retention",
            icon: <Lock {...icon} />,
          },
        ]
      : []),
    ...(labels.onboarding
      ? [
          {
            id: "onboarding",
            label: labels.onboarding,
            href: "/settings/onboarding",
            icon: <ListTodo {...icon} />,
          },
        ]
      : []),
    ...(labels.dataProtection
      ? [
          {
            id: "data-protection",
            label: labels.dataProtection,
            href: "/settings/data-protection",
            icon: <FileLock {...icon} />,
          },
        ]
      : []),
    ...(labels.branding
      ? [
          {
            id: "branding",
            label: labels.branding,
            href: "/settings/branding",
            icon: <Palette {...icon} />,
          },
        ]
      : []),
    ...(labels.breakGlassReport
      ? [
          {
            id: "break-glass",
            label: labels.breakGlassReport,
            href: "/break-glass/weekly-report",
            icon: <ShieldAlert {...icon} />,
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
        {...(brandLogoSrc ? { brandLogoSrc } : {})}
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
