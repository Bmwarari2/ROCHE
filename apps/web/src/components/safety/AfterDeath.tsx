import type { IncidentDetail, StatutoryNotificationSummary } from "@harbour/contracts";
import { Card } from "@harbour/ui";
import { CircleAlert, ExternalLink } from "lucide-react";
import Link from "next/link";
import { Notice } from "@/components/care/Notice";
import { afterDeath, LEDER_REPORT_URL, type LederPrompt, packSections } from "@/lib/after-death";
import { t } from "@/lib/i18n";
import { notificationClockChip, notificationStatusChip } from "@/lib/incidents";
import { PersonNeeds, type PersonNeedsOf } from "./PersonNeeds";
import { SafetyChip } from "./SafetyChip";

const iconProps = { size: 20, strokeWidth: 1.5, "aria-hidden": true } as const;
const link = "inline-flex min-h-target items-center underline";

/** A notification's clock and status as icons and words, linked to its page for a manager. */
function NotificationLine({
  notification,
  linked,
  now,
}: {
  readonly notification: StatutoryNotificationSummary;
  readonly linked: boolean;
  readonly now: Date;
}) {
  const status = notificationStatusChip(notification, t);
  return (
    <p className="m-0 flex flex-wrap items-center gap-2">
      <SafetyChip chip={notificationClockChip(notification, now, t)} />
      {status ? <SafetyChip chip={status} /> : null}
      {linked ? (
        <Link href={`/notifications/statutory/${notification.id}`} className={link}>
          {t("safety.afterDeath.notificationLink", { kind: notification.kind })}
        </Link>
      ) : null}
    </p>
  );
}

/**
 * The medical examiner information pack's sections (`MEDICAL_EXAMINER_PACK_SECTIONS`), each with
 * what it holds and where it is kept for this person: a part of their record, this incident, or
 * not on Harbour's web pages yet. Harbour does not put the pack together itself yet.
 */
export function ExaminerPack({
  personId,
  incidentId,
  headingLevel = 3,
  headingId,
  onIncidentPage = false,
}: {
  readonly personId: string | null;
  readonly incidentId: string | null;
  readonly headingLevel?: 2 | 3 | 4;
  /** The heading's id, for a section labelled by it. */
  readonly headingId?: string;
  /** Shown on the incident itself: the circumstances are on this page, not linked. */
  readonly onIncidentPage?: boolean;
}) {
  const Heading = headingLevel === 2 ? "h2" : headingLevel === 3 ? "h3" : "h4";
  return (
    <div className="flex flex-col gap-2">
      <Heading
        {...(headingId ? { id: headingId } : {})}
        className={headingLevel === 2 ? "hb-card__title" : "m-0 text-body font-semibold"}
      >
        {t("safety.afterDeath.packTitle")}
      </Heading>
      <p className="m-0 max-w-prose text-body-dense text-text-secondary">
        {t("safety.afterDeath.packIntro")}
      </p>
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {packSections(personId, incidentId ?? "").map((section) => {
          const here = section.place === "incident" && onIncidentPage;
          const linkable =
            section.href !== null && !here && (section.place !== "incident" || incidentId);
          return (
            <li key={section.key} className="flex flex-col gap-0.5">
              <span className="font-semibold">
                {t("safety.afterDeath.section", { section: section.key })}
              </span>
              <span className="text-body-dense">
                {t("safety.afterDeath.contents", { section: section.key })}
              </span>
              {linkable && section.href ? (
                <Link href={section.href} className={`${link} text-body-dense`}>
                  {t("safety.afterDeath.place", { place: section.placeKey })}
                </Link>
              ) : (
                <span className="text-body-dense text-text-secondary">
                  {t("safety.afterDeath.place", { place: here ? "thisPage" : "none" })}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The LeDeR prompt (safety.md rule 6): a drafted notification says to report the death on
 * LeDeR's own online form, which anyone can use, then record it; when the incident does not
 * record whether the person had a learning disability or was autistic, staff are asked to check.
 */
export function LederNotice({
  prompt,
  name,
  linked,
  now,
  onNotificationPage = false,
}: {
  readonly prompt: LederPrompt;
  readonly name: string;
  readonly linked: boolean;
  readonly now: Date;
  /** On the LeDeR notification's own page, whose clock and status are already shown. */
  readonly onNotificationPage?: boolean;
}) {
  if (prompt.kind === "none") return null;
  return (
    <Notice
      tone="warning"
      icon={<CircleAlert {...iconProps} />}
      title={t("safety.afterDeath.lederTitle", { kind: prompt.kind })}
    >
      <div className="flex flex-col gap-2">
        <p className="m-0">
          {t("safety.afterDeath.lederBody", {
            kind: onNotificationPage ? "here" : prompt.kind,
            name,
          })}
        </p>
        <p className="m-0">
          <a href={LEDER_REPORT_URL} className={`${link} gap-1`} rel="noreferrer">
            {t("safety.afterDeath.lederLink")}
            <ExternalLink size={16} strokeWidth={1.5} aria-hidden="true" />
          </a>
        </p>
        {prompt.kind === "drafted" && !onNotificationPage ? (
          <NotificationLine notification={prompt.notification} linked={linked} now={now} />
        ) : null}
      </div>
    </Notice>
  );
}

/**
 * After a death on an incident (SAFE-008; safety.md rules 6 and 8; hazard HZ-013): for each person
 * we support who died, the medical examiner pack's notification with its clock and the pack's
 * sections with where each is kept, and the LeDeR prompt. Nothing here judges the death. Not shown
 * to a reader who sees the incident only in part.
 */
export function AfterDeath({
  incident,
  names,
  records,
  linked,
  now,
}: {
  readonly incident: Pick<IncidentDetail, "id" | "restricted" | "people" | "classifier">;
  readonly names: ReadonlyMap<string, string>;
  /** The people we support from the reader's own list, for their communication needs (AIS). */
  readonly records: ReadonlyMap<string, PersonNeedsOf>;
  /** The reader opens notification pages (`safety.incident.manage`). */
  readonly linked: boolean;
  readonly now: Date;
}) {
  const deaths = afterDeath(incident);
  if (deaths.length === 0) return null;
  return (
    <Card as="section" aria-labelledby="after-death">
      <div className="flex flex-col gap-6 break-words">
        <h2 id="after-death" className="hb-card__title">
          {t("safety.afterDeath.title")}
        </h2>
        {deaths.map(({ person, examiner, leder }) => {
          const name =
            (person.personId ? names.get(person.personId) : undefined) ??
            t("safety.incident.unnamed", { kind: person.kind });
          const needs = person.personId ? records.get(person.personId) : undefined;
          return (
            <div key={person.id} className="flex flex-col gap-4">
              {deaths.length > 1 ? (
                <h3 className="m-0 text-body font-semibold">
                  {t("safety.afterDeath.about", { name })}
                </h3>
              ) : (
                <p className="m-0">{t("safety.afterDeath.about", { name })}</p>
              )}
              {needs ? <PersonNeeds person={needs} /> : null}
              <LederNotice prompt={leder} name={name} linked={linked} now={now} />
              {examiner ? (
                <NotificationLine notification={examiner} linked={linked} now={now} />
              ) : null}
              <ExaminerPack
                personId={person.personId}
                incidentId={incident.id}
                headingLevel={deaths.length > 1 ? 4 : 3}
                onIncidentPage
              />
            </div>
          );
        })}
      </div>
    </Card>
  );
}
