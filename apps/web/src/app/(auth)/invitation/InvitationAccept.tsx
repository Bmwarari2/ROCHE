"use client";

import { passwordRuleBroken } from "@harbour/domain";
import { Button, ButtonLink, Card, TextField, VisuallyHidden } from "@harbour/ui";
import { CircleAlert, CircleCheck, Clock, Info, KeyRound, LoaderCircle } from "lucide-react";
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { SignOutButton } from "@/app/(auth)/choose-organisation/SignOutButton";
import { PasswordField } from "@/components/security/PasswordField";
import { t } from "@/lib/i18n";
import {
  type AcceptResult,
  forgetKeptToken,
  INVITATION_TOKEN_KEY,
  type InvitationRefusal,
  isFinal,
  keptToken,
  type LookupResult,
  offersSignIn,
  readKeptToken,
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

/** The link's token: from the fragment (then out of the address bar), or this tab's storage. */
function takeToken(): string | null {
  const fromLink = tokenFromFragment(window.location.hash);
  try {
    if (fromLink) {
      window.sessionStorage.setItem(INVITATION_TOKEN_KEY, keptToken(fromLink, new Date()));
    } else {
      const kept = readKeptToken(window.sessionStorage.getItem(INVITATION_TOKEN_KEY), new Date());
      if (!kept) forgetKeptToken();
      return kept;
    }
  } catch {
    // Storage blocked: the page still works from the link; signing in first then needs the link.
  }
  if (fromLink) {
    window.history.replaceState(null, "", window.location.pathname);
    // Again once Next.js has patched history, so its router forgets the fragment too and a later
    // refresh never writes the token back into the address (#113 security review L2).
    setTimeout(() => window.history.replaceState(null, "", window.location.pathname), 0);
  }
  return fromLink;
}

/** POSTs to the page's route handler (same origin, JSON body); never the token in a URL. */
async function call<T>(path: "lookup" | "accept", body: object): Promise<T | null> {
  try {
    const response = await fetch(`/api/invitations/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    return response.ok ? ((await response.json()) as T) : null;
  } catch {
    return null;
  }
}

/** The heading each view starts with: focus moves to it when the view changes. */
function ViewHeading({ children }: { readonly children: ReactNode }) {
  return (
    <h2 data-view-heading="" tabIndex={-1} className="m-0 text-body font-semibold">
      {children}
    </h2>
  );
}

/** A message in a box with an icon and a heading: never colour alone. */
function Message({
  icon,
  title,
  children,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly children?: ReactNode;
}) {
  return (
    <div className="flex gap-3 rounded-card border border-border bg-card p-4">
      <span aria-hidden="true" className="mt-0.5 shrink-0">
        {icon}
      </span>
      <div className="flex min-w-0 flex-col gap-3">
        <ViewHeading>{title}</ViewHeading>
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
 * Focus moves to each new view's heading; while sending, the button keeps focus and a polite
 * status says so.
 */
export function InvitationAccept() {
  const [token, setToken] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<{ name?: string; password?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);

  const show = useCallback((result: LookupResult) => {
    if (result.kind === "refused" && isFinal(result.refusal)) forgetKeptToken();
    // Only signing in first needs the token kept; the form works from the page as it is.
    if (result.kind === "found" && result.path === "create_sign_in") forgetKeptToken();
    setView(result);
  }, []);

  const look = useCallback(
    async (value: string) => {
      setView({ kind: "loading" });
      show(
        (await call<LookupResult>("lookup", { token: value })) ?? {
          kind: "unavailable",
        },
      );
    },
    [show],
  );

  useEffect(() => {
    const value = takeToken();
    setToken(value);
    if (value) void look(value);
    else setView({ kind: "refused", refusal: "no_token" });
  }, [look]);

  // Focus moves to the new view's heading, so "Checking your invitation" is never left behind.
  useEffect(() => {
    if (view.kind === "loading") return;
    containerRef.current?.querySelector<HTMLElement>("[data-view-heading]")?.focus();
  }, [view]);

  useEffect(() => {
    if (formError || errors.name || errors.password) summaryRef.current?.focus();
  }, [formError, errors]);

  const handle = (result: AcceptResult) => {
    switch (result.kind) {
      case "accepted":
        forgetKeptToken();
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
        // Joining with a sign-in that has since ended reads as a bad request: ask again, so the
        // page offers the right path instead of "this link does not work".
        if (result.refusal === "not_found" && view.kind === "found" && token) {
          void look(token);
          return;
        }
        show(result);
        return;
      default:
        setView(result);
    }
  };

  const send = async (input: { name?: string; password?: string }) => {
    if (!token || busy) return;
    setBusy(true);
    setFormError(null);
    const result = await call<AcceptResult>("accept", { token, ...input });
    setBusy(false);
    if (result) handle(result);
    else setFormError(t("auth.errors.unreachable"));
  };

  const createSignIn = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "");
    const password = String(form.get("password") ?? "");
    // The same checks the API makes, before sending, so each reason shows at its field.
    const rule = password ? passwordRuleBroken(password) : "passwordRequired";
    if (!name.trim() || rule) {
      handle({
        kind: "invalid",
        ...(name.trim() ? {} : { name: "nameRequired" as const }),
        ...(rule ? { password: rule } : {}),
      });
      return;
    }
    setErrors({});
    void send({ name, password });
  };

  const retry = token ? (
    <div>
      <Button variant="secondary" onClick={() => void look(token)}>
        {t("common.retry")}
      </Button>
    </div>
  ) : null;

  // Always on the page, so "Sending" is announced while the button keeps focus.
  const sending = (
    <VisuallyHidden role="status">{busy ? t("invitation.sending") : ""}</VisuallyHidden>
  );

  return <div ref={containerRef}>{body()}</div>;

  function body(): ReactNode {
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
        return found(view);
    }
  }

  function found(invitation: Found): ReactNode {
    const intro = (
      <div className="flex flex-col gap-2">
        <ViewHeading>
          {t("invitation.found.title", { organisation: invitation.organisationName })}
        </ViewHeading>
        {invitation.emailMasked ? (
          <p className="m-0">{t("invitation.found.sentTo", { email: invitation.emailMasked })}</p>
        ) : null}
        <p className="m-0 text-text-secondary">
          {t("invitation.found.expires", { when: invitation.expiresAt })}
        </p>
      </div>
    );

    if (invitation.path === "sign_in_first") return <SignInFirst intro={intro} />;

    const problem =
      formError || errors.name || errors.password ? (
        <div
          ref={summaryRef}
          role="alert"
          tabIndex={-1}
          aria-labelledby="invitation-problem"
          className="flex gap-3 rounded-input border-s-4 border-danger bg-bg-secondary p-4"
        >
          <CircleAlert size={20} strokeWidth={1.5} aria-hidden="true" className="mt-0.5 shrink-0" />
          <div className="flex flex-col gap-1">
            <h3 id="invitation-problem" className="m-0 text-body font-semibold">
              {t("invitation.form.problem")}
            </h3>
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

    if (invitation.path === "link_signed_in") {
      return (
        <Card>
          <div className="flex flex-col gap-4">
            {intro}
            {problem}
            <p className="m-0">{t("invitation.join.body")}</p>
            <div>
              <Button aria-disabled={busy || undefined} onClick={() => void send({})}>
                {t("invitation.join.submit")}
              </Button>
              {sending}
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
            aria-disabled={busy || undefined}
            icon={<KeyRound size={18} strokeWidth={1.5} />}
          >
            {t("invitation.form.submit")}
          </Button>
          {sending}
        </form>
      </Card>
    );
  }
}

/** A sign-in already exists for the address: sign in, then this page picks the invitation up. */
function SignInFirst({ intro }: { readonly intro?: ReactNode }) {
  const message = (
    <Message icon={<Info size={20} strokeWidth={1.5} />} title={t("invitation.signInFirst.title")}>
      <p className="m-0">{t("invitation.signInFirst.body")}</p>
      <div>
        <ButtonLink href={SIGN_IN_THEN_RETURN}>{t("auth.signIn.submit")}</ButtonLink>
      </div>
    </Message>
  );
  if (!intro) return message;
  return (
    <Card>
      <div className="flex flex-col gap-4">
        {intro}
        {message}
      </div>
    </Card>
  );
}
