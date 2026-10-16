"use client";

import * as Tooltip from "@radix-ui/react-tooltip";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { type ReactElement, type ReactNode, useId, useState } from "react";
import { cx } from "../../lib/cx";
import { iconProps } from "../../lib/icon";
import type { LinkComponent } from "../../lib/link";
import { VisuallyHidden } from "../../lib/VisuallyHidden";

export interface SidebarItem {
  id: string;
  label: string;
  href: string;
  /** A Lucide icon element, for example `<Pill />`. Pass an element so server components can. */
  icon: ReactNode;
  /** Short count or flag, for example "3". */
  badge?: string;
  /** Accessible text for the badge, for example "3 open". Defaults to the badge text. */
  badgeLabel?: string;
}

export interface SidebarProps {
  items: readonly SidebarItem[];
  /** The id of the current module; its link gets aria-current="page". */
  currentId?: string;
  /** Accessible name of the navigation landmark. */
  label?: string;
  collapsed?: boolean;
  defaultCollapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  /** Extra content above the collapse button, such as a settings link. */
  footer?: ReactNode;
  linkComponent?: LinkComponent;
  className?: string;
}

/**
 * Shows the label as a tooltip beside an icon-only control when the sidebar is collapsed. The
 * tooltip is always mounted (and simply kept closed when expanded) so collapsing the sidebar does
 * not remount the control and lose keyboard focus.
 */
function SidebarTooltip({
  enabled,
  label,
  children,
}: {
  enabled: boolean;
  label: string;
  children: ReactElement;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip.Root open={enabled && open} onOpenChange={setOpen}>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content side="right" sideOffset={8} className="hb-tooltip">
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/**
 * Module navigation with icons and labels. It collapses to icons only; the labels stay in the
 * accessible name and appear as tooltips on hover and focus.
 */
export function Sidebar({
  items,
  currentId,
  label = "Modules",
  collapsed: collapsedProp,
  defaultCollapsed = false,
  onCollapsedChange,
  footer,
  linkComponent,
  className,
}: SidebarProps) {
  const listId = useId();
  const [uncontrolledCollapsed, setUncontrolledCollapsed] = useState(defaultCollapsed);
  // The width animates only after the person toggles it (not when the app sets its first state).
  const [animate, setAnimate] = useState(false);
  const collapsed = collapsedProp ?? uncontrolledCollapsed;
  const Anchor = linkComponent ?? "a";

  const toggle = () => {
    const next = !collapsed;
    setAnimate(true);
    if (collapsedProp === undefined) {
      setUncontrolledCollapsed(next);
    }
    onCollapsedChange?.(next);
  };

  const toggleLabel = collapsed ? "Expand sidebar" : "Collapse sidebar";

  return (
    <Tooltip.Provider delayDuration={300}>
      <nav
        aria-label={label}
        className={cx("hb-sidebar", collapsed && "hb-sidebar--collapsed", className)}
        data-collapsed={collapsed ? "true" : "false"}
        data-animate={animate ? "true" : undefined}
      >
        <ul id={listId} className="hb-sidebar__list">
          {items.map((item) => {
            const current = item.id === currentId;
            return (
              <li key={item.id}>
                <SidebarTooltip enabled={collapsed} label={item.label}>
                  <Anchor
                    href={item.href}
                    className="hb-sidebar__link"
                    aria-current={current ? "page" : undefined}
                    // The label is already the accessible name; the tooltip must not repeat it.
                    aria-describedby={undefined}
                  >
                    <span className="hb-sidebar__icon" aria-hidden="true">
                      {item.icon}
                    </span>
                    <span className="hb-sidebar__label">{item.label}</span>
                    {item.badge ? (
                      <span className="hb-sidebar__badge">
                        <span aria-hidden="true">{item.badge}</span>
                        <VisuallyHidden>, {item.badgeLabel ?? item.badge}</VisuallyHidden>
                      </span>
                    ) : null}
                  </Anchor>
                </SidebarTooltip>
              </li>
            );
          })}
        </ul>
        <div className="hb-sidebar__footer">
          {footer}
          <SidebarTooltip enabled={collapsed} label={toggleLabel}>
            <button
              type="button"
              className="hb-sidebar__toggle"
              onClick={toggle}
              aria-controls={listId}
              aria-describedby={undefined}
            >
              <span className="hb-sidebar__icon" aria-hidden="true">
                {collapsed ? (
                  <PanelLeftOpen {...iconProps} size={20} />
                ) : (
                  <PanelLeftClose {...iconProps} size={20} />
                )}
              </span>
              <span className="hb-sidebar__label">{toggleLabel}</span>
            </button>
          </SidebarTooltip>
        </div>
      </nav>
    </Tooltip.Provider>
  );
}
