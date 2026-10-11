"use client";

import { Button, type ButtonVariant } from "@harbour/ui";
import { useState } from "react";
import { clearContext } from "@/app/actions/context";
import { authClient } from "@/lib/auth-client";

export function SignOutButton({
  label,
  variant = "secondary",
}: {
  readonly label: string;
  readonly variant?: ButtonVariant;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant={variant}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await authClient().signOut();
        } finally {
          await clearContext().catch(() => undefined);
          window.location.assign("/sign-in");
        }
      }}
    >
      {label}
    </Button>
  );
}
