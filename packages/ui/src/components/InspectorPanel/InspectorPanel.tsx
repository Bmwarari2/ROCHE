"use client";

import { X } from "lucide-react";
import { type HTMLAttributes, type ReactNode, useId } from "react";
import { cx } from "../../lib/cx";
import { Heading } from "../../lib/heading";
import { iconProps } from "../../lib/icon";
import { IconButton } from "../Button/Button";

export interface InspectorPanelProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  /** Panel heading; it also names the panel's region. */
  title: ReactNode;
  subtitle?: ReactNode;
  /** When given, a Close button is shown. */
  onClose?: () => void;
  /** Accessible name of the close button. */
  closeLabel?: string;
  footer?: ReactNode;
  headingLevel?: 2 | 3;
}

/**
 * A non-modal side panel that shows details of the selected item beside a list or table.
 * It is a named region with a heading and a Close button.
 */
export function InspectorPanel({
  title,
  subtitle,
  onClose,
  closeLabel = "Close panel",
  footer,
  headingLevel = 2,
  className,
  children,
  ...rest
}: InspectorPanelProps) {
  const headingId = useId();
  return (
    <section className={cx("hb-inspector", className)} aria-labelledby={headingId} {...rest}>
      <div className="hb-inspector__header">
        <div className="hb-inspector__heading">
          <Heading level={headingLevel} id={headingId} className="hb-inspector__title">
            {title}
          </Heading>
          {subtitle != null ? <p className="hb-inspector__subtitle">{subtitle}</p> : null}
        </div>
        {onClose ? (
          <IconButton
            label={closeLabel}
            icon={<X {...iconProps} size={20} />}
            onClick={onClose}
            className="hb-inspector__close"
          />
        ) : null}
      </div>
      <div className="hb-inspector__body">{children}</div>
      {footer != null ? <div className="hb-inspector__footer">{footer}</div> : null}
    </section>
  );
}
