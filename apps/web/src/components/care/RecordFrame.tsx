import { EmptyState } from "@harbour/ui";
import { FileWarning, Lock, SearchX } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { BreakGlass } from "@/components/people/BreakGlass";
import { PersonHeader } from "@/components/people/PersonHeader";
import { getShellContext } from "@/lib/api";
import { can, type RecordTab, visibleTabs } from "@/lib/care-record";
import { peopleLabel, t } from "@/lib/i18n";
import {
  BREAK_GLASS_MAX_LENGTH,
  BREAK_GLASS_MIN_LENGTH,
  canBreakGlass,
  personNames,
} from "@/lib/people";
import { getCareProfile, getPerson } from "@/lib/person-record";
import type { CareProfileLoad } from "@/lib/record-data";
import { BREAK_GLASS_REASON_CODES } from "@/lib/search";
import { formatUkTime } from "@/lib/uk-time";
import { RecordTabs } from "./RecordTabs";

/**
 * A person's record (docs/specs/care.md, slice 9): the point-of-care header above tabs for each
 * section, then the tab. Every tab's page renders this frame itself, so moving to another tab
 * reads the header again from the API (a shared layout would keep the header it drew first; a
 * colleague's change, such as a withdrawn DNACPR, would stay hidden: HZ-002, HZ-015). The header
 * also says when it was read and reads itself again while the page is open.
 */
export async function RecordFrame({
  personId,
  tab,
  children,
}: {
  readonly personId: string;
  readonly tab: RecordTab;
  readonly children: ReactNode;
}) {
  const { me } = await getShellContext();
  const { person, code } = await getPerson(personId);
  const people = peopleLabel(me.tenant.terminology);

  if (!person) {
    const forbidden = code === "missing_permission";
    const unreadable = code === "unreadable";
    return (
      <div className="mx-auto flex w-full max-w-content flex-col gap-6 py-6">
        <EmptyState
          headingLevel={1}
          icon={
            forbidden ? (
              <Lock size={40} strokeWidth={1.5} aria-hidden="true" />
            ) : unreadable ? (
              <FileWarning size={40} strokeWidth={1.5} aria-hidden="true" />
            ) : (
              <SearchX size={40} strokeWidth={1.5} aria-hidden="true" />
            )
          }
          title={
            forbidden
              ? t("errors.forbidden")
              : unreadable
                ? t("care.header.unreadable.title")
                : t("errors.notFound")
          }
          description={
            forbidden
              ? undefined
              : unreadable
                ? t("care.header.unreadable.body")
                : t("people.notFound.body")
          }
          action={
            !forbidden && !unreadable && canBreakGlass(me.permissions) ? (
              <BreakGlass
                personId={personId}
                labels={{
                  title: t("people.breakGlass.title"),
                  body: t("people.breakGlass.body"),
                  justification: t("people.breakGlass.justification"),
                  hint: t("people.breakGlass.hint", { min: BREAK_GLASS_MIN_LENGTH }),
                  reasonCode: t("people.breakGlass.reasonCode"),
                  chooseReason: t("platform.breakGlassSearch.chooseReason"),
                  reasonOptions: BREAK_GLASS_REASON_CODES.map((code) => ({
                    value: code,
                    label: t("platform.breakGlassSearch.reasonOption", { code }),
                  })),
                  noReasonCode: t("people.breakGlass.noReasonCode"),
                  submit: t("people.breakGlass.submit"),
                  cancel: t("common.cancel"),
                  close: t("common.close"),
                  stepUpTitle: t("auth.stepUp.title"),
                  stepUpBody: t("auth.stepUp.body"),
                  stepUpReason: t("people.breakGlass.stepUpReason"),
                  signInAgain: t("people.breakGlass.signInAgain"),
                  failure: {
                    "too-short": t("people.breakGlass.tooShort", { min: BREAK_GLASS_MIN_LENGTH }),
                    "too-long": t("people.breakGlass.tooLong", { max: BREAK_GLASS_MAX_LENGTH }),
                    forbidden: t("people.breakGlass.forbidden"),
                    "not-found": t("people.breakGlass.notFound"),
                    unavailable: t("people.breakGlass.unavailable"),
                  },
                }}
              />
            ) : null
          }
          secondaryAction={
            <Link href="/people" className="hb-button hb-button--tertiary">
              <span className="hb-button__label">
                {t("people.list.back", { terminology: me.tenant.terminology })}
              </span>
              <span className="hb-button__chevron" aria-hidden="true">
                ›
              </span>
            </Link>
          }
        />
      </div>
    );
  }

  const careProfile: CareProfileLoad = can(me.permissions, "care.plan.read")
    ? await getCareProfile(personId)
    : { kind: "no_access" };
  const checkedAt = new Date().toISOString();
  const location = me.locations.find((l) => l.id === person.locationId);
  const names = personNames(person);
  const tabs = visibleTabs(personId, me.permissions).map((item) => ({
    ...item,
    label: t(`care.tabs.${item.tab}`),
  }));

  // The breadcrumb's last item is plain text: the tabs mark the current page. The link is
  // underlined, so it stands out from the name beside it without relying on colour (in the dark
  // theme the two colours are too close to tell apart).
  return (
    <div className="flex w-full min-w-0 flex-col gap-6">
      <nav aria-label={t("common.breadcrumb")} className="text-body-dense">
        <Link href="/people" className="underline">
          {people}
        </Link>
        <span aria-hidden="true" className="px-2 text-text-secondary">
          ›
        </span>
        <span>{names.hasPreferred ? names.preferred : names.full}</span>
      </nav>
      <PersonHeader
        person={person}
        locationName={location?.name ?? null}
        careProfile={careProfile}
        checkedAt={checkedAt}
        checkedLabel={formatUkTime(checkedAt) ?? ""}
      />
      <RecordTabs
        label={t("care.tabs.label", { name: names.preferred })}
        items={tabs}
        current={tab}
      />
      <div className="flex min-w-0 flex-col gap-6">{children}</div>
    </div>
  );
}
