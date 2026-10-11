"use client";

import { Button, TextField } from "@harbour/ui";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { refreshSecurity } from "@/app/actions/security";
import { authClient } from "@/lib/auth-client";
import { authMessages } from "@/lib/auth-messages";
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
      setError("Enter your password");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const result = await authClient().twoFactor.enable({ password });
      if (result.error || !result.data || !("totpURI" in result.data)) {
        setError(
          result.error?.status === 429
            ? authMessages.tooManyAttempts
            : "That password did not match the one for your account. Check it and try again.",
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
      setError("Enter the 6 digits from your authenticator app");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const result = await authClient().twoFactor.verifyTotp({ code });
      if (result.error) {
        setError(authMessages.totpFailed);
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
        Your authenticator app is set up. Harbour will ask for a code when you sign in.
      </p>
    );
  }

  if (stage.kind === "scan") {
    const key = manualKey(stage.uri);
    return (
      <div className="flex flex-col gap-6">
        <ol className="m-0 flex flex-col gap-6 ps-5">
          <li className="flex flex-col gap-3">
            <span>Scan this QR code with your authenticator app.</span>
            <QrCode value={stage.uri} label="QR code to add Harbour to your authenticator app" />
            {key ? (
              <span className="text-callout text-text-secondary">
                Cannot scan it? Enter this key in the app instead:{" "}
                <code className="font-mono text-text">{key}</code>
              </span>
            ) : null}
          </li>
          <li className="flex flex-col gap-3">
            <span>
              Keep these backup codes somewhere safe, away from your phone. Each one works once if
              you cannot use your authenticator app.
            </span>
            <ul className="m-0 grid list-none grid-cols-2 gap-2 p-0 font-mono sm:grid-cols-5">
              {stage.backupCodes.map((code) => (
                <li key={code} className="rounded-input bg-bg-secondary px-2 py-1 text-center">
                  {code}
                </li>
              ))}
            </ul>
          </li>
          <li>
            <form className="flex flex-col gap-4" onSubmit={verify} noValidate>
              <TextField
                name="code"
                label="Enter the 6-digit code from the app"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                {...(error ? { error } : {})}
              />
              <div>
                <Button type="submit" disabled={busy}>
                  Finish setting up
                </Button>
              </div>
            </form>
          </li>
        </ol>
      </div>
    );
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={start} noValidate>
      <TextField
        name="password"
        type="password"
        label="Your password"
        hint="Harbour asks for it before changing how you sign in."
        autoComplete="current-password"
        {...(error ? { error } : {})}
      />
      <div>
        <Button type="submit" disabled={busy}>
          Set up an authenticator app
        </Button>
      </div>
    </form>
  );
}
