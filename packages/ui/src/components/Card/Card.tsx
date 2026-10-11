import { type HTMLAttributes, type ReactNode, useId } from "react";
import { cx } from "../../lib/cx";
import { Heading, type HeadingLevel } from "../../lib/heading";

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  /** Card heading. With `as="section"` it also names the region. */
  title?: ReactNode;
  description?: ReactNode;
  /** Controls placed beside the heading, such as a tertiary "View all" link. */
  actions?: ReactNode;
  footer?: ReactNode;
  headingLevel?: HeadingLevel;
  /** Use "section" for a named region or "article" for a self-contained record. */
  as?: "div" | "section" | "article";
  /** "none" lets tables and lists run edge to edge. */
  padding?: "regular" | "none";
}

/** A white surface with a hairline border and 18 px corners. */
export function Card({
  title,
  description,
  actions,
  footer,
  headingLevel = 2,
  as: Element = "div",
  padding = "regular",
  className,
  children,
  ...rest
}: CardProps) {
  const headingId = useId();
  const hasHeader = title != null || actions != null;
  return (
    <Element
      className={cx("hb-card", padding === "none" && "hb-card--flush", className)}
      aria-labelledby={Element === "section" && title != null ? headingId : undefined}
      {...rest}
    >
      {hasHeader ? (
        <div className="hb-card__header">
          <div className="hb-card__heading">
            {title != null ? (
              <Heading level={headingLevel} id={headingId} className="hb-card__title">
                {title}
              </Heading>
            ) : null}
            {description != null ? <p className="hb-card__description">{description}</p> : null}
          </div>
          {actions != null ? <div className="hb-card__actions">{actions}</div> : null}
        </div>
      ) : null}
      {children != null ? <div className="hb-card__body">{children}</div> : null}
      {footer != null ? <div className="hb-card__footer">{footer}</div> : null}
    </Element>
  );
}
