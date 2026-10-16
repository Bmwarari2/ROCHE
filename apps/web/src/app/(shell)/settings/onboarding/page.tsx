import { isClinicalSetting } from "@harbour/domain";
import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  AcceptSetting,
  RecordDcb0160,
  RetentionDecision,
  StaffFileOption,
} from "@/components/onboarding/OnboardingDecisions";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { t } from "@/lib/i18n";
import { decisionFor, itemChip, MANAGE, ONBOARDING_PAGE, onboardingShown } from "@/lib/onboarding";
import { firstParam } from "@/lib/record-metadata";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata: Metadata = { title: t("onboarding.title") };

/**
 * The onboarding checklist (PLAT-018; platform-completions.md rules 26 and 27): every item worked
 * out from the organisation's records, never ticked by hand, each done or not as an icon and a
 * word, with whether it blocks go-live, the reason, and what is still outstanding. A holder of
 * platform.onboarding.manage records the decisions an item needs (a setting, a retention period,
 * the staff file option, the DCB0160 assessment) here; the API checks each again.
 */
export default async function OnboardingPage({
  searchParams,
}: {
  readonly searchParams: SearchParams;
}) {
  const { me } = await getShellContext();
  const title = t("onboarding.title");
  if (!onboardingShown(me.permissions)) return <SafetyForbidden title={title} />;
  const mayDecide = me.permissions.includes(MANAGE);
  const api = await tenantApi();
  const listed = await api.GET("/v1/onboarding");
  if (!listed.data) failWith(listed.error, listed.response, ONBOARDING_PAGE);
  const list = listed.data;
  const done = firstParam((await searchParams).done) === "decided";
  // Who may be named as having reviewed a clinical setting or made the DCB0160 assessment: the
  // organisation's active members (the API checks again; their roles are the CSO's to confirm).
  const members = mayDecide ? await api.GET("/v1/members") : null;
  const reviewers = (members?.data?.items ?? [])
    .filter((m) => m.state === "active")
    .map((m) => ({ id: m.id, name: m.displayName }));
  const settingValue = (key: string) => list.settings.find((s) => s.key === key) ?? null;

  const outstanding = (item: (typeof list.items)[number]): ReactNode => {
    if (item.key === "people_ready" && item.people && item.people.length > 0) {
      return (
        <ul className="m-0 flex flex-col gap-1 ps-5">
          {item.people.map((p, index) => (
            <li key={p.personId}>
              <Link href={`/people/${p.personId}`} className="inline-flex min-h-11 items-center">
                {t("onboarding.person", {
                  number: index + 1,
                  gaps: p.gaps.map((gap) => t("onboarding.gap", { gap })).join(", "),
                })}
              </Link>
            </li>
          ))}
        </ul>
      );
    }
    const kind = mayDecide ? decisionFor(item.key) : null;
    if (kind === "dcb0160")
      return (
        <RecordDcb0160 safetyCaseVersion={list.currentSafetyCaseVersion} reviewers={reviewers} />
      );
    if (!kind || item.outstanding.length === 0) return null;
    return (
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {item.outstanding.map((entry) => (
          <li key={entry} className="flex flex-col gap-2">
            {entry === "staff_file" ? (
              <StaffFileOption current={list.staffFileOption} version={list.version} />
            ) : (
              <>
                <p className="m-0 font-mono text-body-dense">{entry}</p>
                {kind === "setting" ? (
                  <AcceptSetting
                    rateKey={entry}
                    value={settingValue(entry)}
                    clinical={isClinicalSetting(entry)}
                    reviewers={reviewers}
                  />
                ) : (
                  <RetentionDecision recordClass={entry} />
                )}
              </>
            )}
          </li>
        ))}
      </ul>
    );
  };

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={me.tenant.name}
        title={title}
        description={t("onboarding.description")}
      />
      {done ? <RecordedArrival message={t("onboarding.decided")} param="done" /> : null}
      <Card as="section" title={t("onboarding.progress.title")} headingLevel={2}>
        <div className="flex flex-col gap-2">
          <p className="m-0">{t("onboarding.progress", { done: list.done, total: list.total })}</p>
          <p className="m-0 font-semibold">
            {list.readyForGoLive
              ? t("onboarding.ready")
              : t("onboarding.blocked", { count: list.blockers.length })}
          </p>
        </div>
      </Card>
      <Card as="section" title={t("onboarding.items.title")} headingLevel={2}>
        <ul className="m-0 flex list-none flex-col gap-4 p-0">
          {list.items.map((item) => (
            <li key={item.key} className="flex flex-col gap-2 border-b border-border pb-4">
              <h3 className="m-0 text-body font-semibold">
                {t("onboarding.item", { key: item.key })}
              </h3>
              <p className="m-0">
                <SafetyChip chip={itemChip(item, t)} />
              </p>
              <p className="m-0 text-body-dense">{item.reason}</p>
              {item.done ? null : outstanding(item)}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
