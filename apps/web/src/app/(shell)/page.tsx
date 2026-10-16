import type { MessageKey } from "@harbour/i18n";
import { Card, EmptyState, PageHeader, StatusChip, Tile } from "@harbour/ui";
import {
  Activity,
  CalendarDays,
  ClipboardCheck,
  Clock,
  type LucideIcon,
  NotebookPen,
  Pill,
  Repeat,
  TriangleAlert,
  Users,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getShellContext } from "@/lib/api";
import { isFamilyMember } from "@/lib/family-feed";
import { peopleLabel, t } from "@/lib/i18n";

export const metadata: Metadata = { title: t("shell.nav.home") };

interface DashboardTile {
  readonly id: string;
  readonly title: MessageKey;
  readonly description: MessageKey;
  readonly Icon: LucideIcon;
}

const MANAGER_TILES: readonly DashboardTile[] = [
  {
    id: "incidents",
    title: "dashboard.tiles.incidents.title",
    description: "dashboard.tiles.incidents.description",
    Icon: TriangleAlert,
  },
  {
    id: "compliance",
    title: "dashboard.tiles.compliance.title",
    description: "dashboard.tiles.compliance.description",
    Icon: ClipboardCheck,
  },
  {
    id: "staffing",
    title: "dashboard.tiles.staffing.title",
    description: "dashboard.tiles.staffing.description",
    Icon: CalendarDays,
  },
];

const CLINICAL_TILES: readonly DashboardTile[] = [
  {
    id: "medicines",
    title: "dashboard.tiles.medicines.title",
    description: "dashboard.tiles.medicines.description",
    Icon: Pill,
  },
  {
    id: "observations",
    title: "dashboard.tiles.observations.title",
    description: "dashboard.tiles.observations.description",
    Icon: Activity,
  },
];

const CARE_TILES: readonly DashboardTile[] = [
  {
    id: "shift",
    title: "dashboard.tiles.shift.title",
    description: "dashboard.tiles.shift.description",
    Icon: Clock,
  },
  {
    id: "notes",
    title: "dashboard.tiles.notes.title",
    description: "dashboard.tiles.notes.description",
    Icon: NotebookPen,
  },
  {
    id: "handover",
    title: "dashboard.tiles.handover.title",
    description: "dashboard.tiles.handover.description",
    Icon: Repeat,
  },
];

const MANAGER_ROLES = new Set([
  "owner",
  "group_executive",
  "registered_manager",
  "deputy_manager",
  "quality_lead",
]);
const CLINICAL_ROLES = new Set(["clinical_lead"]);
const CARE_ROLES = new Set(["clinical_lead", "team_leader", "care_worker", "agency_worker"]);

/** The tiles for the person's roles, in a stable order without repeats. */
function tilesFor(roleKeys: readonly string[]): DashboardTile[] {
  const tiles: DashboardTile[] = [];
  if (roleKeys.some((r) => MANAGER_ROLES.has(r))) tiles.push(...MANAGER_TILES);
  if (roleKeys.some((r) => CLINICAL_ROLES.has(r))) tiles.push(...CLINICAL_TILES);
  if (roleKeys.some((r) => CARE_ROLES.has(r))) tiles.push(...CARE_TILES);
  return tiles;
}

/** The home dashboard. Empty in Phase 0: each tile says what will appear there. */
export default async function HomePage() {
  const { me, locationId } = await getShellContext();
  // A family member's portal session has no staff dashboard: their home is the updates page.
  if (isFamilyMember(me)) redirect("/updates");
  const location = me.locations.find((l) => l.id === locationId);
  const people = peopleLabel(me.tenant.terminology);
  const tiles = tilesFor(me.roleKeys);

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-8">
      <PageHeader
        eyebrow={
          location
            ? t("dashboard.eyebrow", { organisation: me.tenant.name, location: location.name })
            : me.tenant.name
        }
        title={t("dashboard.welcome", { name: me.user.name })}
        description={t("dashboard.empty.body")}
      />
      <Card>
        <EmptyState
          headingLevel={2}
          title={t("dashboard.empty.title")}
          description={t("dashboard.empty.detail")}
        />
      </Card>
      <section aria-labelledby="your-work" className="flex flex-col gap-4">
        <h2 id="your-work" className="m-0 text-eyebrow">
          {t("dashboard.yourWork")}
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
          <Tile
            headingLevel={3}
            title={people}
            icon={<Users size={24} strokeWidth={1.5} aria-hidden="true" />}
            description={t("dashboard.tiles.people.description")}
            link={{
              href: "/people",
              label: t("dashboard.tiles.people.link", { terminology: me.tenant.terminology }),
            }}
            linkComponent={Link}
          />
          {tiles.map(({ id, title, description, Icon }) => (
            <Tile
              key={id}
              headingLevel={3}
              title={t(title)}
              icon={<Icon size={24} strokeWidth={1.5} aria-hidden="true" />}
              status={<StatusChip status="neutral" label={t("dashboard.empty.title")} />}
              description={t(description)}
              data-tile={id}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
