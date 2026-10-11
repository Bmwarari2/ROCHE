"use client";

import { Button, TextField } from "@harbour/ui";
import { KeyRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { refreshSecurity } from "@/app/actions/security";
import { authClient } from "@/lib/auth-client";
import { authMessages } from "@/lib/auth-messages";

/** Registers a passkey (FIDO2) on this device or a security key, for sign-in without a password. */
export function AddPasskey() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "done"; text: string } | null>(null);

  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
    if (typeof window.PublicKeyCredential === "undefined") {
      setMessage({ kind: "error", text: authMessages.passkeyUnsupported });
      return;
    }
    setMessage(null);
    setBusy(true);
    try {
      const result = await authClient().passkey.addPasskey(name ? { name } : {});
      if (result?.error) {
        setMessage({
          kind: "error",
          text: "The passkey was not added. You can try again, or use an authenticator app instead.",
        });
        return;
      }
      setMessage({ kind: "done", text: "Passkey added" });
      await refreshSecurity();
      router.refresh();
    } catch {
      setMessage({ kind: "error", text: authMessages.unreachable });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={add} noValidate>
      <TextField
        name="name"
        label="Name this passkey (optional)"
        hint="For example, Work laptop. It helps you recognise it later."
        maxLength={60}
        autoComplete="off"
      />
      <div aria-live="polite">
        {message ? (
          <p
            className={
              message.kind === "error"
                ? "m-0 border-s-[3px] border-danger ps-2 text-callout font-semibold"
                : "m-0 text-callout font-semibold"
            }
          >
            {message.text}
          </p>
        ) : null}
      </div>
      <div>
        <Button
          type="submit"
          variant="secondary"
          disabled={busy}
          icon={<KeyRound size={18} strokeWidth={1.5} />}
        >
          Add a passkey
        </Button>
      </div>
    </form>
  );
}
