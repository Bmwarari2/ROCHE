import { Button, Card, PageHeader, StatusChip, VisuallyHidden } from "@harbour/ui";
import { ShieldAlert } from "lucide-react";
import type { Metadata } from "next";
import { revokeOtherSessions, revokeSession } from "@/app/actions/security";
import { AddPasskey } from "@/components/security/AddPasskey";
import { TotpSetup } from "@/components/security/TotpSetup";
import { getShellContext } from "@/lib/api";
import { getAuthSession, listDeviceSessions, listPasskeys } from "@/lib/auth-server";
import { describeDevice } from "@/lib/devices";
import { formatDateTime } from "@/lib/format";

export const metadata: Metadata = { title: "Sign-in and security" };

/**
 * Sign-in and security (section 5.3): an authenticator app (TOTP), passkeys, and the devices that
 * are signed in. People who can read care records must set up one of the first two; the API sends
 * them here with ?reason=mfa until they do.
 */
export default async function SecurityPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ reason }, , auth, sessions, passkeys] = await Promise.all([
    searchParams,
    getShellContext(),
    getAuthSession(),
    listDeviceSessions(),
    listPasskeys(),
  ]);
  const totpEnabled = auth?.user.twoFactorEnabled === true;
  const others = sessions.filter((s) => !s.current);
  const ordered = [
    ...sessions.filter((s) => s.current),
    ...others.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt)),
  ];

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        title="Sign-in and security"
        description="Choose how you prove it is you, and see where you are signed in."
      />

      {reason === "mfa" ? (
        <div
          role="alert"
          className="flex gap-3 rounded-card border border-border border-s-[4px] border-s-warning bg-card p-4"
        >
          <ShieldAlert size={24} strokeWidth={1.5} aria-hidden="true" className="shrink-0" />
          <div className="flex flex-col gap-1">
            <p className="m-0 font-semibold">Set up a second way to sign in</p>
            <p className="m-0 text-text-secondary">
              Set up an authenticator app or a passkey before you open care records. It keeps
              people's information safe if your password is ever lost or guessed.
            </p>
          </div>
        </div>
      ) : null}

      <Card
        as="section"
        title="Authenticator app"
        description="A 6-digit code from an app on your phone, asked for when you sign in."
        actions={
          totpEnabled ? (
            <StatusChip status="done" label="Set up" />
          ) : (
            <StatusChip status="due" label="Not set up" />
          )
        }
      >
        {totpEnabled ? (
          <p className="m-0">
            Your authenticator app is set up. If you change phone, set it up again on the new one.
          </p>
        ) : (
          <TotpSetup />
        )}
      </Card>

      <Card
        as="section"
        title="Passkeys"
        description="Sign in with your fingerprint, face or device PIN instead of a password."
        actions={
          passkeys.length > 0 ? (
            <StatusChip
              status="done"
              label={passkeys.length === 1 ? "1 passkey" : `${passkeys.length} passkeys`}
            />
          ) : (
            <StatusChip status="neutral" label="None yet" />
          )
        }
      >
        <div className="flex flex-col gap-6">
          {passkeys.length > 0 ? (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {passkeys.map((passkey) => (
                <li
                  key={passkey.id}
                  className="flex flex-wrap items-baseline justify-between gap-2 rounded-input border border-border px-4 py-3"
                >
                  <span className="font-semibold">{passkey.name || "Passkey"}</span>
                  <span className="text-callout text-text-secondary">
                    Added {formatDateTime(passkey.createdAt) ?? ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          <AddPasskey />
        </div>
      </Card>

      <Card
        as="section"
        title="Where you are signed in"
        description="Sign out of any device you do not recognise or no longer use."
      >
        <div className="flex flex-col gap-4">
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {ordered.map((session) => {
              const device = describeDevice(session.device);
              const { current } = session;
              return (
                <li
                  key={session.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-input border border-border px-4 py-3"
                >
                  <div className="flex flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-2 font-semibold">
                      {device}
                      {current ? <StatusChip status="info" label="This device" /> : null}
                    </span>
                    <span className="text-callout text-text-secondary">
                      Signed in {formatDateTime(session.createdAt) ?? ""}. Last active{" "}
                      {formatDateTime(session.lastActiveAt) ?? ""}.
                    </span>
                  </div>
                  {current ? null : (
                    <form action={revokeSession}>
                      <input type="hidden" name="sessionId" value={session.id} />
                      <Button type="submit" variant="secondary">
                        Sign out of this device
                        <VisuallyHidden>
                          : {device}, signed in {formatDateTime(session.createdAt) ?? ""}
                        </VisuallyHidden>
                      </Button>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
          {others.length > 0 ? (
            <form action={revokeOtherSessions}>
              <Button type="submit" variant="destructive">
                Sign out of all other devices
              </Button>
            </form>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
