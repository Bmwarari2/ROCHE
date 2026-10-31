import type { PersonStatus } from "@harbour/contracts";
import { StatusChip } from "@harbour/ui";
import {
  Archive,
  CircleCheck,
  CircleHelp,
  CircleX,
  ClipboardList,
  DoorOpen,
  Hospital,
  House,
  Inbox,
  ListChecks,
  type LucideIcon,
  Luggage,
  Package,
  ShieldAlert,
  Trash2,
  Undo2,
} from "lucide-react";
import { decisionChip, personStatusChip, propertyChip, type StatusIcon } from "@/lib/admission";
import { t } from "@/lib/i18n";

/**
 * Status chips for the admission and property screens: an icon and a word, never colour alone
 * (WCAG 1.4.1). Server-safe: no state.
 */

const STATUS_ICONS: Record<StatusIcon, LucideIcon> = {
  inbox: Inbox,
  "clipboard-list": ClipboardList,
  "circle-x": CircleX,
  house: House,
  "door-open": DoorOpen,
  hospital: Hospital,
  archive: Archive,
};

export function PersonStatusChip({ status }: { readonly status: PersonStatus }) {
  const chip = personStatusChip(status);
  const label = t("people.status.label", { status });
  return <StatusChip status={chip.status} label={label} icon={STATUS_ICONS[chip.icon]} />;
}

const DECISION_ICONS = {
  "circle-check": CircleCheck,
  "list-checks": ListChecks,
  "circle-x": CircleX,
};

export function DecisionChip({
  canMeetNeeds,
}: {
  readonly canMeetNeeds: "yes" | "yes_with_conditions" | "no";
}) {
  const chip = decisionChip(canMeetNeeds);
  const label = t("people.decision.answer", { answer: canMeetNeeds });
  const icon = DECISION_ICONS[chip.icon];
  return <StatusChip status={chip.status} label={label} icon={icon} />;
}

const PROPERTY_ICONS = {
  package: Package,
  luggage: Luggage,
  "undo-2": Undo2,
  "trash-2": Trash2,
  "circle-help": CircleHelp,
};

export function PropertyStatusChip({
  status,
}: {
  readonly status: "held" | "sent_with_person" | "returned" | "disposed" | "lost";
}) {
  const chip = propertyChip(status);
  const label = t("people.property.status", { status });
  const icon = PROPERTY_ICONS[chip.icon];
  return <StatusChip status={chip.status} label={label} icon={icon} />;
}

/** A safety-critical item or section: said in words beside a shield, never by colour. */
export function SafetyCriticalChip() {
  return <StatusChip status="neutral" label={t("people.safetyCritical")} icon={ShieldAlert} />;
}
