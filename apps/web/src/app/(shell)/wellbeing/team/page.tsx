import { Card, PageHeader } from "@harbour/ui";
import { Check } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { getShellContext, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { wellbeingAccess } from "@/lib/wellbeing";

export const metadata: Metadata = { title: t("scheduling.wellbeing.team.title") };

/**
 * What a home's staff share (scheduling.md section 16 rules 5 and 6): thanks to members at the
 * home, and the check-ins members chose to share, only while shared. Never a score, a ranking or a
 * referral. Viewing is audited by the API.
 */
export default async function WellbeingTeamPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ at?: string | string[] }>;
}) {
  const { at } = await searchParams;
  const { me, locationId } = await getShellContext();
  const title = t("scheduling.wellbeing.team.title");
  if (!wellbeingAccess(me.permissions).manage) return <SafetyForbidden title={title} />;
  const chosen =
    typeof at === "string" && isUuid(at) && me.locations.some((l) => l.id === at)
      ? at
      : (locationId ?? (me.locations.length === 1 ? (me.locations[0]?.id ?? null) : null));
  const api = await tenantApi();
  const [thanks, shared] = chosen
    ? await Promise.all([
        api.GET("/v1/recognition", { params: { query: { locationId: chosen } } }),
        api.GET("/v1/wellbeing-check-ins", { params: { query: { locationId: chosen } } }),
      ])
    : [null, null];
  const name = (value: string | null) => value ?? t("scheduling.wellbeing.nameNotHeld");

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={me.tenant.name}
        title={title}
        description={t("scheduling.wellbeing.team.description")}
      />
      <p className="m-0">
        <Link href="/wellbeing" className="inline-flex min-h-target items-center underline">
          {t("scheduling.wellbeing.back")}
        </Link>
      </p>
      {me.locations.length > 1 ? (
        <nav aria-label={t("scheduling.wellbeing.team.choose")}>
          <ul className="m-0 flex list-none flex-wrap gap-4 p-0">
            {me.locations.map((l) => (
              <li key={l.id}>
                <Link
                  href={`/wellbeing/team?at=${l.id}`}
                  aria-current={l.id === chosen ? "page" : undefined}
                  className={
                    l.id === chosen
                      ? "inline-flex min-h-target items-center gap-1 font-semibold no-underline"
                      : "inline-flex min-h-target items-center underline"
                  }
                >
                  {l.id === chosen ? (
                    <Check size={16} strokeWidth={1.5} aria-hidden="true" />
                  ) : null}
                  {l.name}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
      {!chosen ? (
        <p className="m-0">{t("scheduling.wellbeing.team.chooseFirst")}</p>
      ) : (
        <>
          <p className="m-0 font-semibold">
            {t("scheduling.wellbeing.team.showing", {
              home: me.locations.find((l) => l.id === chosen)?.name ?? "",
            })}
          </p>
          <Card as="section" aria-labelledby="shared">
            <div className="flex flex-col gap-3">
              <h2 id="shared" className="hb-card__title">
                {t("scheduling.wellbeing.team.shared")}
              </h2>
              <p className="m-0">{t("scheduling.wellbeing.team.sharedIntro")}</p>
              {!shared?.data ? (
                <p className="m-0">{t("care.errors.unavailable")}</p>
              ) : shared.data.items.length === 0 ? (
                <p className="m-0">{t("scheduling.wellbeing.team.noneShared")}</p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-3 p-0">
                  {shared.data.items.map((c) => (
                    <li
                      key={c.id}
                      className="flex flex-col gap-1 border-t border-border-subtle pt-3"
                    >
                      <p className="m-0 font-semibold">
                        {t("scheduling.wellbeing.team.sharedLine", {
                          name: name(c.memberName),
                          time: formatDateTime(c.createdAt) ?? "",
                          mood: c.mood,
                        })}
                      </p>
                      {c.note ? <p className="m-0 whitespace-pre-wrap">{c.note}</p> : null}
                    </li>
                  ))}
                </ul>
              )}
              {shared?.data?.support ? (
                <p className="m-0 text-body-dense text-text-secondary">{shared.data.support}</p>
              ) : null}
            </div>
          </Card>
          <Card as="section" aria-labelledby="team-thanks">
            <div className="flex flex-col gap-3">
              <h2 id="team-thanks" className="hb-card__title">
                {t("scheduling.wellbeing.team.thanks")}
              </h2>
              {!thanks?.data ? (
                <p className="m-0">{t("care.errors.unavailable")}</p>
              ) : thanks.data.items.length === 0 ? (
                <p className="m-0">{t("scheduling.wellbeing.team.noThanks")}</p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-3 p-0">
                  {thanks.data.items.map((r) => (
                    <li key={r.id} className="flex flex-col gap-1">
                      <p className="m-0 font-semibold">
                        {t("scheduling.wellbeing.team.thanksLine", {
                          from: name(r.fromName),
                          to: name(r.toName),
                          time: formatDateTime(r.createdAt) ?? "",
                        })}
                      </p>
                      <p className="m-0 whitespace-pre-wrap">{r.message}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
