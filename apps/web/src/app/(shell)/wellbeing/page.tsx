import { Card, PageHeader, StatusChip } from "@harbour/ui";
import { Lock, Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ArrivalNotice } from "@/components/care/ArrivalNotice";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { CheckInForm, ShareToggle, ThanksForm } from "@/components/scheduling/WellbeingForms";
import { getShellContext, tenantApi } from "@/lib/api";
import { formatDate, formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { toAnswer, wellbeingAccess } from "@/lib/wellbeing";

export const metadata: Metadata = { title: t("scheduling.wellbeing.title") };

/**
 * Wellbeing (SCHED-011, slice 61; scheduling.md section 16): the surveys a member may answer, their
 * own check-ins (private unless they choose to share each one with their manager) and thanks to and
 * from colleagues. Managers are linked to surveys and to what their teams share.
 */
export default async function WellbeingPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ done?: string | string[]; thanksAt?: string | string[] }>;
}) {
  const { done, thanksAt } = await searchParams;
  const { me, locationId } = await getShellContext();
  const title = t("scheduling.wellbeing.title");
  const access = wellbeingAccess(me.permissions);
  if (!access.self && !access.manage) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const places = me.locations.map((l) => ({ value: l.id, label: l.name }));
  // Colleagues are read for one home at a time: the one chosen, the current one, or the only one.
  const thanksPlace =
    typeof thanksAt === "string" && me.locations.some((l) => l.id === thanksAt)
      ? thanksAt
      : (locationId ?? (me.locations.length === 1 ? (me.locations[0]?.id ?? null) : null));
  const [surveys, checkIns, received, sent, colleagueList] = access.self
    ? await Promise.all([
        api.GET("/v1/pulse-surveys", { params: { query: { view: "answer" } } }),
        api.GET("/v1/wellbeing-check-ins", { params: { query: {} } }),
        api.GET("/v1/recognition", { params: { query: { mine: "received" } } }),
        api.GET("/v1/recognition", { params: { query: { mine: "sent" } } }),
        thanksPlace
          ? api.GET("/v1/recognition/colleagues", {
              params: { query: { locationId: thanksPlace } },
            })
          : null,
      ])
    : [];
  const colleagues = (colleagueList?.data?.items ?? []).map((c) => ({
    value: c.id,
    label: c.name,
  }));
  const open = toAnswer(surveys?.data?.items ?? []);
  const answered = (surveys?.data?.items ?? []).filter((s) => s.answered === true);

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={me.tenant.name}
        title={title}
        description={t("scheduling.wellbeing.description")}
      />
      {done === "answered" ? (
        <ArrivalNotice>{t("scheduling.wellbeing.answer.arrived")}</ArrivalNotice>
      ) : null}
      {access.manage ? (
        <nav aria-label={t("scheduling.wellbeing.sections")}>
          <ul className="m-0 flex list-none flex-wrap gap-4 p-0">
            <li>
              <Link
                href="/wellbeing/surveys"
                className="inline-flex min-h-target items-center underline"
              >
                {t("scheduling.wellbeing.surveys.title")}
              </Link>
            </li>
            <li>
              <Link
                href="/wellbeing/team"
                className="inline-flex min-h-target items-center underline"
              >
                {t("scheduling.wellbeing.team.title")}
              </Link>
            </li>
          </ul>
        </nav>
      ) : null}

      {access.self ? (
        <>
          <Card as="section" aria-labelledby="surveys">
            <div className="flex flex-col gap-3">
              <h2 id="surveys" className="hb-card__title">
                {t("scheduling.wellbeing.toAnswer.title")}
              </h2>
              {open.length === 0 ? (
                <p className="m-0">{t("scheduling.wellbeing.toAnswer.none")}</p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {open.map((s) => (
                    <li key={s.id}>
                      <Link
                        href={`/wellbeing/surveys/${s.id}/answer`}
                        className="inline-flex min-h-target items-center underline"
                      >
                        {t("scheduling.wellbeing.toAnswer.link", {
                          title: s.title,
                          closes: formatDate(s.closesOn) ?? "",
                        })}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              {answered.length > 0 ? (
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {answered.map((s) => (
                    <li key={s.id} className="flex flex-wrap items-center gap-2">
                      <StatusChip
                        status="done"
                        label={t("scheduling.wellbeing.toAnswer.answered")}
                      />
                      <span>{s.title}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </Card>

          <Card as="section" aria-labelledby="check-ins">
            <div className="flex flex-col gap-4">
              <h2 id="check-ins" className="hb-card__title">
                {t("scheduling.wellbeing.checkIn.title")}
              </h2>
              <p className="m-0">{t("scheduling.wellbeing.checkIn.intro")}</p>
              {checkIns?.data?.support ? (
                <p className="m-0 font-semibold">{checkIns.data.support}</p>
              ) : null}
              {places.length === 0 ? (
                <p className="m-0">{t("scheduling.wellbeing.noHomes")}</p>
              ) : (
                <CheckInForm places={places} />
              )}
              <h3 className="m-0 text-heading-sm">{t("scheduling.wellbeing.checkIn.mine")}</h3>
              {(checkIns?.data?.items ?? []).length === 0 ? (
                <p className="m-0">{t("scheduling.wellbeing.checkIn.none")}</p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-4 p-0">
                  {(checkIns?.data?.items ?? []).map((c) => (
                    <li
                      key={c.id}
                      className="flex flex-col gap-2 border-t border-border-subtle pt-3"
                    >
                      <p id={`check-in-${c.id}`} className="m-0 font-semibold">
                        {t("scheduling.wellbeing.checkIn.line", {
                          time: formatDateTime(c.createdAt) ?? "",
                          mood: c.mood,
                        })}
                      </p>
                      {c.note ? <p className="m-0 whitespace-pre-wrap">{c.note}</p> : null}
                      <div>
                        <StatusChip
                          status={c.sharedAt ? "info" : "neutral"}
                          icon={c.sharedAt ? Users : Lock}
                          label={t("scheduling.wellbeing.checkIn.sharedState", {
                            shared: c.sharedAt ? "yes" : "no",
                          })}
                        />
                      </div>
                      <ShareToggle
                        checkInId={c.id}
                        shared={c.sharedAt !== null}
                        describedBy={`check-in-${c.id}`}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>

          <Card as="section" aria-labelledby="thanks">
            <div className="flex flex-col gap-4">
              <h2 id="thanks" className="hb-card__title">
                {t("scheduling.wellbeing.thanks.title")}
              </h2>
              <p className="m-0">{t("scheduling.wellbeing.thanks.intro")}</p>
              {places.length === 0 ? (
                <p className="m-0">{t("scheduling.wellbeing.noHomes")}</p>
              ) : (
                <ThanksForm places={places} place={thanksPlace} colleagues={colleagues} />
              )}
              <h3 className="m-0 text-heading-sm">{t("scheduling.wellbeing.thanks.received")}</h3>
              {(received?.data?.items ?? []).length === 0 ? (
                <p className="m-0">{t("scheduling.wellbeing.thanks.noneReceived")}</p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-3 p-0">
                  {(received?.data?.items ?? []).map((r) => (
                    <li key={r.id} className="flex flex-col gap-1">
                      <p className="m-0 font-semibold">
                        {t("scheduling.wellbeing.thanks.from", {
                          name: r.fromName ?? t("scheduling.wellbeing.nameNotHeld"),
                          time: formatDateTime(r.createdAt) ?? "",
                        })}
                      </p>
                      <p className="m-0 whitespace-pre-wrap">{r.message}</p>
                    </li>
                  ))}
                </ul>
              )}
              <h3 className="m-0 text-heading-sm">{t("scheduling.wellbeing.thanks.sent")}</h3>
              {(sent?.data?.items ?? []).length === 0 ? (
                <p className="m-0">{t("scheduling.wellbeing.thanks.noneSent")}</p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-3 p-0">
                  {(sent?.data?.items ?? []).map((r) => (
                    <li key={r.id} className="flex flex-col gap-1">
                      <p className="m-0 font-semibold">
                        {t("scheduling.wellbeing.thanks.to", {
                          name: r.toName ?? t("scheduling.wellbeing.nameNotHeld"),
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
      ) : null}
    </div>
  );
}
