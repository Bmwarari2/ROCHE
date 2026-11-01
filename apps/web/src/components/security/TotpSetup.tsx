"use client";

import { Button, TextField } from "@harbour/ui";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { refreshSecurity } from "@/app/actions/security";
import { authClient } from "@/lib/auth-client";
import { authMessages } from "@/lib/auth-messages";
import { t } from "@/lib/i18n";
import { factorChangeRedirect } from "@/lib/problems";
import { QrCode } from "./QrCode";

type Stage =
  | { readonly kind: "password" }
  | { readonly kind: "scan"; readonly uri: string; readonly backupCodes: readonly string[] }
  | { readonly kind: "done" };

/** The secret from an otpauth:// URI, in groups of four for typing into an app by hand. */
function manualKey(uri: string): string | null {
  try {
    const secret = new URL(uri).searchParams.get("secret");
    return secret ? (secret.match(/.{1,4}/g)?.join(" ") ?? secret) : null;
  } catch {
    return null;
  }
}

/**
 * Sets up an authenticator app: confirm the password, scan the QR code (or type the key), keep the
 * backup codes, then enter a code to prove it works. Better Auth turns two-factor on only after
 * that first code is verified.
 */
export function TotpSetup() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>({ kind: "password" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get("password") ?? "");
    if (!password) {
      setError(t("auth.signIn.passwordRequired"));
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const result = await authClient().twoFactor.enable({ password });
      const redirect = factorChangeRedirect(result.error, "/settings/security");
      if (redirect) {
        router.push(redirect);
        return;
      }
      if (result.error || !result.data || !("totpURI" in result.data)) {
        setError(
          result.error?.status === 429
            ? authMessages.tooManyAttempts
            : authMessages.passwordMismatch,
        );
        return;
      }
      setStage({ kind: "scan", uri: result.data.totpURI, backupCodes: result.data.backupCodes });
    } catch {
      setError(authMessages.unreachable);
    } finally {
      setBusy(false);
    }
  };

  const verify = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get("code") ?? "").replace(/\s+/g, "");
    if (!/^\d{6}$/.test(code)) {
      setError(t("auth.totp.setupCodeRequired"));
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const result = await authClient().twoFactor.verifyTotp({ code });
      if (result.error) {
        setError(authMessages.codeMismatch);
        return;
      }
      setStage({ kind: "done" });
      await refreshSecurity();
      router.refresh();
    } catch {
      setError(authMessages.unreachable);
    } finally {
      setBusy(false);
    }
  };

  if (stage.kind === "done") {
    return (
      <p role="status" className="m-0 font-semibold">
        {t("security.totp.done")}
      </p>
    );
  }

  if (stage.kind === "scan") {
    const key = manualKey(stage.uri);
    return (
      <div className="flex flex-col gap-6">
        <ol className="m-0 flex flex-col gap-6 ps-5">
          <li className="flex flex-col gap-3">
            <span>{t("security.totp.scan")}</span>
            <QrCode value={stage.uri} label={t("security.totp.qrCode")} />
            {key ? (
              <span className="text-callout text-text-secondary">
                {t("security.totp.manualKey")} <code className="font-mono text-text">{key}</code>
              </span>
            ) : null}
          </li>
          <li className="flex flex-col gap-3">
            <span>{t("security.totp.backupCodes")}</span>
            <ul className="m-0 grid list-none grid-cols-2 gap-2 p-0 font-mono sm:grid-cols-5">
              {stage.backupCodes.map((code) => (
                <li key={code} className="rounded-input bg-bg-secondary px-2 py-1 text-center">
                  {code}
                </li>
              ))}
            </ul>
          </li>
          <li>
            <form method="post" className="flex flex-col gap-4" onSubmit={verify} noValidate>
              <TextField
                name="code"
                label={t("security.totp.code")}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                {...(error ? { error } : {})}
              />
              <div>
                <Button type="submit" disabled={busy}>
                  {t("security.totp.finish")}
                </Button>
              </div>
            </form>
          </li>
        </ol>
      </div>
    );
  }

  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={start} noValidate>
      <TextField
        name="password"
        type="password"
        label={t("security.totp.password")}
        hint={t("security.totp.passwordHint")}
        autoComplete="current-password"
        {...(error ? { error } : {})}
      />
      <div>
        <Button type="submit" disabled={busy}>
          {t("security.totp.start")}
        </Button>
      </div>
    </form>
  );
}
