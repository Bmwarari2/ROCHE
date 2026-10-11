import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../../lib/cx";
import type { LinkComponent } from "../../lib/link";

export interface TabNavItem {
  /** Where the tab goes. Each tab is a page of its own, so it can be bookmarked and shared. */
  href: string;
  label: string;
  /** Marks the page being shown (`aria-current="page"`), with a bar and bold text. */
  current?: boolean;
  /** A decorative Lucide icon before the label. */
  icon?: ReactNode;
}

export interface TabNavProps extends Omit<HTMLAttributes<HTMLElement>, "children"> {
  /** Names the navigation landmark, for example "Record sections". */
  label: string;
  items: readonly TabNavItem[];
  /** Renders the links, for example Next.js `Link` for client-side routing. */
  linkComponent?: LinkComponent;
}

/**
 * A row of links that switch between the pages of one record, styled as tabs. These are links,
 * not an ARIA tablist: each tab is its own address, the browser's back button works, and screen
 * readers announce the current page. The row scrolls sideways on its own on a phone, never the
 * page. The current tab is shown by a bar and bold text as well as `aria-current`, never colour
 * alone.
 */
export function TabNav({ label, items, linkComponent, className, ...rest }: TabNavProps) {
  const Link = linkComponent ?? "a";
  return (
    <nav aria-label={label} className={cx("hb-tabnav", className)} {...rest}>
      <ul className="hb-tabnav__list">
        {items.map((item) => (
          <li key={item.href} className="hb-tabnav__item">
            <Link
              href={item.href}
              className="hb-tabnav__link"
              aria-current={item.current ? "page" : undefined}
            >
              {item.icon != null ? (
                <span className="hb-tabnav__icon" aria-hidden="true">
                  {item.icon}
                </span>
              ) : null}
              <span className="hb-tabnav__label">{item.label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
