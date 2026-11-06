import type { MessageKey } from "@harbour/i18n";
import { Tile } from "@harbour/ui";
import {
  Bell,
  ClipboardList,
  KeyRound,
  ListChecks,
  type LucideIcon,
  Repeat,
  Scale,
  Send,
  TriangleAlert,
  Unplug,
} from "lucide-react";
import Link from "next/link";
import { SafetyChip } from "@/components/safety/SafetyChip";
import { apartLine, countLine, type TileId, type TileSummary, tileChips } from "@/lib/dashboard";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";

const ICONS: Record<TileId, LucideIcon> = {
  alerts: Bell,
  tasks: ListChecks,
  handover: Repeat,
  dols: Scale,
  reviews: ClipboardList,
  incidents: TriangleAlert,
  notifications: Send,
  outages: Unplug,
  breakGlass: KeyRound,
};

/**
 * One dashboard tile (docs/specs/insights.md): the count in words, the state as an icon and a
 * word, the part said apart, and a link to the list it summarises.
 */
export function SummaryTile({ tile }: { readonly tile: TileSummary }) {
  const Icon = ICONS[tile.id];
  const apart = apartLine(tile, t);
  const details: string[] = [];
  if (apart) details.push(apart);
  if (tile.id === "handover" && tile.state === "notKnown") {
    details.push(t("dashboard.tile.handover.notKnown"));
  }
  if (tile.current) details.push(t("dashboard.tile.handover.current", { state: tile.current }));
  const earliest = formatDateTime(tile.earliestDue);
  if (earliest) {
    // A "without delay" notification in the law's words, as on the incident page (H-410).
    details.push(
      tile.earliestWithoutDelay
        ? t("dashboard.tile.notifications.earliestWithoutDelay", { dateTime: earliest })
        : t("dashboard.tile.notifications.earliest", { dateTime: earliest }),
    );
  }
  if (tile.id === "dols" && tile.count !== null) details.push(t("dashboard.tile.dols.description"));
  return (
    <Tile
      headingLevel={3}
      title={t(`dashboard.tile.${tile.id}.title` satisfies MessageKey)}
      icon={<Icon size={24} strokeWidth={1.5} aria-hidden="true" />}
      link={{ href: tile.href, label: t(`dashboard.tile.${tile.id}.link` satisfies MessageKey) }}
      linkComponent={Link}
      data-tile={tile.id}
      data-state={tile.state}
    >
      <p className="m-0 font-semibold text-body">{countLine(tile, t)}</p>
      <div className="flex flex-wrap gap-1.5">
        {tileChips(tile, t).map((chip) => (
          <SafetyChip key={chip.label} chip={chip} />
        ))}
      </div>
      {details.map((line) => (
        <p key={line} className="m-0 text-body-dense text-text-secondary">
          {line}
        </p>
      ))}
    </Tile>
  );
}
