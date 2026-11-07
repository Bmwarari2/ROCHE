import { ButtonLink, Card, EmptyState, PageHeader, StatusChip } from "@harbour/ui";
import { CalendarCheck, CircleAlert, Link2Off, Send, ShieldCheck, Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  CheckButtons,
  ConnectForm,
  DisconnectForm,
  LocationMapForm,
  MatchReviewForm,
  PayCodesForm,
  PayRouteForm,
  ReleaseForm,
  SettingsForm,
} from "@/components/hr-link/HrLinkForms";
import { HrLinkStaleness } from "@/components/rota/HrLinkStaleness";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { formatDate, formatDateTime } from "@/lib/format";
import {
  CHOOSABLE_KINDS,
  DELIVERIES_SHOWN,
  deliveryChip,
  FIXED_KINDS,
  HR_LINK_PAGE,
  hrLinkMay,
  hrLinkShown,
  leaversFirst,
  linkChip,
  PAY_UNIT_KINDS,
  syncChip,
  unitKindWords,
  unmappedKinds,
} from "@/lib/hr-link";
import { t } from "@/lib/i18n";
import { firstParam } from "@/lib/record-metadata";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata: Metadata = { title: t("hrLink.title") };

const DONE = new Set([
  "connected",
  "settings",
  "disconnected",
  "located",
  "confirmed",
  "rejected",
  "payRoute",
  "payCodes",
  "released",
]);
const RELEASE_ANCHOR = "hr-release";
const app = () => t("app.name");

const count = (value: string | undefined) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : 0;
};

function Fact({ term, children }: { readonly term: string; readonly children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
      <dt className="font-semibold">{term}</dt>
      <dd className="m-0">{children}</dd>
    </div>
  );
}

/**
 * The link to the HR platform (Thapsus-HR; integrations.md sections 11.5 and 11.6; INTG-014;
 * slice 90; HZ-133, HZ-140), for the HR lead and the Registered Manager. Holders of
 * `integrations.hr_link.read`, `.review` or `.manage` see the link's status and sync health and
 * what was sent; reviewers confirm or reject matches; managers connect, choose owners, map homes,
 * set the route to payroll and pay codes, release held absence copies and disconnect, each with a
 * fresh step-up. The organisation's flag keeps it off until turned on. Reading which absence
 * copies a release would cancel asks the HR platform again, so while linked it is read only when
 * asked for.
 */
export default async function HrLinkPage({
  searchParams,
}: {
  readonly searchParams: SearchParams;
}) {
  const { me } = await getShellContext();
  const title = t("hrLink.title");
  if (!hrLinkShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const status = await api.GET("/v1/integrations/hr-link");
  if (!status.data) {
    const code = problemCode(status.error);
    if (code === "missing_permission") return <SafetyForbidden title={title} />;
    if (code === "feature_disabled") {
      return (
        <div className="mx-auto flex w-full max-w-content flex-col gap-6">
          <PageHeader eyebrow={me.tenant.name} title={title} />
          <Card>
            <EmptyState
              headingLevel={2}
              icon={<Link2Off size={32} strokeWidth={1.5} aria-hidden="true" />}
              title={t("hrLink.off.title")}
              description={t("hrLink.off.body", { app: app() })}
            />
          </Card>
        </div>
      );
    }
    return failWith(status.error, status.response, HR_LINK_PAGE);
  }
  const link = status.data;
  const may = hrLinkMay(me.permissions);
  const query = await searchParams;
  const checkRelease = firstParam(query.release) === "1";
  const [deliveries, matches, locations, staffFiles, held] = await Promise.all([
    api.GET("/v1/integrations/hr-link/deliveries"),
    may.review ? api.GET("/v1/integrations/hr-link/matches") : null,
    link.connected ? api.GET("/v1/integrations/hr-link/locations") : null,
    // Only for choosing whose file a match is; a reviewer without staff files sees the suggestion.
    may.review && link.matchesToReview > 0
      ? api.GET("/v1/workforce/staff-files").catch(() => null)
      : null,
    // Once disconnected the copies are read here; while linked, only when asked for.
    may.manage && (link.status === "disconnected" || (link.connected && checkRelease))
      ? api.GET("/v1/integrations/hr-link/absences/held")
      : null,
  ]);
  if (!deliveries.data) failWith(deliveries.error, deliveries.response, HR_LINK_PAGE);
  if (matches && !matches.data) failWith(matches.error, matches.response, HR_LINK_PAGE);
  if (locations && !locations.data) failWith(locations.error, locations.response, HR_LINK_PAGE);
  // Seeing copies to release needs a fresh step-up: asked for, the page sends the person to
  // confirm; on an ordinary visit it says so instead.
  const heldNeedsStepUp = held && !held.data && problemCode(held.error) === "step_up_required";
  if (held && !held.data && (checkRelease || !heldNeedsStepUp)) {
    failWith(held.error, held.response, `${HR_LINK_PAGE}?release=1`);
  }

  const done = firstParam(query.done);
  const arrival =
    done && DONE.has(done)
      ? t("hrLink.done", { done, count: count(firstParam(query.count)) })
      : null;
  const when = (iso: string | null) => formatDateTime(iso) ?? "";
  const staleness = link.staleness;
  const matchItems = leaversFirst(matches?.data?.items ?? []);
  const staff = (staffFiles?.data?.items ?? [])
    .filter((f) => f.leftOn === null && f.member !== null)
    .map((f) => ({
      id: f.id,
      label: t("hrLink.matches.staffOption", {
        name: f.member?.displayName ?? "",
        jobTitle: f.jobTitle,
        titled: f.jobTitle ? "yes" : "no",
      }),
    }));
  const staffFor = (candidate: string | null) =>
    staff.length > 0 || !candidate
      ? staff
      : [{ id: candidate, label: t("hrLink.matches.suggestedFile") }];
  const unmapped = unmappedKinds(link.pay.codes);
  const pay = link.pay;
  const heldItems = held?.data?.items ?? [];

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={me.tenant.name}
        title={title}
        description={t("hrLink.description", { app: app() })}
      />
      {arrival ? <RecordedArrival message={arrival} param="done" /> : null}
      <HrLinkStaleness api={api} />

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
                  <time dateTime={staleness.lastGoodSyncAt}>{when(staleness.lastGoodSyncAt)}</time>
                ) : (
                  t("hrLink.status.notYet")
                )}
              </Fact>
            ) : null}
            {staleness?.lastErrorCode ? (
              <Fact term={t("hrLink.status.lastProblem")}>
                {t("hrLink.status.problem", {
                  reason: t("hrLink.code", { code: staleness.lastErrorCode }),
                  failures: staleness.failures,
                })}
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
            <div role="note" className="flex gap-3">
              <CircleAlert
                size={18}
                strokeWidth={1.5}
                aria-hidden="true"
                className="mt-0.5 shrink-0"
              />
              <p className="m-0">
                {t("hrLink.status.leaversNotEnded", { count: link.leaversNotEnded })}
              </p>
            </div>
          ) : null}
          {may.manage && link.connected ? <CheckButtons /> : null}
        </div>
      </Card>

      {!link.connected ? (
        <Card as="section" title={t("hrLink.connect.title")} headingLevel={2}>
          <div className="flex flex-col gap-3">
            <p className="m-0 max-w-prose">{t("hrLink.connect.about", { app: app() })}</p>
            {may.manage ? <ConnectForm /> : <p className="m-0">{t("hrLink.connect.notYours")}</p>}
          </div>
        </Card>
      ) : null}

      {link.connected ? (
        <Card as="section" title={t("hrLink.owners.title")} headingLevel={2}>
          <div className="flex flex-col gap-4">
            <p className="m-0 max-w-prose">{t("hrLink.owners.about", { app: app() })}</p>
            {may.manage && link.version !== null ? (
              <SettingsForm
                version={link.version}
                owners={link.owners}
                stalenessMinutes={link.stalenessMinutes}
              />
            ) : (
              <dl className="m-0 flex flex-col gap-2">
                {CHOOSABLE_KINDS.map((kind) => (
                  <Fact key={kind} term={t("hrLink.owners.kind", { kind })}>
                    {t("hrLink.owners.system", { system: link.owners[kind], app: app() })}
                  </Fact>
                ))}
              </dl>
            )}
            <div className="flex flex-col gap-2">
              <h3 className="m-0 text-body font-semibold">
                {t("hrLink.owners.fixedTitle", { app: app() })}
              </h3>
              <ul className="m-0 flex flex-col gap-1 ps-5">
                {FIXED_KINDS.map((kind) => (
                  <li key={kind}>{t("hrLink.owners.kind", { kind })}</li>
                ))}
              </ul>
            </div>
          </div>
        </Card>
      ) : null}

      {locations?.data ? (
        <Card as="section" title={t("hrLink.locations.title")} headingLevel={2}>
          <div className="flex flex-col gap-4">
            <p className="m-0 max-w-prose">{t("hrLink.locations.about", { app: app() })}</p>
            {locations.data.thapsusHr.length === 0 ? (
              <p className="m-0">{t("hrLink.locations.noneThere")}</p>
            ) : null}
            <ul className="m-0 flex list-none flex-col gap-4 p-0">
              {locations.data.harbour.map((l) => {
                const theirs = locations.data.thapsusHr.find((x) => x.id === l.hrLocationId);
                return (
                  <li
                    key={l.locationId}
                    className="flex flex-col gap-2 border-b border-border pb-4"
                  >
                    <h3 className="m-0 text-body font-semibold">{l.name}</h3>
                    {may.manage ? (
                      <LocationMapForm
                        locationId={l.locationId}
                        name={l.name}
                        current={l.hrLocationId}
                        options={locations.data.thapsusHr}
                      />
                    ) : (
                      <p className="m-0">
                        {l.hrLocationId
                          ? t("hrLink.locations.mappedTo", { name: theirs?.name ?? l.hrLocationId })
                          : t("hrLink.locations.notMapped")}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </Card>
      ) : null}

      {may.review ? (
        <Card as="section" title={t("hrLink.matches.title")} headingLevel={2}>
          <div className="flex flex-col gap-4">
            <p className="m-0 max-w-prose">{t("hrLink.matches.about", { app: app() })}</p>
            {matchItems.length === 0 ? (
              <EmptyState
                headingLevel={3}
                icon={<Users size={32} strokeWidth={1.5} aria-hidden="true" />}
                title={t("hrLink.matches.empty")}
              />
            ) : (
              <ul className="m-0 flex list-none flex-col gap-4 p-0">
                {matchItems.map((m) => {
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
                          <StatusChip
                            status="overdue"
                            icon={CalendarCheck}
                            label={t("hrLink.matches.leaving", {
                              date: formatDate(m.leavingOn) ?? "",
                            })}
                          />
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
      ) : null}

      <Card as="section" title={t("hrLink.deliveries.title")} headingLevel={2}>
        <div className="flex flex-col gap-3">
          <p className="m-0 max-w-prose">{t("hrLink.deliveries.about", { app: app() })}</p>
          {deliveries.data.items.length === 0 ? (
            <EmptyState
              headingLevel={3}
              icon={<Send size={32} strokeWidth={1.5} aria-hidden="true" />}
              title={t("hrLink.deliveries.empty")}
            />
          ) : (
            <>
              {deliveries.data.items.length > DELIVERIES_SHOWN ? (
                <p className="m-0 text-body-dense">
                  {t("hrLink.deliveries.latest", { count: DELIVERIES_SHOWN })}
                </p>
              ) : null}
              <ul className="m-0 flex list-none flex-col gap-3 p-0">
                {deliveries.data.items.slice(0, DELIVERIES_SHOWN).map((d) => (
                  <li key={d.id} className="flex flex-col gap-1 border-b border-border pb-3">
                    <p className="m-0 flex flex-wrap items-center gap-2">
                      <span className="font-semibold">
                        {t("hrLink.deliveries.kind", { kind: d.kind })}
                      </span>
                      <SafetyChip chip={deliveryChip(d.state, t)} />
                    </p>
                    <p className="m-0 text-body-dense">
                      {t("hrLink.deliveries.detail", {
                        attempts: d.attempts,
                        sent: d.sentAt ? "yes" : "no",
                        when: when(d.sentAt),
                      })}
                    </p>
                    {d.lastErrorCode ? (
                      <p className="m-0 text-body-dense">
                        {t("hrLink.deliveries.problem", {
                          reason: t("hrLink.code", { code: d.lastErrorCode }),
                        })}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </Card>

      {link.connected ? (
        <Card as="section" title={t("hrLink.pay.title")} headingLevel={2}>
          <div className="flex flex-col gap-4">
            <p className="m-0 max-w-prose">{t("hrLink.pay.about", { app: app() })}</p>
            <dl className="m-0 flex flex-col gap-2">
              <Fact term={t("hrLink.pay.current")}>
                {t("hrLink.pay.route", { route: pay.route, app: app() })}
              </Fact>
              {pay.pendingRoute && pay.pendingFrom ? (
                <Fact term={t("hrLink.pay.pending")}>
                  {t("hrLink.pay.pendingFrom", {
                    route: pay.pendingRoute,
                    from: formatDate(pay.pendingFrom) ?? "",
                    app: app(),
                  })}
                </Fact>
              ) : null}
            </dl>
            {may.manage && link.version !== null ? (
              <div className="flex flex-col gap-3">
                <h3 className="m-0 text-body font-semibold">{t("hrLink.pay.routeTitle")}</h3>
                <PayRouteForm version={link.version} current={pay.route} />
              </div>
            ) : null}
            <div className="flex flex-col gap-3">
              <h3 className="m-0 text-body font-semibold">{t("hrLink.pay.codesTitle")}</h3>
              <p className="m-0 max-w-prose">{t("hrLink.pay.codesAbout")}</p>
              {unmapped.length > 0 ? (
                <p className="m-0 flex items-start gap-2">
                  <CircleAlert
                    size={18}
                    strokeWidth={1.5}
                    aria-hidden="true"
                    className="mt-0.5 shrink-0"
                  />
                  <span>
                    {t("hrLink.pay.unmapped", {
                      count: unmapped.length,
                      total: PAY_UNIT_KINDS.length,
                    })}
                  </span>
                </p>
              ) : null}
              {may.payCodes && link.version !== null ? (
                <PayCodesForm version={link.version} codes={pay.codes} />
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
      ) : null}

      {may.manage && (link.connected || heldItems.length > 0 || heldNeedsStepUp) ? (
        <Card as="section" id={RELEASE_ANCHOR} title={t("hrLink.release.title")} headingLevel={2}>
          <div className="flex flex-col gap-4">
            <p className="m-0 max-w-prose">
              {t("hrLink.release.about", {
                mode: link.connected ? "drift" : "disconnected",
                app: app(),
              })}
            </p>
            {heldNeedsStepUp ? (
              <p className="m-0 flex items-start gap-2">
                <ShieldCheck
                  size={18}
                  strokeWidth={1.5}
                  aria-hidden="true"
                  className="mt-0.5 shrink-0"
                />
                <span>
                  {t("hrLink.release.stepUp")}{" "}
                  <Link
                    href={`/sign-in?${new URLSearchParams({ reason: "step-up", next: `${HR_LINK_PAGE}?release=1` }).toString()}`}
                    className="inline-flex min-h-target items-center underline"
                  >
                    {t("people.breakGlass.signInAgain")}
                  </Link>
                </span>
              </p>
            ) : null}
            {link.connected && !checkRelease ? (
              <div>
                <ButtonLink
                  href={`${HR_LINK_PAGE}?release=1#${RELEASE_ANCHOR}`}
                  variant="secondary"
                  icon={<CalendarCheck size={18} strokeWidth={1.5} aria-hidden="true" />}
                >
                  {t("hrLink.release.check")}
                </ButtonLink>
              </div>
            ) : null}
            {held?.data?.error ? (
              <p className="m-0 flex items-start gap-2">
                <CircleAlert
                  size={18}
                  strokeWidth={1.5}
                  aria-hidden="true"
                  className="mt-0.5 shrink-0"
                />
                <span>
                  {t("hrLink.release.unreadable", {
                    reason: t("hrLink.code", { code: held.data.error }),
                  })}
                </span>
              </p>
            ) : null}
            {held?.data && !held.data.error && heldItems.length === 0 ? (
              <EmptyState
                headingLevel={3}
                icon={<CalendarCheck size={32} strokeWidth={1.5} aria-hidden="true" />}
                title={t("hrLink.release.empty")}
              />
            ) : null}
            {held?.data && held.data.mode !== "none" && heldItems.length > 0 ? (
              <ReleaseForm mode={held.data.mode} hrIds={heldItems.map((c) => c.hrId)}>
                <div className="flex flex-col gap-2">
                  <h3 className="m-0 text-body font-semibold">
                    {t("hrLink.release.listTitle", { count: heldItems.length })}
                  </h3>
                  <ul className="m-0 flex flex-col gap-1 ps-5">
                    {heldItems.map((c) => (
                      <li key={c.hrId}>
                        {t("hrLink.release.item", {
                          id: c.hrId,
                          kind: c.kind,
                          from: formatDate(c.startsOn) ?? "",
                          to: c.endsOn ? (formatDate(c.endsOn) ?? "") : "",
                          open: c.endsOn ? "no" : "yes",
                        })}
                      </li>
                    ))}
                  </ul>
                </div>
              </ReleaseForm>
            ) : null}
          </div>
        </Card>
      ) : null}

      {may.manage && link.connected ? (
        <Card as="section" title={t("hrLink.disconnect.sectionTitle")} headingLevel={2}>
          <div className="flex flex-col gap-3">
            <p className="m-0 max-w-prose">{t("hrLink.disconnect.about", { app: app() })}</p>
            <div>
              <DisconnectForm />
            </div>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
