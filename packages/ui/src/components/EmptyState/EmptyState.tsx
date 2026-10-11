import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../../lib/cx";
import { Heading, type HeadingLevel } from "../../lib/heading";

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  /** Says what is empty in plain words, for example "No care notes yet". */
  title: string;
  /** Says what the person can do next. Never blames the person. */
  description?: ReactNode;
  /** A decorative Lucide icon. */
  icon?: ReactNode;
  action?: ReactNode;
  secondaryAction?: ReactNode;
  headingLevel?: HeadingLevel;
}

/** A calm placeholder for lists, tables and panels that have nothing to show yet. */
export function EmptyState({
  title,
  description,
  icon,
  action,
  secondaryAction,
  headingLevel = 2,
  className,
  ...rest
}: EmptyStateProps) {
  return (
    <div className={cx("hb-empty-state", className)} {...rest}>
      {icon != null ? (
        <span className="hb-empty-state__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <Heading level={headingLevel} className="hb-empty-state__title">
        {title}
      </Heading>
      {description != null ? <p className="hb-empty-state__description">{description}</p> : null}
      {action != null || secondaryAction != null ? (
        <div className="hb-empty-state__actions">
          {action}
          {secondaryAction}
        </div>
      ) : null}
    </div>
  );
}
