import {
  Circle,
  CircleAlert,
  CircleCheck,
  CircleMinus,
  Clock,
  Info,
  type LucideIcon,
} from "lucide-react";
import type { HTMLAttributes } from "react";
import { cx } from "../../lib/cx";
import { iconProps } from "../../lib/icon";
import { type ClinicalStatus, clinicalStatus } from "../../tokens/tokens";

type ClinicalIconName = (typeof clinicalStatus)[ClinicalStatus]["icon"];

/** Lucide components for the icon names in the token file, so the tokens stay the single source. */
const clinicalIcons: Record<ClinicalIconName, LucideIcon> = {
  "circle-alert": CircleAlert,
  clock: Clock,
  "circle-check": CircleCheck,
  "circle-minus": CircleMinus,
};

export type StatusChipStatus = ClinicalStatus | "neutral" | "info";

interface StatusChipBaseProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  className?: string;
}

interface ClinicalStatusChipProps extends StatusChipBaseProps {
  /** overdue, due, done or notApplicable: fixed colours, icon and default word from the tokens. */
  status: ClinicalStatus;
  /** Replaces the default word, for example "Due 14:00". */
  label?: string;
}

interface GeneralStatusChipProps extends StatusChipBaseProps {
  /** neutral or info: for non-clinical states such as "Draft" or "New". */
  status: "neutral" | "info";
  /** The word to show. Required because these states have no default. */
  label: string;
}

export type StatusChipProps = ClinicalStatusChipProps | GeneralStatusChipProps;

const generalFallback: Record<"neutral" | "info", string> = {
  neutral: "Status",
  info: "Information",
};

function chipContent(status: StatusChipStatus, label: string | undefined) {
  const custom = label?.trim();
  if (status === "neutral" || status === "info") {
    return { Icon: status === "info" ? Info : Circle, text: custom || generalFallback[status] };
  }
  const token = clinicalStatus[status];
  return { Icon: clinicalIcons[token.icon], text: custom || token.label };
}

/**
 * Status shown as an icon plus a word, never colour alone. Clinical statuses are filled with their
 * fixed colour and white text in both themes.
 */
export function StatusChip({ status, label, className, ...rest }: StatusChipProps) {
  const { Icon, text } = chipContent(status, label);
  return (
    <span
      className={cx("hb-status-chip", `hb-status-chip--${status}`, className)}
      data-status={status}
      {...rest}
    >
      <Icon {...iconProps} className="hb-status-chip__icon" size={14} />
      <span className="hb-status-chip__label">{text}</span>
    </span>
  );
}
