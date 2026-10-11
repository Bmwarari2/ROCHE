import { Card } from "@harbour/ui";
import { ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import { t } from "@/lib/i18n";
import { safeNextPath } from "@/lib/problems";
import { SignInForm } from "./SignInForm";

export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const nextPath = safeNextPath(params.next) ?? "/";
  const stepUp = params.reason === "step-up";

  return (
    <>
      <h1 className="m-0 text-title">{t("auth.signIn.title")}</h1>
      {stepUp ? (
        <div
          role="status"
          className="flex gap-3 rounded-card border border-border bg-card p-4 text-callout"
        >
          <ShieldCheck size={20} strokeWidth={1.5} aria-hidden="true" className="shrink-0" />
          <div>
            <p className="m-0 font-semibold">{t("auth.stepUp.title")}</p>
            <p className="m-0 text-text-secondary">{t("auth.stepUp.body")}</p>
          </div>
        </div>
      ) : null}
      <Card>
        <SignInForm
          nextPath={nextPath}
          labels={{
            email: t("auth.signIn.email"),
            password: t("auth.signIn.password"),
            submit: t("auth.signIn.submit"),
            passkey: t("auth.signIn.passkey"),
            totpTitle: t("auth.totp.title"),
            totpHint: t("auth.totp.hint"),
          }}
        />
      </Card>
    </>
  );
}
