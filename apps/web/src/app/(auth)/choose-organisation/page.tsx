import { Card, EmptyState } from "@harbour/ui";
import { Building2, ChevronRight } from "lucide-react";
import type { Metadata } from "next";
import { chooseOrganisation } from "@/app/actions/context";
import { failWith, serverApi } from "@/lib/api";
import { t } from "@/lib/i18n";
import { safeNextPath } from "@/lib/problems";
import { SignOutButton } from "./SignOutButton";

export const metadata: Metadata = { title: "Choose an organisation" };

/** For people who work for more than one provider: pick the organisation to act for. */
export default async function ChooseOrganisationPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const nextPath = safeNextPath(params.next) ?? "/";
  const api = await serverApi();
  const { data, error, response } = await api.GET("/v1/memberships");
  if (!data) failWith(error, response, "/choose-organisation");

  if (data.items.length === 0) {
    return (
      <Card>
        <EmptyState
          headingLevel={1}
          icon={<Building2 size={32} strokeWidth={1.5} aria-hidden="true" />}
          title="You are not part of an organisation yet"
          description="Ask your manager to invite you to Harbour. You can sign out and come back when they have."
          action={<SignOutButton label={t("common.signOut")} />}
        />
      </Card>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="m-0 text-title">Choose an organisation</h1>
        <p className="m-0 text-body text-text-secondary">
          You work for more than one organisation. Choose the one you are working for now. You can
          switch at any time from the bar at the top of the page.
        </p>
      </div>
      <Card padding="none">
        <ul className="m-0 list-none divide-y divide-border p-0">
          {data.items.map((membership) => (
            <li key={membership.tenantId}>
              <form action={chooseOrganisation}>
                <input type="hidden" name="tenantId" value={membership.tenantId} />
                <input type="hidden" name="next" value={nextPath} />
                <button
                  type="submit"
                  className="flex min-h-target w-full cursor-pointer items-center gap-3 border-0 bg-transparent px-6 py-4 text-start text-body text-text hover:bg-bg-secondary"
                >
                  <Building2
                    size={20}
                    strokeWidth={1.5}
                    aria-hidden="true"
                    className="text-text-secondary"
                  />
                  <span className="flex-1 font-semibold">{membership.tenantName}</span>
                  <ChevronRight
                    size={18}
                    strokeWidth={1.5}
                    aria-hidden="true"
                    className="text-text-secondary"
                  />
                </button>
              </form>
            </li>
          ))}
        </ul>
      </Card>
      <div>
        <SignOutButton label={t("common.signOut")} />
      </div>
    </>
  );
}
