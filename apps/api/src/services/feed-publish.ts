import {
  candourRecord,
  capacityAssessment,
  consentRecord,
  incident,
  person,
  type Transaction,
  tenantUser,
} from "@harbour/db";
import {
  type CandourState,
  type FeedIncidentView,
  type FeedPersonName,
  type FeedPhotoBasis,
  feedPhotoBasis,
  type IncidentState,
} from "@harbour/domain";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { capacityViews, consentView } from "./mca";

/**
 * What composing a family update needs besides its source record (comms.md rules 6, 9 and 12;
 * HZ-022, HZ-060, HZ-061). Read in the system's view, because a holder of `comms.feed.publish`
 * may not see every resident at the location, every incident about the person or every consent;
 * none of it is returned, it only decides whether and how the update is written.
 */

/** The lawful basis for photos (rule 6): consent, the only basis built here (best interests: H-106). */
export async function photoBasisOf(
  tx: Transaction,
  personId: string,
  now: Date,
): Promise<FeedPhotoBasis> {
  const consents = await tx
    .select()
    .from(consentRecord)
    .where(and(eq(consentRecord.personId, personId), eq(consentRecord.decision, "photos")));
  const assessments = await tx
    .select()
    .from(capacityAssessment)
    .where(eq(capacityAssessment.personId, personId));
  return feedPhotoBasis({
    consents: consents.map(consentView),
    capacityAssessments: capacityViews(assessments),
    // The best-interests decision about photos needs its kind and outcome in the care schema
    // first (comms.md section 11); until then only consent opens photos.
    bestInterestsDecisions: [],
    at: now,
  });
}

const nameOf = (displayName: string): FeedPersonName => {
  const parts = displayName.trim().split(/\s+/);
  return { givenName: parts[0] ?? "", familyName: parts.slice(1).join(" ") };
};

export interface ComposeFacts {
  readonly otherResidents: readonly FeedPersonName[];
  readonly staff: readonly FeedPersonName[];
  readonly openIncidents: readonly FeedIncidentView[];
  readonly candourStates: readonly CandourState[];
  readonly photoBasis: FeedPhotoBasis;
}

export async function composeFacts(
  tx: Transaction,
  subject: { readonly id: string; readonly locationId: string },
  now: Date,
): Promise<ComposeFacts> {
  const residents = await tx
    .select({
      givenName: person.givenName,
      familyName: person.familyName,
      preferredName: person.preferredName,
    })
    .from(person)
    .where(
      and(
        eq(person.locationId, subject.locationId),
        ne(person.id, subject.id),
        isNull(person.deletedAt),
      ),
    );
  const staff = await tx
    .select({ displayName: tenantUser.displayName })
    .from(tenantUser)
    .where(isNull(tenantUser.deletedAt));
  const incidents = await tx
    .select({ id: incident.id, status: incident.status, informed: incident.familyInformedAt })
    .from(incident)
    .where(
      and(
        sql`${incident.personIds} @> ARRAY[${subject.id}]::uuid[]`,
        ne(incident.status, "closed"),
        isNull(incident.deletedAt),
      ),
    );
  const candour = await tx
    .select({ state: candourRecord.state })
    .from(candourRecord)
    .where(eq(candourRecord.personId, subject.id));
  return {
    otherResidents: residents,
    staff: staff.map((s) => nameOf(s.displayName)),
    // Until safety exposes whether the next of kin still have to be told (comms.md section 11), an
    // open incident whose family has not been recorded as told holds publishing: fail closed.
    openIncidents: incidents.map((i) => ({
      id: i.id,
      state: i.status as IncidentState,
      nextOfKinContact: i.informed ? "done" : "pending",
    })),
    candourStates: candour.map((c) => c.state as CandourState),
    photoBasis: await photoBasisOf(tx, subject.id, now),
  };
}
