"use client";

import {
  CircleAlert,
  FlaskConical,
  History,
  type LucideIcon,
  RefreshCw,
  WifiOff,
} from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../../lib/cx";
import { iconProps } from "../../lib/icon";
import { Button } from "../Button/Button";

export type BannerVariant = "offline" | "syncing" | "syncFailed" | "stale" | "sample";

interface BannerDefaults {
  role: "status" | "alert";
  Icon: LucideIcon;
  title: string;
  description: string;
}

/**
 * Default copy. Offline and syncing are polite status messages. A failed sync and stale data are
 * alerts, because acting on out-of-date care information is a clinical safety hazard.
 */
const bannerDefaults: Record<BannerVariant, BannerDefaults> = {
  offline: {
    role: "status",
    Icon: WifiOff,
    title: "You are offline",
    description:
      "You can keep working. Your changes are kept on this device and sent when you are back online.",
  },
  syncing: {
    role: "status",
    Icon: RefreshCw,
    title: "Sending your changes",
    description: "This usually takes a few seconds.",
  },
  syncFailed: {
    role: "alert",
    Icon: CircleAlert,
    title: "Your changes have not been sent yet",
    description: "Harbour could not reach the server. Your changes are safe on this device.",
  },
  stale: {
    role: "alert",
    Icon: History,
    title: "This information may be out of date",
    description: "Check when it was last updated before you act on it.",
  },
  // Sample data mode (HZ-072): a steady reminder on every screen, so invented people are never
  // taken for real ones. Polite: it is there from the start, not news.
  sample: {
    role: "status",
    Icon: FlaskConical,
    title: "Sample data is in use",
    description: "People marked Sample are invented for practice. Remove them before go-live.",
  },
};

export interface BannerProps extends Omit<HTMLAttributes<HTMLDivElement>, "title" | "role"> {
  variant: BannerVariant;
  /** Replaces the default title. */
  title?: string;
  /** Replaces the default description. */
  description?: ReactNode;
  /** Extra detail, for example "Last updated 03/10/2026 14:32". */
  detail?: ReactNode;
  /** Shows a "Try again" button (used with syncFailed). */
  onRetry?: () => void;
  retryLabel?: string;
  /** Disables the retry button while a retry runs. */
  retrying?: boolean;
  /** Any other action, such as a link to the sync log. */
  action?: ReactNode;
}

/**
 * Full-width message for offline and sync state, and for sample data. Every state has an icon and
 * words.
 */
export function Banner({
  variant,
  title,
  description,
  detail,
  onRetry,
  retryLabel = "Try again",
  retrying = false,
  action,
  className,
  ...rest
}: BannerProps) {
  const defaults = bannerDefaults[variant];
  const { Icon } = defaults;
  return (
    <div
      role={defaults.role}
      className={cx("hb-banner", `hb-banner--${variant}`, className)}
      data-variant={variant}
      {...rest}
    >
      <span className="hb-banner__icon" aria-hidden="true">
        <Icon {...iconProps} size={20} />
      </span>
      <div className="hb-banner__text">
        <p className="hb-banner__title">{title ?? defaults.title}</p>
        <p className="hb-banner__description">{description ?? defaults.description}</p>
        {detail != null ? <p className="hb-banner__detail">{detail}</p> : null}
      </div>
      {onRetry || action != null ? (
        <div className="hb-banner__actions">
          {onRetry ? (
            <Button
              variant="secondary"
              onClick={onRetry}
              disabled={retrying}
              icon={<RefreshCw {...iconProps} size={16} />}
            >
              {retrying ? "Trying again" : retryLabel}
            </Button>
          ) : null}
          {action}
        </div>
      ) : null}
    </div>
  );
}
