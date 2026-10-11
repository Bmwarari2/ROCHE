import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../../lib/cx";
import { Heading, type HeadingLevel } from "../../lib/heading";
import type { LinkComponent } from "../../lib/link";

export interface TileLink {
  href: string;
  /** Describes the destination, for example "View medicines due". */
  label: string;
}

export interface TileProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title: ReactNode;
  /** A headline figure, shown with tabular numbers. */
  value?: ReactNode;
  description?: ReactNode;
  /** A decorative Lucide icon. */
  icon?: ReactNode;
  /** A status chip or other short state shown under the value. */
  status?: ReactNode;
  /** A tertiary link at the foot of the tile. */
  link?: TileLink;
  linkComponent?: LinkComponent;
  headingLevel?: HeadingLevel;
}

/** A large tile with 28 px corners for dashboards and module launchers. */
export function Tile({
  title,
  value,
  description,
  icon,
  status,
  link,
  linkComponent: LinkElement,
  headingLevel = 2,
  className,
  children,
  ...rest
}: TileProps) {
  const Anchor = LinkElement ?? "a";
  return (
    <article className={cx("hb-tile", className)} {...rest}>
      {icon != null ? (
        <span className="hb-tile__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <Heading level={headingLevel} className="hb-tile__title">
        {title}
      </Heading>
      {value != null ? <p className="hb-tile__value">{value}</p> : null}
      {status != null ? <div className="hb-tile__status">{status}</div> : null}
      {description != null ? <p className="hb-tile__description">{description}</p> : null}
      {children}
      {link ? (
        <Anchor href={link.href} className="hb-tile__link">
          <span>{link.label}</span>
          <span aria-hidden="true" className="hb-tile__chevron">
            ›
          </span>
        </Anchor>
      ) : null}
    </article>
  );
}
