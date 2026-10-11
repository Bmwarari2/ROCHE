"use client";

import { Button, TextField } from "@harbour/ui";
import { KeyRound } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { authMessages, signInErrorMessage } from "@/lib/auth-messages";

export interface SignInLabels {
  readonly email: string;
  readonly password: string;
  readonly submit: string;
  readonly passkey: string;
  readonly totpTitle: string;
  readonly totpHint: string;
}

type Step = "credentials" | "totp";

/**
 * Email and password, then the authenticator code when Better Auth asks for it
 * (twoFactorRedirect), or a passkey. Errors say what to do and never blame the person.
 */
export function SignInForm({
  labels,
  nextPath,
}: {
  readonly labels: SignInLabels;
  readonly nextPath: string;
}) {
  const [step, setStep] = useState<Step>("credentials");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{
    email?: string;
    password?: string;
    code?: string;
  }>({});
  const codeRef = useRef<HTMLInputElement>(null);

  const finish = () => {
    window.location.assign(nextPath);
  };

  const signIn = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const errors: typeof fieldErrors = {};
    if (!email) errors.email = "Enter your email address";
    if (!password) errors.password = "Enter your password";
    setFieldErrors(errors);
    setError(null);
    if (errors.email || errors.password) return;

    setBusy(true);
    try {
      const result = await authClient().signIn.email({ email, password });
      if (result.error) {
        setError(signInErrorMessage(result.error));
        return;
      }
      if (result.data && "twoFactorRedirect" in result.data && result.data.twoFactorRedirect) {
        setStep("totp");
        // Move focus to the new field so keyboard and screen reader users land on it.
        requestAnimationFrame(() => codeRef.current?.focus());
        return;
      }
      finish();
    } catch {
      setError(authMessages.unreachable);
    } finally {
      setBusy(false);
    }
  };

  const verifyCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const code = String(form.get("code") ?? "").replace(/\s+/g, "");
    if (!/^\d{6}$/.test(code)) {
      setFieldErrors({ code: "Enter the 6 digits from your authenticator app" });
      return;
    }
    setFieldErrors({});
    setError(null);
    setBusy(true);
    try {
      const result = await authClient().twoFactor.verifyTotp({ code });
      if (result.error) {
        setError(
          result.error.status === 429 ? authMessages.tooManyAttempts : authMessages.totpFailed,
        );
        return;
      }
      finish();
    } catch {
      setError(authMessages.unreachable);
    } finally {
      setBusy(false);
    }
  };

  const signInWithPasskey = async () => {
    setError(null);
    if (typeof window.PublicKeyCredential === "undefined") {
      setError(authMessages.passkeyUnsupported);
      return;
    }
    setBusy(true);
    try {
      const result = await authClient().signIn.passkey();
      if (result?.error) {
        setError(
          result.error.status && result.error.status >= 500
            ? authMessages.unreachable
            : authMessages.passkeyCancelled,
        );
        return;
      }
      finish();
    } catch {
      setError(authMessages.passkeyCancelled);
    } finally {
      setBusy(false);
    }
  };

  // The live region is always present, so a new message is announced when it appears.
  const errorMessage = (
    <div aria-live="assertive" aria-atomic="true">
      {error ? (
        <p className="m-0 rounded-input border-s-[3px] border-danger bg-card px-4 py-3 text-callout font-semibold text-text">
          {error}
        </p>
      ) : null}
    </div>
  );

  if (step === "totp") {
    return (
      <form className="flex flex-col gap-4" onSubmit={verifyCode} noValidate>
        {errorMessage}
        <TextField
          ref={codeRef}
          name="code"
          label={labels.totpTitle}
          hint={labels.totpHint}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          {...(fieldErrors.code ? { error: fieldErrors.code } : {})}
        />
        <Button type="submit" fullWidth disabled={busy}>
          {labels.submit}
        </Button>
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <form className="flex flex-col gap-4" onSubmit={signIn} noValidate>
        {errorMessage}
        <TextField
          name="email"
          type="email"
          label={labels.email}
          autoComplete="username"
          spellCheck={false}
          {...(fieldErrors.email ? { error: fieldErrors.email } : {})}
        />
        <TextField
          name="password"
          type="password"
          label={labels.password}
          autoComplete="current-password"
          {...(fieldErrors.password ? { error: fieldErrors.password } : {})}
        />
        <Button type="submit" fullWidth disabled={busy}>
          {labels.submit}
        </Button>
      </form>
      <div className="flex items-center gap-3 text-callout text-text-secondary">
        <span className="h-px flex-1 bg-border" aria-hidden="true" />
        <span>or</span>
        <span className="h-px flex-1 bg-border" aria-hidden="true" />
      </div>
      <Button
        variant="secondary"
        fullWidth
        disabled={busy}
        onClick={signInWithPasskey}
        icon={<KeyRound size={18} strokeWidth={1.5} />}
      >
        {labels.passkey}
      </Button>
    </div>
  );
}
