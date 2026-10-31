import type {
  StatementOfPurposeChanges,
  StatementOfPurposeContent,
  StatementOfPurposeVersionItem,
} from "@harbour/contracts";
import { CircleAlert, Info } from "lucide-react";
import { Notice } from "@/components/care/Notice";
import { daysUntil } from "@/lib/evidence-packs";
import { formatDate, formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { notificationChip } from "@/lib/statement-of-purpose";
import { QualityChip } from "./QualityChip";

const none = () => <span className="text-text-secondary">{t("quality.sop.empty")}</span>;
const shown = (value: string | null | undefined) => (value && value.length > 0 ? value : none());

function Row({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-body-dense font-semibold">{label}</dt>
      <dd className="m-0 whitespace-pre-line break-words">{children}</dd>
    </div>
  );
}

/** A statement's content, read only, section by section as Schedule 3 lists it. */
export function StatementContent({ content }: { readonly content: StatementOfPurposeContent }) {
  const heading = (item: string) => (
    <h3 className="m-0 text-body font-semibold">{t("quality.sop.item", { item })}</h3>
  );
  return (
    <div className="flex flex-col gap-4">
      {heading("aims_and_objectives")}
      <p className="m-0 whitespace-pre-line">{shown(content.aimsAndObjectives)}</p>
      {heading("services_and_needs")}
      <dl className="m-0 grid grid-cols-1 gap-3">
        <Row label={t("quality.sop.field.serviceKinds")}>
          {content.serviceKinds.length > 0 ? content.serviceKinds.join("\n") : none()}
        </Row>
        <Row label={t("quality.sop.field.needsMet")}>{shown(content.needsMet)}</Row>
      </dl>
      {heading("contact_details")}
      <dl className="m-0 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Row label={t("quality.sop.field.provider")}>
          {[
            content.provider.fullName,
            content.provider.businessAddress,
            content.provider.businessPhone,
            content.provider.email,
          ]
            .filter(Boolean)
            .join("\n") || none()}
        </Row>
        {content.registeredManagers.map((m, i) => (
          <Row key={m.id} label={t("quality.sop.field.manager", { n: i + 1 })}>
            {[m.fullName, m.businessAddress, m.businessPhone, m.email].filter(Boolean).join("\n") ||
              none()}
          </Row>
        ))}
        {content.registeredManagers.length === 0 ? (
          <Row label={t("quality.sop.field.managers")}>{t("quality.sop.field.noManagers")}</Row>
        ) : null}
        <Row label={t("quality.sop.field.serviceAddress")}>{shown(content.serviceAddress)}</Row>
        <Row label={t("quality.sop.field.consents")}>
          {content.consentsToEmailService
            ? t("quality.sop.consented", { email: content.serviceEmail ?? "" })
            : t("quality.sop.notConsented")}
        </Row>
      </dl>
      {heading("legal_status")}
      <p className="m-0">
        {content.legalStatus
          ? content.legalStatus === "other"
            ? (content.legalStatusDetail ?? t("quality.sop.legalStatus", { status: "other" }))
            : t("quality.sop.legalStatus", { status: content.legalStatus })
          : none()}
      </p>
      {heading("locations")}
      {content.locations.length === 0 ? (
        <p className="m-0">{t("quality.sop.field.noLocations")}</p>
      ) : (
        <ul className="m-0 flex list-disc flex-col gap-1 ps-5">
          {content.locations.map((l) => (
            <li key={l.id} className="whitespace-pre-line">
              {t("quality.sop.locationLine", {
                name: l.name,
                address: l.address,
                cqc: l.cqcLocationId ?? "",
                hasCqc: String(Boolean(l.cqcLocationId)),
              })}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Where a revision stands against the CQC clock, as an icon and a word, with its dates in words. */
export function NotificationStatus({
  version,
  now,
}: {
  readonly version: StatementOfPurposeVersionItem;
  readonly now: Date;
}) {
  const n = version.notification;
  const due = n.dueAt ? (formatDate(n.dueAt.slice(0, 10)) ?? "") : "";
  const dueWhen = n.dueAt ? (formatDateTime(n.dueAt) ?? "") : "";
  return (
    <div className="flex flex-col gap-1">
      <span>
        <QualityChip chip={notificationChip(n, t)} />
      </span>
      {n.state === "due" || n.state === "overdue" ? (
        <span className="font-semibold">
          {t("quality.sop.dueWords", {
            state: n.state,
            when: dueWhen || due,
            days: n.dueAt ? daysUntil(n.dueAt, now) : 0,
          })}
        </span>
      ) : null}
      {n.state === "notified" ? (
        <span>
          {t("quality.sop.sentWords", {
            when: formatDateTime(n.notifiedAt) ?? "",
            late: String(n.late),
          })}
        </span>
      ) : null}
    </div>
  );
}

/** The API's English lines (Schedule 3 gaps, warnings, changes), marked as English. */
export function EnglishLines({ lines }: { readonly lines: readonly string[] }) {
  return (
    <ul lang="en-GB" className="m-0 flex list-disc flex-col gap-1 ps-5">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

/**
 * What a version changes against the one before it, section by section in plain English, and the
 * registration prompts (Harbour's reading, rule 13): applications CQC may also need. Harbour
 * prompts; it does not decide.
 */
export function StatementChanges({ changes }: { readonly changes: StatementOfPurposeChanges }) {
  const changed = changes.sections.filter((s) => s.change === "changed");
  return (
    <div className="flex flex-col gap-3">
      {changes.comparedWithId === null ? (
        <p className="m-0">{t("quality.sop.changes.first")}</p>
      ) : changed.length === 0 ? (
        <p className="m-0">{t("quality.sop.changes.none")}</p>
      ) : (
        changed.map((section) => (
          <div key={section.key} className="flex flex-col gap-1">
            <h4 className="m-0 text-body font-semibold">
              {t("quality.sop.item", { item: section.key })}
            </h4>
            <EnglishLines lines={section.lines} />
          </div>
        ))
      )}
      {changes.registrationPrompts.length > 0 ? (
        <Notice
          tone="warning"
          icon={<CircleAlert size={20} strokeWidth={1.5} aria-hidden="true" />}
          title={t("quality.sop.prompts.title")}
        >
          <div className="flex flex-col gap-2">
            <EnglishLines lines={changes.registrationPrompts.map((p) => p.message)} />
            <p className="m-0 text-body-dense">{t("quality.sop.prompts.hint")}</p>
          </div>
        </Notice>
      ) : null}
      <p className="m-0 inline-flex items-center gap-2 text-body-dense text-text-secondary">
        <Info size={16} strokeWidth={1.5} aria-hidden="true" />
        {t("quality.sop.englishOnly")}
      </p>
    </div>
  );
}
