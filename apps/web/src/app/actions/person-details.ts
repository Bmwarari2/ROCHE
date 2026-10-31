"use server";

import type {
  ContactOut,
  CreateContact,
  PersonDetails,
  UpdatePersonDetails,
} from "@harbour/contracts";
import { sendForPerson } from "@/lib/care-actions";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import { type ActionResult, refused } from "@/lib/outcome";

/**
 * Personal details and contacts (PEOP-001), sent to the API as the signed-in member of staff with
 * the version each was loaded at, so a change made meanwhile by someone else is refused, never
 * overwritten. The API checks the permission, the person's scope and every rule again.
 */

const isVersion = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1;

export async function updatePersonDetails(
  personId: string,
  changes: Omit<UpdatePersonDetails, "version">,
  version: number,
): Promise<ActionResult<PersonDetails>> {
  if (!isVersion(version)) return refused(t("care.errors.invalid"));
  if (Object.keys(changes).length === 0) return refused(t("people.details.form.noChange"));
  return sendForPerson(personId, (api) =>
    api.PATCH("/v1/people/{id}/details", {
      params: { path: { id: personId } },
      body: { ...changes, version },
    }),
  );
}

export async function addContact(
  personId: string,
  contact: CreateContact,
): Promise<ActionResult<ContactOut>> {
  if (contact.authorityDocumentId && !isUuid(contact.authorityDocumentId)) {
    return refused(t("care.errors.invalid"), "invalid", ["authorityDocumentId"]);
  }
  return sendForPerson(personId, (api) =>
    api.POST("/v1/people/{id}/contacts", {
      params: { path: { id: personId } },
      body: contact,
    }),
  );
}

export async function updateContact(
  personId: string,
  contactId: string,
  changes: Partial<CreateContact>,
  version: number,
): Promise<ActionResult<ContactOut>> {
  if (!isUuid(contactId)) return refused(t("errors.notFound"), "not_found");
  if (!isVersion(version)) return refused(t("care.errors.invalid"));
  if (Object.keys(changes).length === 0) return refused(t("people.contacts.form.noChange"));
  if (changes.authorityDocumentId && !isUuid(changes.authorityDocumentId)) {
    return refused(t("care.errors.invalid"), "invalid", ["authorityDocumentId"]);
  }
  return sendForPerson(personId, (api) =>
    api.PATCH("/v1/people/{id}/contacts/{contactId}", {
      params: { path: { id: personId, contactId } },
      body: { ...changes, version },
    }),
  );
}
