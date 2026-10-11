"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { CircleUserRound, LogOut, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { clearContext } from "@/app/actions/context";
import { authClient } from "@/lib/auth-client";

const icon = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;

export interface AccountMenuProps {
  readonly user: { readonly name: string; readonly email: string };
  readonly organisationName: string;
  readonly signOutLabel: string;
}

/** The account menu at the end of the app bar: who is signed in, for which organisation, and sign out. */
export function AccountMenu({ user, organisationName, signOutLabel }: AccountMenuProps) {
  const [signingOut, setSigningOut] = useState(false);

  const signOut = async () => {
    setSigningOut(true);
    try {
      await authClient().signOut();
    } finally {
      // Forget the organisation too, so the next person on a shared computer starts afresh.
      await clearContext().catch(() => undefined);
      window.location.assign("/sign-in");
    }
  };

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        className="hb-appbar__switcher"
        aria-label={`Your account: ${user.name}`}
        data-testid="account-menu"
      >
        <span className="inline-flex text-text-secondary" aria-hidden="true">
          <CircleUserRound size={20} strokeWidth={1.5} />
        </span>
        <span className="hb-appbar__switcher-value max-sm:hidden">{user.name}</span>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="hb-menu" align="end" sideOffset={6} collisionPadding={8}>
          <DropdownMenu.Label className="hb-menu__label">
            <span className="block text-callout font-semibold text-text">{user.name}</span>
            <span className="block font-normal">{user.email}</span>
            <span className="block font-normal">{organisationName}</span>
          </DropdownMenu.Label>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Item asChild className="hb-menu__item text-text no-underline">
            <Link href="/settings/security">
              <span className="hb-menu__indicator" aria-hidden="true">
                <ShieldCheck {...icon} />
              </span>
              <span className="hb-menu__text">
                <span className="hb-menu__item-label">Sign-in and security</span>
              </span>
            </Link>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className="hb-menu__item"
            disabled={signingOut}
            onSelect={(event) => {
              event.preventDefault();
              void signOut();
            }}
          >
            <span className="hb-menu__indicator" aria-hidden="true">
              <LogOut {...icon} />
            </span>
            <span className="hb-menu__text">
              <span className="hb-menu__item-label">{signOutLabel}</span>
            </span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
