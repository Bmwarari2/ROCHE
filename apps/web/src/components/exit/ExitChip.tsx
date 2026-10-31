import type { PersonStatus } from "@harbour/contracts";
import { StatusChip } from "@harbour/ui";
import {
  Archive,
  CircleCheck,
  CircleMinus,
  Clock,
  DoorOpen,
  Flag,
  Flower2,
  type LucideIcon,
  X,
} from "lucide-react";
import { type ChipView, personStatusChip } from "@/lib/exit";
import { t } from "@/lib/i18n";

const ICONS: Record<ChipView["icon"], LucideIcon> = {
  "circle-check": CircleCheck,
  clock: Clock,
  "circle-minus": CircleMinus,
  archive: Archive,
  "door-open": DoorOpen,
  flag: Flag,
  flower: Flower2,
  x: X,
};

/** A chip from `exitStateChip`, `itemChip` or `personStatusChip`: an icon and a word. */
export function ExitChip({ chip }: { readonly chip: ChipView }) {
  return <StatusChip status={chip.status} label={chip.label} icon={ICONS[chip.icon]} />;
}

/**
 * The person's status beside their name wherever they are named (people list, record header,
 * search): "Archived", "Died", "Left the service", "In hospital" as an icon and a word, so a
 * record that is closed or read-only is never taken for a live one (HZ-001). Nothing for someone
 * receiving care as usual.
 */
export function PersonStatusBadge({
  status,
  always = false,
}: {
  readonly status: PersonStatus;
  /** Say "Receiving care" too (search results, where every status is said). */
  readonly always?: boolean;
}) {
  const chip = personStatusChip(status, t);
  if (!chip) {
    return always ? (
      <StatusChip status="neutral" label={t("platform.search.status", { status })} />
    ) : null;
  }
  return (
    <span data-person-status={status} className="inline-flex">
      <ExitChip chip={chip} />
    </span>
  );
}
