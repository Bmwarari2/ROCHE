import { PageHeader, Tile } from "@harbour/ui";
import { Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { DashboardRefresh } from "@/components/insights/DashboardRefresh";
import { SummaryTile } from "@/components/insights/SummaryTile";
import { getShellContext } from "@/lib/api";
import { DASHBOARD_REFRESH_MS, type TileId, type TileSummary } from "@/lib/dashboard";
import { loadDashboard } from "@/lib/dashboard-data";
import { isFamilyMember } from "@/lib/family-feed";
import { formatDateTime } from "@/lib/format";
import { peopleLabel, t } from "@/lib/i18n";

export const metadata: Metadata = { title: t("shell.nav.home") };

/** Today's work first; the rest is safety and oversight (docs/specs/insights.md). */
const TODAY: ReadonlySet<TileId> = new Set(["alerts", "tasks", "handover"]);

function TileGrid({ tiles }: { readonly tiles: readonly TileSummary[] }) {
  return (
    <ul className="m-0 grid list-none grid-cols-1 gap-4 p-0 sm:grid-cols-2 md:grid-cols-3">
      {tiles.map((tile) => (
        <li key={tile.id} className="flex flex-col [&>article]:flex-1">
          <SummaryTile tile={tile} />
        </li>
      ))}
    </ul>
  );
}

/**
 * The home page: the role dashboard (register row INSI-001). Each tile the reader may open says how
 * many things wait in its list, from the API, read in parallel on the server.
 */
export default async function HomePage() {
  const { me, locationId } = await getShellContext();
  // A family member's portal session has no staff dashboard: their home is the updates page.
  if (isFamilyMember(me)) redirect("/updates");
  const location = me.locations.find((l) => l.id === locationId);
  const tiles = await loadDashboard(me, locationId);
  const readAt = new Date();
  const today = tiles.filter((tile) => TODAY.has(tile.id));
  const oversight = tiles.filter((tile) => !TODAY.has(tile.id));
  const people = me.permissions.includes("people.person.read");

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-8">
      <PageHeader
        eyebrow={
          location
            ? t("dashboard.eyebrow", { organisation: me.tenant.name, location: location.name })
            : me.tenant.name
        }
        title={t("dashboard.welcome", { name: me.user.name })}
        description={t("dashboard.description")}
      />
      <p className="m-0 -mt-4 text-body-dense text-text-secondary">
        <time dateTime={readAt.toISOString()}>
          {t("dashboard.asOf", {
            dateTime: formatDateTime(readAt.toISOString()) ?? "",
            minutes: DASHBOARD_REFRESH_MS / 60_000,
          })}
        </time>
      </p>
      <DashboardRefresh readAt={readAt.getTime()} />
      {today.length > 0 ? (
        <section aria-labelledby="dashboard-today" className="flex flex-col gap-4">
          <h2 id="dashboard-today" className="m-0 text-eyebrow">
            {t("dashboard.today")}
          </h2>
          <TileGrid tiles={today} />
        </section>
      ) : null}
      {oversight.length > 0 ? (
        <section aria-labelledby="dashboard-oversight" className="flex flex-col gap-4">
          <h2 id="dashboard-oversight" className="m-0 text-eyebrow">
            {t("dashboard.oversight")}
          </h2>
          <TileGrid tiles={oversight} />
        </section>
      ) : null}
      {people ? (
        <section aria-labelledby="dashboard-work" className="flex flex-col gap-4">
          <h2 id="dashboard-work" className="m-0 text-eyebrow">
            {t("dashboard.yourWork")}
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
            <Tile
              headingLevel={3}
              title={peopleLabel(me.tenant.terminology)}
              icon={<Users size={24} strokeWidth={1.5} aria-hidden="true" />}
              description={t("dashboard.tiles.people.description")}
              link={{
                href: "/people",
                label: t("dashboard.tiles.people.link", { terminology: me.tenant.terminology }),
              }}
              linkComponent={Link}
            />
          </div>
        </section>
      ) : null}
    </div>
  );
}
