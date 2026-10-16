"use client";

import { Button, ButtonLink, Card, TextField } from "@harbour/ui";
import { CircleAlert, CircleCheck, Clock, KeyRound, LoaderCircle } from "lucide-react";
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { SignOutButton } from "@/app/(auth)/choose-organisation/SignOutButton";
import { acceptInvitation, lookupInvitation } from "@/app/actions/invitations";
import { PasswordField } from "@/components/security/PasswordField";
import { t } from "@/lib/i18n";
import {
  type AcceptResult,
  INVITATION_TOKEN_KEY,
  type InvitationRefusal,
  isFinal,
  isInvitationToken,
  type LookupResult,
  offersSignIn,
  SIGN_IN_THEN_RETURN,
  tokenFromFragment,
} from "@/lib/invitations";

const NAME_ID = "invitation-name";
const PASSWORD_ID = "invitation-password";

type Found = Extract<LookupResult, { kind: "found" }>;

type View =
  | { readonly kind: "loading" }
  | Found
  | { readonly kind: "refused"; readonly refusal: InvitationRefusal }
  | { readonly kind: "throttled"; readonly minutes: number }
  | { readonly kind: "unavailable" }
  | { readonly kind: "sign_in_first" }
  | { readonly kind: "ready"; readonly destination: string };

function readStored(): string | null {
  try {
    return window.sessionStorage.getItem(INVITATION_TOKEN_KEY);
  } catch {
    return null;
  }
}

function store(token: string | null): void {
  try {
    if (token) window.sessionStorage.setItem(INVITATION_TOKEN_KEY, token);
    else window.sessionStorage.removeItem(INVITATION_TOKEN_KEY);
  } catch {
    // Storage blocked: the page still works from the link; signing in first then needs the link.
  }
}

/** The link's token: from the fragment (then out of the address bar), or this tab's storage. */
function takeToken(): string | null {
  const fromLink = tokenFromFragment(window.location.hash);
  if (fromLink) {
    store(fromLink);
    window.history.replaceState(null, "", window.location.pathname);
    return fromLink;
  }
  const stored = readStored();
  return isInvitationToken(stored) ? stored : null;
}

/** A message in a box with an icon and a bold title: never colour alone. Takes focus on arrival. */
function Message({
  icon,
  title,
  children,
  role = "alert",
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly children?: ReactNode;
  readonly role?: "alert" | "status";
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div
      ref={ref}
      role={role}
      tabIndex={-1}
      className="flex gap-3 rounded-card border border-border bg-card p-4"
    >
      <span aria-hidden="true" className="mt-0.5 shrink-0">
        {icon}
      </span>
      <div className="flex min-w-0 flex-col gap-3">
        <p className="m-0 font-semibold">{title}</p>
        {children}
      </div>
    </div>
  );
}

const alertIcon = <CircleAlert size={20} strokeWidth={1.5} />;

/**
 * Accepting an invitation (PLAT-004). Reads the token from the link's fragment, asks the API what
 * it is for, then: creates a sign-in (name and a password under the NCSC rules), or asks the person
 * to sign in first, or joins with the sign-in they are using. Afterwards they sign in and set up a
 * passkey or an authenticator app. Every refusal is said in plain words with what to do next.
 */
export function InvitationAccept() {
  const [token, setToken] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<{ name?: string; password?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const summaryRef = useRef<HTMLDivElement>(null);

  const show = useCallback((result: LookupResult) => {
    if (result.kind === "refused" && isFinal(result.refusal)) store(null);
    setView(result);
  }, []);

  const look = useCallback(
    async (value: string) => {
      setView({ kind: "loading" });
      show(await lookupInvitation(value).catch((): LookupResult => ({ kind: "unavailable" })));
    },
    [show],
  );

  useEffect(() => {
    const value = takeToken();
    setToken(value);
    if (value) void look(value);
    else setView({ kind: "refused", refusal: "no_token" });
  }, [look]);

  useEffect(() => {
    if (formError || errors.name || errors.password) summaryRef.current?.focus();
  }, [formError, errors]);

  const handle = (result: AcceptResult) => {
    switch (result.kind) {
      case "accepted":
        store(null);
        if (result.next === "enrol") window.location.assign(result.destination);
        else setView({ kind: "ready", destination: result.destination });
        return;
      case "invalid":
        setErrors({
          ...(result.name ? { name: t("invitation.form.nameRequired") } : {}),
          ...(result.password
            ? {
                password:
                  result.password === "passwordRequired"
                    ? t("invitation.form.passwordRequired")
                    : t("invitation.password.rule", { rule: result.password }),
              }
            : {}),
        });
        return;
      case "refused":
        show(result);
        return;
      default:
        setView(result);
    }
  };

  const send = async (input: { name?: string; password?: string }) => {
    if (!token) return;
    setBusy(true);
    setFormError(null);
    try {
      handle(await acceptInvitation({ token, ...input }));
    } catch {
      setFormError(t("auth.errors.unreachable"));
    } finally {
      setBusy(false);
    }
  };

  const createSignIn = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setErrors({});
    void send({
      name: String(form.get("name") ?? ""),
      password: String(form.get("password") ?? ""),
    });
  };

  const retry = token ? (
    <div>
      <Button variant="secondary" onClick={() => void look(token)}>
        {t("common.retry")}
      </Button>
    </div>
  ) : null;

  switch (view.kind) {
    case "loading":
      return (
        <p role="status" className="m-0 inline-flex items-center gap-2">
          <LoaderCircle size={18} strokeWidth={1.5} aria-hidden="true" />
          {t("invitation.loading")}
        </p>
      );
    case "refused":
      return (
        <Message icon={alertIcon} title={t("invitation.refused.title")}>
          <p className="m-0">{t("invitation.refusal", { refusal: view.refusal })}</p>
          {offersSignIn(view.refusal) ? (
            <div>
              <ButtonLink href="/sign-in">{t("auth.signIn.submit")}</ButtonLink>
            </div>
          ) : null}
          {view.refusal === "email_mismatch" ? (
            <div>
              <SignOutButton label={t("common.signOut")} />
            </div>
          ) : null}
        </Message>
      );
    case "throttled":
      return (
        <Message
          icon={<Clock size={20} strokeWidth={1.5} />}
          title={t("invitation.throttled.title")}
        >
          <p className="m-0">{t("invitation.throttled.body", { minutes: view.minutes })}</p>
          {retry}
        </Message>
      );
    case "unavailable":
      return (
        <Message icon={alertIcon} title={t("invitation.unavailable.title")}>
          <p className="m-0">{t("auth.errors.unreachable")}</p>
          {retry}
        </Message>
      );
    case "sign_in_first":
      return <SignInFirst />;
    case "ready":
      return (
        <Message
          role="status"
          icon={<CircleCheck size={20} strokeWidth={1.5} />}
          title={t("invitation.ready.title")}
        >
          <p className="m-0">{t("invitation.ready.body")}</p>
          <div>
            <ButtonLink href={view.destination}>{t("auth.signIn.submit")}</ButtonLink>
          </div>
        </Message>
      );
    case "found":
      break;
  }

  const intro = (
    <div className="flex flex-col gap-2">
      <h2 className="m-0 text-body font-semibold">
        {t("invitation.found.title", { organisation: view.organisationName })}
      </h2>
      {view.emailMasked ? (
        <p className="m-0">{t("invitation.found.sentTo", { email: view.emailMasked })}</p>
      ) : null}
      <p className="m-0 text-text-secondary">
        {t("invitation.found.expires", { when: view.expiresAt })}
      </p>
    </div>
  );

  if (view.path === "sign_in_first") return <SignInFirst intro={intro} />;

  const problem =
    formError || errors.name || errors.password ? (
      <div
        ref={summaryRef}
        role="alert"
        tabIndex={-1}
        className="flex gap-3 rounded-input border-s-4 border-danger bg-bg-secondary p-4"
      >
        <CircleAlert size={20} strokeWidth={1.5} aria-hidden="true" className="mt-0.5 shrink-0" />
        <div className="flex flex-col gap-1">
          <p className="m-0 font-semibold">{t("care.common.problem")}</p>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {formError ? <li>{formError}</li> : null}
            {(
              [
                [NAME_ID, errors.name],
                [PASSWORD_ID, errors.password],
              ] as const
            ).map(([id, message]) =>
              message ? (
                <li key={id}>
                  <a
                    href={`#${id}`}
                    className="inline-flex min-h-target items-center underline"
                    onClick={(event) => {
                      event.preventDefault();
                      document.getElementById(id)?.focus();
                    }}
                  >
                    {message}
                  </a>
                </li>
              ) : null,
            )}
          </ul>
        </div>
      </div>
    ) : null;

  if (view.path === "link_signed_in") {
    return (
      <Card>
        <div className="flex flex-col gap-4">
          {intro}
          {problem}
          <p className="m-0">{t("invitation.join.body")}</p>
          <div>
            <Button disabled={busy} onClick={() => void send({})}>
              {t("invitation.join.submit")}
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <form className="flex flex-col gap-4" onSubmit={createSignIn} noValidate>
        {intro}
        {problem}
        <p className="m-0">{t("invitation.form.body")}</p>
        <TextField
          id={NAME_ID}
          name="name"
          label={t("invitation.form.name")}
          hint={t("invitation.form.nameHint")}
          autoComplete="name"
          maxLength={200}
          {...(errors.name ? { error: errors.name } : {})}
        />
        <PasswordField
          id={PASSWORD_ID}
          name="password"
          label={t("invitation.form.password")}
          hint={t("invitation.password.hint")}
          error={errors.password}
        />
        <Button
          type="submit"
          fullWidth
          disabled={busy}
          icon={<KeyRound size={18} strokeWidth={1.5} />}
        >
          {t("invitation.form.submit")}
        </Button>
      </form>
    </Card>
  );
}

/** A sign-in already exists for the address: sign in, then this page picks the invitation up. */
function SignInFirst({ intro }: { readonly intro?: ReactNode }) {
  return (
    <Card>
      <div className="flex flex-col gap-4">
        {intro}
        <Message icon={alertIcon} title={t("invitation.signInFirst.title")} role="status">
          <p className="m-0">{t("invitation.signInFirst.body")}</p>
          <div>
            <ButtonLink href={SIGN_IN_THEN_RETURN}>{t("auth.signIn.submit")}</ButtonLink>
          </div>
        </Message>
      </div>
    </Card>
  );
}
