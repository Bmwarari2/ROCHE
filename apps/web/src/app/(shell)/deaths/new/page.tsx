import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { OpenDeathForm } from "@/components/safety-events/DeathForms";
import { getShellContext } from "@/lib/api";
import { canManageDeaths, exitRecordFrom } from "@/lib/deaths";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: t("deaths.new.title") };

/**
 * Opening a death record (SAFE-014) from the exit record that says the person died
 * (`?exitRecord=`). Opening is a button, never a page load, so following a link changes nothing.
 */
export default async function NewDeathPage({
  searchParams,
}: {
  searchParams: Promise<{ exitRecord?: string }>;
}) {
  const { exitRecord } = await searchParams;
  const { me } = await getShellContext();
  const title = t("deaths.new.title");
  if (!canManageDeaths(me.permissions)) return <SafetyForbidden title={title} />;
  const exitRecordId = exitRecordFrom(exitRecord);
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader title={title} description={t("deaths.new.description")} />
      <Card>
        {exitRecordId ? (
          <OpenDeathForm exitRecordId={exitRecordId} />
        ) : (
          <p className="m-0">{t("deaths.new.noExitRecord")}</p>
        )}
      </Card>
    </div>
  );
}
