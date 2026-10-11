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
import { getShellContext } from "@/lib/api";
import { peopleLabel, t } from "@/lib/i18n";

export const metadata: Metadata = { title: "Home" };

interface DashboardTile {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly Icon: LucideIcon;
}

const MANAGER_TILES: readonly DashboardTile[] = [
  {
    id: "incidents",
    title: "Incidents to review",
    description: "Incidents reported by your team will appear here for review and sign-off.",
    Icon: TriangleAlert,
  },
  {
    id: "compliance",
    title: "Compliance",
    description: "Training, supervision and audit due dates will appear here.",
    Icon: ClipboardCheck,
  },
  {
    id: "staffing",
    title: "Staffing today",
    description: "Who is on shift, and any gaps in the rota, will appear here.",
    Icon: CalendarDays,
  },
];

const CLINICAL_TILES: readonly DashboardTile[] = [
  {
    id: "medicines",
    title: "Medicines due",
    description: "Medicines due on the current round will appear here.",
    Icon: Pill,
  },
  {
    id: "observations",
    title: "Observations",
    description: "Observations to take and any that need escalation will appear here.",
    Icon: Activity,
  },
];

const CARE_TILES: readonly DashboardTile[] = [
  {
    id: "shift",
    title: "Your shift",
    description: "Your shift times and the people you support today will appear here.",
    Icon: Clock,
  },
  {
    id: "notes",
    title: "Care notes due",
    description: "Notes and charts to complete on this shift will appear here.",
    Icon: NotebookPen,
  },
  {
    id: "handover",
    title: "Handover",
    description: "The handover from the last shift will appear here.",
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
  const location = me.locations.find((l) => l.id === locationId);
  const people = peopleLabel(me.tenant.terminology);
  const tiles = tilesFor(me.roleKeys);

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-8">
      <PageHeader
        eyebrow={location ? `${me.tenant.name}, ${location.name}` : me.tenant.name}
        title={`Welcome, ${me.user.name}`}
        description={t("dashboard.empty.body")}
      />
      <Card>
        <EmptyState
          headingLevel={2}
          title={t("dashboard.empty.title")}
          description="Today's tasks, alerts and messages for your team will show here as Harbour is set up."
        />
      </Card>
      <section aria-labelledby="your-work" className="flex flex-col gap-4">
        <h2 id="your-work" className="m-0 text-eyebrow">
          Your work
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
          <Tile
            headingLevel={3}
            title={people}
            icon={<Users size={24} strokeWidth={1.5} aria-hidden="true" />}
            description="The people in your care, with their allergies and communication needs."
            link={{ href: "/people", label: `View ${people.toLocaleLowerCase("en-GB")}` }}
            linkComponent={Link}
          />
          {tiles.map(({ id, title, description, Icon }) => (
            <Tile
              key={id}
              headingLevel={3}
              title={title}
              icon={<Icon size={24} strokeWidth={1.5} aria-hidden="true" />}
              status={<StatusChip status="neutral" label={t("dashboard.empty.title")} />}
              description={description}
              data-tile={id}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
