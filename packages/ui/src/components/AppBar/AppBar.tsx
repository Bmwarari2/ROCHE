"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Building2, Check, ChevronDown, MapPin } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../../lib/cx";
import { iconProps } from "../../lib/icon";
import type { LinkComponent } from "../../lib/link";
import { VisuallyHidden } from "../../lib/VisuallyHidden";

export interface SwitcherOption {
  id: string;
  label: string;
  /** Secondary line in the menu, for example the service type. */
  description?: string;
}

export interface AppBarSwitcher {
  /** What is being switched, for example "Organisation" or "Location". */
  label: string;
  options: readonly SwitcherOption[];
  /** The id of the current option. */
  value: string;
  onValueChange: (id: string) => void;
  /** Heading inside the menu. Defaults to "Switch organisation" and so on. */
  menuLabel?: string;
}

export interface AppBarProps extends HTMLAttributes<HTMLElement> {
  productName?: string;
  /**
   * The organisation's white-label logo (PLAT-002), shown 24 px high beside the product name. It
   * is decorative (empty alternative text): the organisation's name is in the switcher beside it.
   */
  brandLogoSrc?: string;
  homeHref?: string;
  /** Tenant (organisation) switcher. With one option it shows the name without a menu. */
  tenant?: AppBarSwitcher;
  /** Location (service) switcher. With one option it shows the name without a menu. */
  location?: AppBarSwitcher;
  /** A control at the start of the bar, such as the phone's navigation menu (`NavMenu`). */
  leading?: ReactNode;
  /** Controls at the end of the bar, such as help and the account menu. */
  actions?: ReactNode;
  /** Id of the main content element for the skip link. Pass null to leave the skip link out. */
  skipLinkTarget?: string | null;
  /** Words for the skip link. Defaults to "Skip to main content". */
  skipLinkLabel?: string;
  linkComponent?: LinkComponent;
}

function Switcher({ switcher, icon }: { switcher: AppBarSwitcher; icon: ReactNode }) {
  const current = switcher.options.find((option) => option.id === switcher.value);
  const currentLabel = current?.label ?? "None selected";

  if (switcher.options.length <= 1) {
    return (
      <span className="hb-appbar__context">
        <span className="hb-appbar__context-icon" aria-hidden="true">
          {icon}
        </span>
        <VisuallyHidden>{switcher.label}:</VisuallyHidden>{" "}
        <span className="hb-appbar__context-value">{currentLabel}</span>
      </span>
    );
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="hb-appbar__switcher">
        <span className="hb-appbar__context-icon" aria-hidden="true">
          {icon}
        </span>
        <VisuallyHidden>{switcher.label}:</VisuallyHidden>{" "}
        <span className="hb-appbar__switcher-value">{currentLabel}</span>
        <ChevronDown {...iconProps} size={14} className="hb-appbar__switcher-chevron" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="hb-menu" align="start" sideOffset={6} collisionPadding={8}>
          <DropdownMenu.Label className="hb-menu__label">
            {switcher.menuLabel ?? `Switch ${switcher.label.toLowerCase()}`}
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={switcher.value} onValueChange={switcher.onValueChange}>
            {switcher.options.map((option) => (
              <DropdownMenu.RadioItem key={option.id} value={option.id} className="hb-menu__item">
                <span className="hb-menu__indicator" aria-hidden="true">
                  <DropdownMenu.ItemIndicator>
                    <Check {...iconProps} size={16} />
                  </DropdownMenu.ItemIndicator>
                </span>
                <span className="hb-menu__text">
                  <span className="hb-menu__item-label">{option.label}</span>
                  {option.description ? (
                    <span className="hb-menu__item-description">{option.description}</span>
                  ) : null}
                </span>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/**
 * The 44 px translucent global bar of the product shell, with the organisation and location
 * switchers. Render it outside `main` so it is the page banner. On phones the organisation and
 * location names shorten with an ellipsis so the actions (such as `AccountMenu`) stay on screen.
 */
export function AppBar({
  productName = "Harbour",
  brandLogoSrc,
  homeHref = "/",
  tenant,
  location,
  leading,
  actions,
  skipLinkTarget = "main-content",
  skipLinkLabel = "Skip to main content",
  linkComponent,
  className,
  ...rest
}: AppBarProps) {
  const Anchor = linkComponent ?? "a";
  return (
    <header className={cx("hb-appbar", className)} {...rest}>
      {skipLinkTarget ? (
        <a className="hb-skip-link" href={`#${skipLinkTarget}`}>
          {skipLinkLabel}
        </a>
      ) : null}
      <div className="hb-appbar__inner">
        {leading != null ? <div className="hb-appbar__leading">{leading}</div> : null}
        <Anchor href={homeHref} className="hb-appbar__brand">
          {brandLogoSrc ? (
            <img className="hb-appbar__logo" src={brandLogoSrc} alt="" height={24} />
          ) : null}
          {productName}
        </Anchor>
        {tenant || location ? (
          <div className="hb-appbar__switchers">
            {tenant ? (
              <Switcher switcher={tenant} icon={<Building2 {...iconProps} size={14} />} />
            ) : null}
            {tenant && location ? (
              <span className="hb-appbar__separator" aria-hidden="true">
                /
              </span>
            ) : null}
            {location ? (
              <Switcher switcher={location} icon={<MapPin {...iconProps} size={14} />} />
            ) : null}
          </div>
        ) : null}
        {actions != null ? <div className="hb-appbar__actions">{actions}</div> : null}
      </div>
    </header>
  );
}
