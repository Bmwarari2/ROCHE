"use client";

import { Button, type ButtonVariant } from "@harbour/ui";
import { useState } from "react";
import { signOutAndForget } from "@/lib/sign-out";

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
      onClick={() => {
        setBusy(true);
        void signOutAndForget();
      }}
    >
      {label}
    </Button>
  );
}
