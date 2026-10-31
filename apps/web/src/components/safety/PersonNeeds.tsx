import type { PersonSummary } from "@harbour/contracts";
import { CommunicationStatus } from "@/components/people/CommunicationStatus";
import { t } from "@/lib/i18n";
import { communicationSummary } from "@/lib/people";

/** What a person's communication needs are read from. */
export type PersonNeedsOf = Pick<PersonSummary, "communicationNeeds" | "communicationNeedsStatus">;

/**
 * A person's communication needs beside who a notification is about (AIS, WCAG 2.2 AA; #52
 * review), labelled in every state so "Not recorded" says what is missing, as on the incident page.
 */
export function PersonNeeds({ person }: { readonly person: PersonNeedsOf }) {
  return (
    <dl className="m-0 flex max-w-full flex-wrap items-start gap-x-2 gap-y-1 [&>dd]:min-w-0 [&>dd]:max-w-full">
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
