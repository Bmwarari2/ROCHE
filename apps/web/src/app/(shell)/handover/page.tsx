import { PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { getShellContext } from "@/lib/api";
import { handoverShown } from "@/lib/handover";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: t("care.handover.title") };

/** Handover: the chosen location's, or which location when the shell shows every one. */
export default async function HandoverIndexPage() {
  const { me, locationId } = await getShellContext();
  const title = t("care.handover.title");
  if (!handoverShown(me.permissions)) return <SafetyForbidden title={title} />;
  if (locationId) redirect(`/handover/${locationId}`);
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={me.tenant.name}
        title={title}
        description={t("care.handover.chooseLocation")}
      />
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {me.locations.map((location) => (
          <li key={location.id}>
            <Link
              href={`/handover/${location.id}`}
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
