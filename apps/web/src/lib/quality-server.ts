import "server-only";
import type { PersonSummary } from "@harbour/contracts";
import { cache } from "react";
import { tenantApi } from "./api";
import { t } from "./i18n";
import { personNames, sampleName } from "./people";

export interface PackPerson {
  readonly name: string;
  readonly locationId: string;
  /** A second identifier, so two people with the same name are told apart (HZ-001, HZ-050). */
  readonly dateOfBirth: string | null;
  readonly communicationNeeds: PersonSummary["communicationNeeds"];
  readonly communicationNeedsStatus: PersonSummary["communicationNeedsStatus"];
}

/**
 * The people the reader can see, by id: full name (with the Sample badge words for sample
 * people), location, date of birth and communication needs (the Accessible Information Standard
 * flag shown wherever a person is named). Empty when the reader cannot read the people list; the
 * pages then say "a person you cannot see".
 */
export const getPackPeople = cache(async (): Promise<ReadonlyMap<string, PackPerson>> => {
  const api = await tenantApi();
  const { data } = await api.GET("/v1/people");
  return new Map(
    (data?.items ?? []).map((person) => [
      person.id,
      {
        name: sampleName(person, personNames(person).full, t),
        locationId: person.locationId,
        dateOfBirth: person.dateOfBirth,
        communicationNeeds: person.communicationNeeds,
        communicationNeedsStatus: person.communicationNeedsStatus,
      },
    ]),
  );
});

/**
 * This site's origin for the link the releaser sends: `PUBLIC_WEB_URL` (set per environment by
 * Terraform), or the local web server outside production. Nothing from the request decides it
 * (as for invitations): a forged Host or X-Forwarded-Host must never put an attacker's origin in
 * front of the token. Null in production without the setting, and release is then not offered.
 */
export function webOrigin(): string | null {
  return (
    process.env.PUBLIC_WEB_URL ??
    (process.env.NODE_ENV === "production" ? null : "http://localhost:3000")
  );
}
