import { ButtonLink, Card, EmptyState, StatusChip } from "@harbour/ui";
import { Calendar, CalendarCheck, CircleAlert, Send, ShieldCheck, Users } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { SafetyChip } from "@/components/safety/SafetyChip";
import { formatDate, formatDateTime } from "@/lib/format";
import {
  DELIVERIES_SHOWN,
  deliveryChip,
  HR_LINK_PAGE,
  type HrLinkMay,
  linkChip,
  PAY_UNIT_KINDS,
  type PaySettings,
  type ReleaseMode,
  syncChip,
  unitKindWords,
  unmappedKinds,
} from "@/lib/hr-link";
import { t } from "@/lib/i18n";
import {
  CheckButtons,
  MatchReviewForm,
  PayCodesForm,
  PayRouteForm,
  ReleaseForm,
} from "./HrLinkForms";

/**
 * The sections of the link to the HR platform's settings page (integrations.md section 11;
 * slice 90; HZ-133, HZ-140), drawn from what the API gave, with no requests of their own, so
 * each linked state can be rendered and checked with axe where no link can be connected.
 */

const app = () => t("app.name");
const iconProps = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;
export const RELEASE_ANCHOR = "hr-release";

export function Fact({ term, children }: { readonly term: string; readonly children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
      <dt className="font-semibold">{term}</dt>
      <dd className="m-0">{children}</dd>
    </div>
  );
}

/** A date (yyyy-mm-dd) as dd/mm/yyyy in a `time` element. */
export function DateText({ value }: { readonly value: string }) {
  return <time dateTime={value}>{formatDate(value) ?? value}</time>;
}

/** An instant as dd/mm/yyyy hh:mm in UK time, in a `time` element. */
export function DateTimeText({ value }: { readonly value: string }) {
  return <time dateTime={value}>{formatDateTime(value) ?? value}</time>;
}

function Note({ icon, children }: { readonly icon: ReactNode; readonly children: ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  );
}

export interface StatusView {
  readonly connected: boolean;
  readonly status: string | null;
  readonly workspaceSlug: string | null;
  readonly stalenessMinutes: number;
  readonly matchesToReview: number;
  readonly leaversNotEnded: number;
  readonly staleness: {
    readonly stale: boolean;
    readonly lastGoodSyncAt: string | null;
    readonly lastErrorCode: string | null;
    readonly failures: number;
  } | null;
}

/** Where the link stands and how its syncs are going, in words with icons. */
export function StatusSection({
  link,
  may,
}: {
  readonly link: StatusView;
  readonly may: HrLinkMay;
}) {
  const staleness = link.staleness;
  return (
    <Card as="section" title={t("hrLink.status.title")} headingLevel={2}>
      <div className="flex flex-col gap-4">
        <p className="m-0 flex flex-wrap items-center gap-2">
          <SafetyChip chip={linkChip(link, t)} />
          {link.connected || staleness ? <SafetyChip chip={syncChip(staleness, t)} /> : null}
        </p>
        <dl className="m-0 flex flex-col gap-2">
          {link.workspaceSlug ? (
            <Fact term={t("hrLink.status.workspace")}>{link.workspaceSlug}</Fact>
          ) : null}
          {link.connected || staleness ? (
            <Fact term={t("hrLink.status.lastSync")}>
              {staleness?.lastGoodSyncAt ? (
                <DateTimeText value={staleness.lastGoodSyncAt} />
              ) : (
                t("hrLink.status.notYet")
              )}
            </Fact>
          ) : null}
          {staleness?.lastErrorCode ? (
            <Fact term={t("hrLink.status.lastProblem")}>
              {t("hrLink.reason", { code: staleness.lastErrorCode })}{" "}
              {t("hrLink.status.failures", { count: staleness.failures })}
            </Fact>
          ) : null}
          <Fact term={t("hrLink.status.limit")}>
            {t("hrLink.status.minutes", { count: link.stalenessMinutes })}
          </Fact>
          {may.review ? (
            <Fact term={t("hrLink.status.toReview")}>{String(link.matchesToReview)}</Fact>
          ) : null}
        </dl>
        {link.leaversNotEnded > 0 ? (
          <div role="note">
            <Note icon={<CircleAlert {...iconProps} />}>
              <p className="m-0">
                {t("hrLink.status.leaversNotEnded", { count: link.leaversNotEnded })}
              </p>
              <p className="m-0">
                <Link
                  href="/settings/team"
                  className="inline-flex min-h-target items-center underline"
                >
                  {t("hrLink.status.leaversLink")}
                </Link>
              </p>
            </Note>
          </div>
        ) : null}
        {may.manage && link.connected ? <CheckButtons /> : null}
      </div>
    </Card>
  );
}

export interface MatchView {
  readonly id: string;
  readonly version: number;
  readonly employeeNumber: string | null;
  readonly reason: string;
  readonly candidateStaffProfileId: string | null;
  readonly hrName: string | null;
  readonly hrWorkEmail: string | null;
  readonly leavingOn: string | null;
}

/** The match review queue: leavers first, each with its staff file to confirm, or reject. */
export function MatchesSection({
  items,
  staffFor,
}: {
  readonly items: readonly MatchView[];
  readonly staffFor: (
    candidate: string | null,
  ) => readonly { readonly id: string; readonly label: string }[];
}) {
  return (
    <Card as="section" title={t("hrLink.matches.title")} headingLevel={2}>
      <div className="flex flex-col gap-4">
        <p className="m-0 max-w-prose">{t("hrLink.matches.about", { app: app() })}</p>
        {items.length === 0 ? (
          <EmptyState
            headingLevel={3}
            icon={<Users size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("hrLink.matches.empty")}
          />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-4 p-0">
            {items.map((m) => {
              const who =
                m.hrName ?? t("hrLink.matches.employee", { number: m.employeeNumber ?? "" });
              return (
                <li key={m.id} className="flex flex-col gap-2 border-b border-border pb-4">
                  <h3 className="m-0 text-body font-semibold">{who}</h3>
                  <p className="m-0 flex flex-wrap items-center gap-2">
                    <StatusChip
                      status="due"
                      icon={CircleAlert}
                      label={t("hrLink.matches.reason", { reason: m.reason })}
                    />
                    {m.leavingOn ? (
                      <>
                        <StatusChip
                          status="info"
                          icon={Calendar}
                          label={t("hrLink.matches.leaving")}
                        />
                        <DateText value={m.leavingOn} />
                      </>
                    ) : null}
                  </p>
                  <dl className="m-0 flex flex-col gap-1 text-body-dense">
                    {m.employeeNumber ? (
                      <Fact term={t("hrLink.matches.number")}>{m.employeeNumber}</Fact>
                    ) : null}
                    {m.hrWorkEmail ? (
                      <Fact term={t("hrLink.matches.email")}>{m.hrWorkEmail}</Fact>
                    ) : null}
                  </dl>
                  <MatchReviewForm
                    id={m.id}
                    version={m.version}
                    who={who}
                    staff={staffFor(m.candidateStaffProfileId)}
                    suggested={m.candidateStaffProfileId}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}

export interface DeliveryView {
  readonly id: string;
  readonly kind: string;
  readonly state: string;
  readonly attempts: number;
  readonly lastErrorCode: string | null;
  readonly sentAt: string | null;
}

/** What was sent to the HR platform, newest first, each state in words with an icon. */
export function DeliveriesSection({ items }: { readonly items: readonly DeliveryView[] }) {
  return (
    <Card as="section" title={t("hrLink.deliveries.title")} headingLevel={2}>
      <div className="flex flex-col gap-3">
        <p className="m-0 max-w-prose">{t("hrLink.deliveries.about", { app: app() })}</p>
        {items.length === 0 ? (
          <EmptyState
            headingLevel={3}
            icon={<Send size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("hrLink.deliveries.empty")}
          />
        ) : (
          <>
            {items.length > DELIVERIES_SHOWN ? (
              <p className="m-0 text-body-dense">
                {t("hrLink.deliveries.latest", { count: DELIVERIES_SHOWN })}
              </p>
            ) : null}
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {items.slice(0, DELIVERIES_SHOWN).map((d) => (
                <li key={d.id} className="flex flex-col gap-1 border-b border-border pb-3">
                  <p className="m-0 flex flex-wrap items-center gap-2">
                    <span className="font-semibold">
                      {t("hrLink.deliveries.kind", { kind: d.kind })}
                    </span>
                    <SafetyChip chip={deliveryChip(d.state, t)} />
                  </p>
                  <p className="m-0 text-body-dense">
                    {t("hrLink.deliveries.attempts", { count: d.attempts })}
                    {d.sentAt ? (
                      <>
                        {". "}
                        {t("hrLink.deliveries.sentAt")} <DateTimeText value={d.sentAt} />
                      </>
                    ) : null}
                  </p>
                  {d.lastErrorCode ? (
                    <p className="m-0 text-body-dense">
                      {t("hrLink.reason", { code: d.lastErrorCode })}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Card>
  );
}

/** The route to payroll, any change waiting and from when, and the pay codes. */
export function PaySection({
  pay,
  version,
  may,
}: {
  readonly pay: PaySettings;
  readonly version: number | null;
  readonly may: HrLinkMay;
}) {
  const unmapped = unmappedKinds(pay.codes);
  return (
    <Card as="section" title={t("hrLink.pay.title")} headingLevel={2}>
      <div className="flex flex-col gap-4">
        <p className="m-0 max-w-prose">{t("hrLink.pay.about", { app: app() })}</p>
        <dl className="m-0 flex flex-col gap-2">
          <Fact term={t("hrLink.pay.current")}>
            {t("hrLink.pay.route", { route: pay.route, app: app() })}
          </Fact>
          {pay.pendingRoute && pay.pendingFrom ? (
            <>
              <Fact term={t("hrLink.pay.pending")}>
                {t("hrLink.pay.route", { route: pay.pendingRoute, app: app() })}
              </Fact>
              <Fact term={t("hrLink.pay.pendingFrom")}>
                <DateText value={pay.pendingFrom} />
              </Fact>
            </>
          ) : null}
        </dl>
        {may.manage && version !== null ? (
          <div className="flex flex-col gap-3">
            <h3 className="m-0 text-body font-semibold">{t("hrLink.pay.routeTitle")}</h3>
            <PayRouteForm version={version} current={pay.route} />
          </div>
        ) : null}
        <div className="flex flex-col gap-3">
          <h3 className="m-0 text-body font-semibold">{t("hrLink.pay.codesTitle")}</h3>
          <p className="m-0 max-w-prose">{t("hrLink.pay.codesAbout")}</p>
          {unmapped.length > 0 ? (
            <Note icon={<CircleAlert {...iconProps} />}>
              <p className="m-0">
                {t("hrLink.pay.unmapped", { count: unmapped.length, total: PAY_UNIT_KINDS.length })}
              </p>
            </Note>
          ) : null}
          {may.payCodes && version !== null ? (
            <PayCodesForm version={version} codes={pay.codes} />
          ) : (
            <>
              <dl className="m-0 grid gap-2 sm:grid-cols-2">
                {PAY_UNIT_KINDS.filter((k) => pay.codes[k]).map((k) => (
                  <Fact key={k} term={unitKindWords(k, t)}>
                    {pay.codes[k]}
                  </Fact>
                ))}
              </dl>
              <p className="m-0 text-body-dense">{t("hrLink.pay.codesWho")}</p>
            </>
          )}
        </div>
      </div>
    </Card>
  );
}

export interface HeldCopyView {
  readonly hrId: string;
  readonly kind: string;
  readonly startsOn: string;
  readonly endsOn: string | null;
  /** The staff member's name, or null when it cannot be shown to this reader. */
  readonly name: string | null;
}

/**
 * Absence copies to release: while linked, read again from the HR platform only when asked for
 * (it needs a fresh step-up and is rate-limited); once disconnected, the copies still in force.
 */
export function ReleaseSection({
  connected,
  asked,
  needsStepUp,
  held,
}: {
  readonly connected: boolean;
  /** Whether the person asked to check the list (while linked). */
  readonly asked: boolean;
  readonly needsStepUp: boolean;
  readonly held: {
    readonly mode: ReleaseMode | "none";
    readonly error: string | null;
    readonly items: readonly HeldCopyView[];
  } | null;
}) {
  const items = held?.items ?? [];
  const stepUpHref = `/sign-in?${new URLSearchParams({
    reason: "step-up",
    next: `${HR_LINK_PAGE}?release=1`,
  }).toString()}`;
  return (
    <Card as="section" id={RELEASE_ANCHOR} title={t("hrLink.release.title")} headingLevel={2}>
      <div className="flex flex-col gap-4">
        <p className="m-0 max-w-prose">
          {t("hrLink.release.about", { mode: connected ? "linked" : "disconnected", app: app() })}
        </p>
        {needsStepUp ? (
          <Note icon={<ShieldCheck {...iconProps} />}>
            <p className="m-0">{t("hrLink.release.stepUp")}</p>
            <p className="m-0">
              <Link href={stepUpHref} className="inline-flex min-h-target items-center underline">
                {t("hrLink.release.stepUpLink")}
              </Link>
            </p>
          </Note>
        ) : null}
        {connected && !asked && !needsStepUp ? (
          <div>
            <ButtonLink
              href={`${HR_LINK_PAGE}?release=1#${RELEASE_ANCHOR}`}
              variant="secondary"
              icon={<CalendarCheck {...iconProps} />}
            >
              {t("hrLink.release.check")}
            </ButtonLink>
          </div>
        ) : null}
        {held?.error ? (
          <Note icon={<CircleAlert {...iconProps} />}>
            <p className="m-0">{t("hrLink.release.unreadable")}</p>
            <p className="m-0">{t("hrLink.reason", { code: held.error })}</p>
          </Note>
        ) : null}
        {held && !held.error && items.length === 0 ? (
          <EmptyState
            headingLevel={3}
            icon={<CalendarCheck size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("hrLink.release.empty")}
          />
        ) : null}
        {held && held.mode !== "none" && items.length > 0 ? (
          <ReleaseForm mode={held.mode} hrIds={items.map((c) => c.hrId)}>
            <div className="flex flex-col gap-2">
              <h3 className="m-0 text-body font-semibold">
                {t("hrLink.release.listTitle", { count: items.length })}
              </h3>
              <ul className="m-0 flex flex-col gap-2 ps-5">
                {items.map((c) => (
                  <li key={c.hrId}>
                    <span className="font-semibold">{c.name ?? t("hrLink.release.someone")}</span>
                    {": "}
                    {t("hrLink.release.kind", { kind: c.kind })}
                    {". "}
                    {t("hrLink.release.firstDay")} <DateText value={c.startsOn} />
                    {". "}
                    {c.endsOn ? (
                      <>
                        {t("hrLink.release.lastDay")} <DateText value={c.endsOn} />
                      </>
                    ) : (
                      t("hrLink.release.noEnd")
                    )}
                    {". "}
                    <span className="text-body-dense text-text-secondary">
                      {t("hrLink.release.reference", { id: c.hrId })}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </ReleaseForm>
        ) : null}
      </div>
    </Card>
  );
}
