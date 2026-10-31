import { StatusChip } from "@harbour/ui";
import {
  CircleAlert,
  CircleCheck,
  CircleMinus,
  Clock,
  EyeOff,
  FilePen,
  Link2,
  Lock,
  type LucideIcon,
  PenLine,
  Send,
} from "lucide-react";
import type { QualityChip as Chip, QualityIcon } from "@/lib/evidence-packs";

const ICONS: Record<QualityIcon, LucideIcon> = {
  "file-pen": FilePen,
  send: Send,
  "circle-minus": CircleMinus,
  "circle-check": CircleCheck,
  "eye-off": EyeOff,
  "pen-line": PenLine,
  clock: Clock,
  "circle-alert": CircleAlert,
  lock: Lock,
  link: Link2,
};

/** A status on the quality screens: an icon and a word, never colour alone. */
export function QualityChip({ chip }: { readonly chip: Chip }) {
  return <StatusChip status={chip.status} label={chip.label} icon={ICONS[chip.icon]} />;
}
