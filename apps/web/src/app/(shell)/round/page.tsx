import { PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { getShellContext } from "@/lib/api";
import { t } from "@/lib/i18n";
import { roundShown } from "@/lib/round";

export const metadata: Metadata = { title: t("care.round.title") };

/** The round: the chosen location's, or which location when the shell shows every one. */
export default async function RoundIndexPage() {
  const { me, locationId } = await getShellContext();
  const title = t("care.round.title");
  if (!roundShown(me.permissions)) return <SafetyForbidden title={title} />;
  if (locationId) redirect(`/round/${locationId}`);
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader eyebrow={me.tenant.name} title={title} description={t("care.round.choose")} />
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {me.locations.map((location) => (
          <li key={location.id}>
            <Link
              href={`/round/${location.id}`}
              className="inline-flex min-h-target items-center underline"
            >
              {location.name}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
