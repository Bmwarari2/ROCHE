import type { PersonSummary } from "@harbour/contracts";
import { CommunicationStatus } from "@/components/people/CommunicationStatus";
import { t } from "@/lib/i18n";
import { communicationSummary } from "@/lib/people";

/**
 * A person's communication needs beside who a notification is about (AIS, WCAG 2.2 AA; #52
 * review), labelled in every state so "Not recorded" says what is missing, as on the incident page.
 */
export function PersonNeeds({
  person,
}: {
  readonly person: Pick<PersonSummary, "communicationNeeds" | "communicationNeedsStatus">;
}) {
  return (
    <dl className="m-0 flex flex-wrap items-start gap-x-2 gap-y-1">
      <dt className="text-body-dense font-semibold">{t("people.header.communicationNeeds")}</dt>
      <dd className="m-0">
        <CommunicationStatus
          summary={communicationSummary(person, t)}
          flagLabel={t("people.header.communicationNeeds")}
          compact
        />
      </dd>
    </dl>
  );
}
