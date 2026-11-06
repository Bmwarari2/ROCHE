"use client";

import { Menu } from "lucide-react";
import { useState } from "react";
import { cx } from "../../lib/cx";
import { iconProps } from "../../lib/icon";
import type { LinkComponent } from "../../lib/link";
import { VisuallyHidden } from "../../lib/VisuallyHidden";
import { Button } from "../Button/Button";
import { Sheet } from "../Sheet/Sheet";
import type { SidebarItem } from "../Sidebar/Sidebar";

export interface NavMenuProps {
  /** The same items as the sidebar. */
  items: readonly SidebarItem[];
  /** The id of the current module; its link gets aria-current="page". */
  currentId?: string;
  /** The button's visible word, for example "Menu". */
  buttonLabel?: string;
  /** The sheet's title and the navigation landmark's name, for example "Modules". */
  label?: string;
  closeLabel?: string;
  linkComponent?: LinkComponent;
  className?: string;
}

/**
 * Module navigation on a phone (MOB-013): a "Menu" button with a visible word that opens the
 * sidebar's items, with their labels, in a modal sheet. Focus is trapped while it is open, Escape
 * closes it, choosing a module closes it, and focus returns to the button. Shown at 734 px and
 * below, where the sidebar is hidden so the page keeps its width (WCAG 1.4.10).
 */
export function NavMenu({
  items,
  currentId,
  buttonLabel = "Menu",
  label = "Modules",
  closeLabel = "Close",
  linkComponent,
  className,
}: NavMenuProps) {
  const [open, setOpen] = useState(false);
  const Anchor = linkComponent ?? "a";
  return (
    <div className={cx("hb-navmenu", className)}>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title={label}
        closeLabel={closeLabel}
        trigger={
          <Button
            variant="secondary"
            icon={<Menu {...iconProps} size={18} />}
            className="hb-navmenu__button"
          >
            {buttonLabel}
          </Button>
        }
      >
        <nav aria-label={label}>
          <ul className="hb-navmenu__list">
            {items.map((item) => (
              <li key={item.id}>
                <Anchor
                  href={item.href}
                  className="hb-navmenu__link"
                  aria-current={item.id === currentId ? "page" : undefined}
                  onClick={() => setOpen(false)}
                >
                  <span className="hb-navmenu__icon" aria-hidden="true">
                    {item.icon}
                  </span>
                  <span className="hb-navmenu__label">{item.label}</span>
                  {item.badge ? (
                    <span className="hb-sidebar__badge">
                      <span aria-hidden="true">{item.badge}</span>
                      <VisuallyHidden>, {item.badgeLabel ?? item.badge}</VisuallyHidden>
                    </span>
                  ) : null}
                </Anchor>
              </li>
            ))}
          </ul>
        </nav>
      </Sheet>
    </div>
  );
}
