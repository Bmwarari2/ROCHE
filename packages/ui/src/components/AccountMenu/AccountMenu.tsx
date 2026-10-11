"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { CircleUserRound } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../../lib/cx";
import { iconProps } from "../../lib/icon";
import type { LinkComponent } from "../../lib/link";
import { VisuallyHidden } from "../../lib/VisuallyHidden";

interface AccountMenuItemBase {
  id: string;
  /** Says what happens, for example "Sign out" or "Sign-in and security". */
  label: string;
  /** A Lucide icon element shown before the label. Hidden from assistive technology. */
  icon?: ReactNode;
  disabled?: boolean;
}

export interface AccountMenuLinkItem extends AccountMenuItemBase {
  /** Where the item goes. Rendered with `linkComponent`. */
  href: string;
  onSelect?: never;
}

export interface AccountMenuActionItem extends AccountMenuItemBase {
  href?: never;
  /**
   * Runs when the item is chosen with a click, Enter or Space. Call `event.preventDefault()` to
   * keep the menu open, for example while signing out.
   */
  onSelect: (event: Event) => void;
}

export type AccountMenuItem = AccountMenuLinkItem | AccountMenuActionItem;

export interface AccountMenuProps {
  /** The signed-in person's name. Shown beside the icon (not on phones) and in the menu. */
  userName: string;
  /** A second line under the name, usually the email address. */
  userDetail?: string;
  /** The organisation the person is acting for. */
  organisationName?: string;
  /** The location in scope, or words such as "All locations". */
  locationName?: string;
  items: readonly AccountMenuItem[];
  /** Accessible name of the button. Defaults to "Your account: <name>". */
  triggerLabel?: string;
  /** Words read before the organisation name. Defaults to "Organisation". */
  organisationLabel?: string;
  /** Words read before the location name. Defaults to "Location". */
  locationLabel?: string;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  linkComponent?: LinkComponent;
  className?: string;
}

function ItemContent({ item }: { item: AccountMenuItem }) {
  return (
    <>
      <span className="hb-menu__indicator" aria-hidden="true">
        {item.icon}
      </span>
      <span className="hb-menu__text">
        <span className="hb-menu__item-label">{item.label}</span>
      </span>
    </>
  );
}

/**
 * The account menu at the end of the app bar: who is signed in, for which organisation and
 * location, and actions such as sign-in settings and sign out. A Radix dropdown menu, so it opens
 * with Enter, Space or the arrow keys, moves between items with the arrow keys, closes with Escape
 * and returns focus to the button. Pass it to `AppBar` as `actions`.
 */
export function AccountMenu({
  userName,
  userDetail,
  organisationName,
  locationName,
  items,
  triggerLabel,
  organisationLabel = "Organisation",
  locationLabel = "Location",
  open,
  defaultOpen,
  onOpenChange,
  linkComponent,
  className,
}: AccountMenuProps) {
  const Anchor = linkComponent ?? "a";
  return (
    <DropdownMenu.Root open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger
        className={cx("hb-account-menu__trigger", className)}
        aria-label={triggerLabel ?? `Your account: ${userName}`}
      >
        <span className="hb-account-menu__icon" aria-hidden="true">
          <CircleUserRound {...iconProps} size={20} />
        </span>
        <span className="hb-account-menu__name">{userName}</span>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="hb-menu" align="end" sideOffset={6} collisionPadding={8}>
          <DropdownMenu.Label className="hb-menu__header">
            <span className="hb-menu__header-name">{userName}</span>
            {userDetail ? <span className="hb-menu__header-detail">{userDetail}</span> : null}
            {organisationName ? (
              <span className="hb-menu__header-detail">
                <VisuallyHidden>{organisationLabel}: </VisuallyHidden>
                {organisationName}
              </span>
            ) : null}
            {locationName ? (
              <span className="hb-menu__header-detail">
                <VisuallyHidden>{locationLabel}: </VisuallyHidden>
                {locationName}
              </span>
            ) : null}
          </DropdownMenu.Label>
          <DropdownMenu.Separator className="hb-menu__separator" />
          {items.map((item) =>
            item.href !== undefined ? (
              <DropdownMenu.Item
                key={item.id}
                asChild
                className="hb-menu__item hb-menu__item--link"
                disabled={item.disabled}
              >
                <Anchor href={item.href}>
                  <ItemContent item={item} />
                </Anchor>
              </DropdownMenu.Item>
            ) : (
              <DropdownMenu.Item
                key={item.id}
                className="hb-menu__item"
                onSelect={item.onSelect}
                disabled={item.disabled}
              >
                <ItemContent item={item} />
              </DropdownMenu.Item>
            ),
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
