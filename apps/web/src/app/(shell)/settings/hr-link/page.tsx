import { Card, EmptyState, PageHeader } from "@harbour/ui";
import { Link2Off } from "lucide-react";
import type { Metadata } from "next";
import {
  ConnectForm,
  DisconnectForm,
  LocationMapForm,
  SettingsForm,
} from "@/components/hr-link/HrLinkForms";
import {
  DeliveriesSection,
  Fact,
  MatchesSection,
  PaySection,
  ReleaseSection,
  StatusSection,
} from "@/components/hr-link/HrLinkSections";
import { HrLinkStaleness } from "@/components/rota/HrLinkStaleness";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import {
  CHOOSABLE_KINDS,
  FIXED_KINDS,
  HR_LINK_PAGE,
  hrLinkMay,
  hrLinkShown,
  leaversFirst,
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
const app = () => t("app.name");

const count = (value: string | undefined) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : 0;
};

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
  const [deliveries, matches, locations, heldGot] = await Promise.all([
    api.GET("/v1/integrations/hr-link/deliveries"),
    may.review ? api.GET("/v1/integrations/hr-link/matches") : null,
    link.connected ? api.GET("/v1/integrations/hr-link/locations") : null,
    // Once disconnected the copies are read here; while linked, only when asked for, since the
    // HR platform is asked again. Either way it needs a fresh step-up and is rate-limited.
    may.manage && (link.status === "disconnected" || (link.connected && checkRelease))
      ? api.GET("/v1/integrations/hr-link/absences/held")
      : null,
  ]);
  if (!deliveries.data) failWith(deliveries.error, deliveries.response, HR_LINK_PAGE);
  if (matches && !matches.data) failWith(matches.error, matches.response, HR_LINK_PAGE);
  if (locations && !locations.data) failWith(locations.error, locations.response, HR_LINK_PAGE);
  const heldCode = heldGot && !heldGot.data ? problemCode(heldGot.error) : undefined;
  // Asked for, the page sends the person to confirm it is them; on an ordinary visit it says so.
  const heldNeedsStepUp = heldCode === "step_up_required" && !checkRelease;
  if (heldGot && !heldGot.data && heldCode !== "rate_limited" && !heldNeedsStepUp) {
    failWith(heldGot.error, heldGot.response, `${HR_LINK_PAGE}?release=1`);
  }
  const heldData =
    heldCode === "rate_limited"
      ? {
          mode: "none" as const,
          error: "rate_limited",
          items: [] as {
            memberId: string;
            hrId: string;
            kind: string;
            startsOn: string;
            endsOn: string | null;
          }[],
        }
      : (heldGot?.data ?? null);
  // Names, for choosing whose file a match is and for whose absence a copy is; a reader without
  // staff files sees the match's suggestion and "a member of staff".
  const staffFiles =
    (may.review && link.matchesToReview > 0) || (heldData?.items.length ?? 0) > 0
      ? await api.GET("/v1/workforce/staff-files").catch(() => null)
      : null;

  const done = firstParam(query.done);
  const arrival =
    done && DONE.has(done)
      ? t("hrLink.done", { done, count: count(firstParam(query.count)) })
      : null;
  const files = (staffFiles?.data?.items ?? []).filter((f) => f.member !== null);
  const nameOf = new Map(files.map((f) => [f.member?.id ?? "", f.member?.displayName ?? ""]));
  const staff = files
    .filter((f) => f.leftOn === null)
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
  const held = heldData
    ? {
        mode: heldData.mode,
        error: heldData.error,
        items: heldData.items.map((c) => ({
          hrId: c.hrId,
          kind: c.kind,
          startsOn: c.startsOn,
          endsOn: c.endsOn,
          name: nameOf.get(c.memberId) || null,
        })),
      }
    : null;

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={me.tenant.name}
        title={title}
        description={t("hrLink.description", { app: app() })}
      />
      {arrival ? <RecordedArrival message={arrival} param="done" /> : null}
      <HrLinkStaleness api={api} />
      <StatusSection link={link} may={may} />

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
        <MatchesSection items={leaversFirst(matches?.data?.items ?? [])} staffFor={staffFor} />
      ) : null}
      <DeliveriesSection items={deliveries.data.items} />
      {link.connected ? <PaySection pay={link.pay} version={link.version} may={may} /> : null}
      {may.manage && (link.connected || link.status === "disconnected") ? (
        <ReleaseSection
          connected={link.connected}
          asked={checkRelease}
          needsStepUp={heldNeedsStepUp}
          held={held}
        />
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
