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
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: t("security.title") };

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
      <PageHeader title={t("security.title")} description={t("security.description")} />

      {reason === "mfa" ? (
        <div
          role="alert"
          className="flex gap-3 rounded-card border border-border border-s-[4px] border-s-warning bg-card p-4"
        >
          <ShieldAlert size={24} strokeWidth={1.5} aria-hidden="true" className="shrink-0" />
          <div className="flex flex-col gap-1">
            <p className="m-0 font-semibold">{t("security.mfaRequired.title")}</p>
            <p className="m-0 text-text-secondary">{t("security.mfaRequired.body")}</p>
          </div>
        </div>
      ) : null}

      <Card
        as="section"
        title={t("security.totp.title")}
        description={t("security.totp.description")}
        actions={
          totpEnabled ? (
            <StatusChip status="done" label={t("security.totp.on")} />
          ) : (
            <StatusChip status="due" label={t("security.totp.off")} />
          )
        }
      >
        {totpEnabled ? <p className="m-0">{t("security.totp.enabled")}</p> : <TotpSetup />}
      </Card>

      <Card
        as="section"
        title={t("security.passkeys.title")}
        description={t("security.passkeys.description")}
        actions={
          passkeys.length > 0 ? (
            <StatusChip
              status="done"
              label={t("security.passkeys.count", { count: passkeys.length })}
            />
          ) : (
            <StatusChip status="neutral" label={t("security.passkeys.none")} />
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
                  <span className="font-semibold">
                    {passkey.name || t("security.passkeys.unnamed")}
                  </span>
                  <span className="text-callout text-text-secondary">
                    {t("security.passkeys.addedOn", {
                      date: formatDateTime(passkey.createdAt) ?? "",
                    })}
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
        title={t("security.sessions.title")}
        description={t("security.sessions.description")}
      >
        <div className="flex flex-col gap-4">
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {ordered.map((session) => {
              const device = describeDevice(session.device, t);
              const signedIn = formatDateTime(session.createdAt) ?? "";
              const { current } = session;
              return (
                <li
                  key={session.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-input border border-border px-4 py-3"
                >
                  <div className="flex flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-2 font-semibold">
                      {device}
                      {current ? (
                        <StatusChip status="info" label={t("security.sessions.current")} />
                      ) : null}
                    </span>
                    <span className="text-callout text-text-secondary">
                      {t("security.sessions.times", {
                        signedIn,
                        lastActive: formatDateTime(session.lastActiveAt) ?? "",
                      })}
                    </span>
                  </div>
                  {current ? null : (
                    <form action={revokeSession}>
                      <input type="hidden" name="sessionId" value={session.id} />
                      <Button type="submit" variant="secondary">
                        {t("security.sessions.signOut")}
                        <VisuallyHidden>
                          {t("security.sessions.signOutDetail", { device, signedIn })}
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
                {t("security.sessions.signOutOthers")}
              </Button>
            </form>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
