import { PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { getShellContext } from "@/lib/api";
import { t } from "@/lib/i18n";
import { rotaHomePage, rotaShown } from "@/lib/rota";

export const metadata: Metadata = { title: t("rota.title") };

/** The rota: the chosen home's, or which home when the shell shows every one. */
export default async function RotaIndexPage() {
  const { me, locationId } = await getShellContext();
  const title = t("rota.title");
  if (!rotaShown(me.permissions)) return <SafetyForbidden title={title} />;
  if (locationId) redirect(rotaHomePage(locationId));
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader eyebrow={me.tenant.name} title={title} description={t("rota.chooseHome")} />
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {me.locations.map((location) => (
          <li key={location.id}>
            <Link
              href={rotaHomePage(location.id)}
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
