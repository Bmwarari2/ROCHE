"use client";

import { Button, TextField } from "@harbour/ui";
import { KeyRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { refreshSecurity } from "@/app/actions/security";
import { authClient } from "@/lib/auth-client";
import { authMessages } from "@/lib/auth-messages";
import { t } from "@/lib/i18n";
import { factorChangeRedirect } from "@/lib/problems";

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
      const redirect = factorChangeRedirect(result?.error, "/settings/security");
      if (redirect) {
        router.push(redirect);
        return;
      }
      if (result?.error) {
        setMessage({ kind: "error", text: authMessages.passkeyNotAdded });
        return;
      }
      setMessage({ kind: "done", text: t("security.passkeys.added") });
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
        label={t("security.passkeys.name")}
        hint={t("security.passkeys.nameHint")}
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
          {t("security.passkeys.add")}
        </Button>
      </div>
    </form>
  );
}
