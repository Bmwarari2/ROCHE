import { EmptyState, PageHeader, StatusChip } from "@harbour/ui";
import {
  CircleAlert,
  CircleCheck,
  CircleMinus,
  Clock,
  FilePen,
  Lock,
  type LucideIcon,
  Search,
  Send,
  TriangleAlert,
} from "lucide-react";
import { t } from "@/lib/i18n";
import type { SafetyChip as Chip, SafetyIcon } from "@/lib/incidents";

const ICONS: Record<SafetyIcon, LucideIcon> = {
  "circle-alert": CircleAlert,
  clock: Clock,
  "circle-check": CircleCheck,
  "circle-minus": CircleMinus,
  search: Search,
  "triangle-alert": TriangleAlert,
  "file-pen": FilePen,
  send: Send,
};

/** A status from the incident screens: an icon and a word, never colour alone. */
export function SafetyChip({ chip }: { readonly chip: Chip }) {
  return <StatusChip status={chip.status} label={chip.label} icon={ICONS[chip.icon]} />;
}

/** A page the viewer may not open: says so in words, and who can act when that is known. */
export function SafetyForbidden({
  title,
  hint = null,
}: {
  readonly title: string;
  readonly hint?: string | null;
}) {
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-8">
      <PageHeader title={title} />
      <EmptyState
        icon={<Lock size={32} strokeWidth={1.5} aria-hidden="true" />}
        title={t("errors.forbidden")}
        {...(hint ? { description: hint } : {})}
      />
    </div>
  );
}
