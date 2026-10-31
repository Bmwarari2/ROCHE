import "server-only";
import { headers } from "next/headers";
import { cache } from "react";
import { tenantApi } from "./api";
import { t } from "./i18n";
import { personNames, sampleName } from "./people";

/**
 * The people the reader can see, by id, with their full names (and the Sample badge words for
 * sample people) and locations, for the compose form and for naming who a pack is about. Empty
 * when the reader cannot read the people list; the pages then say "a person you cannot see".
 */
export const getPeopleNames = cache(
  async (): Promise<{
    readonly names: ReadonlyMap<string, string>;
    readonly locations: ReadonlyMap<string, string>;
  }> => {
    const api = await tenantApi();
    const { data } = await api.GET("/v1/people");
    const names = new Map<string, string>();
    const locations = new Map<string, string>();
    for (const person of data?.items ?? []) {
      names.set(person.id, sampleName(person, personNames(person).full, t));
      locations.set(person.id, person.locationId);
    }
    return { names, locations };
  },
);

/**
 * This site's origin for the link the releaser sends: `PUBLIC_WEB_URL` (set per environment), else
 * the address this request came to.
 */
export async function webOrigin(): Promise<string> {
  if (process.env.PUBLIC_WEB_URL) return process.env.PUBLIC_WEB_URL;
  const incoming = await headers();
  const host = incoming.get("x-forwarded-host") ?? incoming.get("host") ?? "localhost:3000";
  const proto =
    incoming.get("x-forwarded-proto")?.split(",")[0]?.trim() ??
    (process.env.NODE_ENV === "production" ? "https" : "http");
  return `${proto}://${host}`;
}
