import {
  Circle,
  CircleAlert,
  CircleCheck,
  CircleHelp,
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
  "circle-help": CircleHelp,
  "circle-minus": CircleMinus,
};

export type StatusChipStatus = ClinicalStatus | "neutral" | "info";

interface StatusChipBaseProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  className?: string;
  /**
   * A Lucide icon that replaces the default one, for states that need their own symbol, such as
   * a care plan "Draft" (a pencil) or "Superseded" (a clock turned back). Always shown beside the
   * word.
   */
  icon?: LucideIcon;
  /**
   * Makes the chip a link to the action that resolves it, for example "Not recorded" linking to
   * where the allergies are recorded. Only a path on this site ("/people/..."), never another site
   * or a script: anything else leaves the chip as plain status.
   */
  href?: string;
  /**
   * With `href`: what following the link does, read after the words so the link makes sense on
   * its own (WCAG 2.4.4), for example "record them" for "Allergies not recorded: record them".
   * Hidden on screen, where the context shows it.
   */
  actionLabel?: string;
}

interface ClinicalStatusChipProps extends StatusChipBaseProps {
  /**
   * overdue, due, done, notApplicable or notRecorded: fixed colours, icon and default word from
   * the tokens.
   */
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
/**
 * A path on this site: starts with one slash, never two (another host) or a backslash, and holds
 * only the characters of a plain path and query (no spaces or control characters).
 */
export function isSameSitePath(href: string): boolean {
  return /^\/(?![/\\])[A-Za-z0-9\-._~/?#[\]@!$&'()*+,;=%:]*$/.test(href);
}

export function StatusChip({
  status,
  label,
  icon,
  href,
  actionLabel,
  className,
  ...rest
}: StatusChipProps) {
  const content = chipContent(status, label);
  const Icon = icon ?? content.Icon;
  const { text } = content;
  const children = (
    <>
      <Icon {...iconProps} className="hb-status-chip__icon" size={14} />
      <span className="hb-status-chip__label">{text}</span>
    </>
  );
  const classes = cx("hb-status-chip", `hb-status-chip--${status}`, className);
  if (href && isSameSitePath(href)) {
    return (
      <a
        href={href}
        className={classes}
        data-status={status}
        {...(rest as HTMLAttributes<HTMLAnchorElement>)}
      >
        {children}
        {actionLabel ? <span className="hb-visually-hidden">: {actionLabel}</span> : null}
      </a>
    );
  }
  return (
    <span className={classes} data-status={status} {...rest}>
      {children}
    </span>
  );
}
