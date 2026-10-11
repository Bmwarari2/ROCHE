import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../../lib/cx";
import { Heading } from "../../lib/heading";

export interface PageHeaderProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title: ReactNode;
  /** A short line above the title, such as the module or the person's service. */
  eyebrow?: ReactNode;
  description?: ReactNode;
  /** The one primary action for the page: a primary pill `Button` or `ButtonLink`. */
  primaryAction?: ReactNode;
  /** Secondary or tertiary actions, shown before the primary action. */
  secondaryActions?: ReactNode;
  /** 1 for a page title (default), 2 when the header sits inside another titled page. */
  headingLevel?: 1 | 2;
}

/** The page title block: eyebrow, large quiet title and a primary action pill. */
export function PageHeader({
  title,
  eyebrow,
  description,
  primaryAction,
  secondaryActions,
  headingLevel = 1,
  className,
  children,
  ...rest
}: PageHeaderProps) {
  const heading = (
    <Heading level={headingLevel} className="hb-page-header__title">
      {title}
    </Heading>
  );
  return (
    <header className={cx("hb-page-header", className)} {...rest}>
      <div className="hb-page-header__text">
        {eyebrow != null ? (
          <hgroup className="hb-page-header__titles">
            <p className="hb-page-header__eyebrow">{eyebrow}</p>
            {heading}
          </hgroup>
        ) : (
          heading
        )}
        {description != null ? <p className="hb-page-header__description">{description}</p> : null}
        {children != null ? <div className="hb-page-header__meta">{children}</div> : null}
      </div>
      {primaryAction != null || secondaryActions != null ? (
        <div className="hb-page-header__actions">
          {secondaryActions}
          {primaryAction}
        </div>
      ) : null}
    </header>
  );
}
