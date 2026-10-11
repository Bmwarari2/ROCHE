import { ukIsoDate } from "@harbour/domain";
import { useQuery } from "@powersync/react";
import { useMemo } from "react";
import { useTenantId } from "../care/hooks";
import { resuscitationFlag } from "../care/person-summary";
import { type AdvanceCareRow, PERSON_ADVANCE_CARE_SQL } from "../care/queries";
import { usePersonPhoto } from "../people/use-person-photo";
import { useCarePerson } from "./CarePersonHeader";
import { IdentityBarView } from "./IdentityBarView";

/**
 * The compact identity bar pinned above every Care mode form (HZ-001, clinical reviews C7 and round
 * 3 M4): photo, the name the person is known by with the family name, allergies, communication
 * needs and the resuscitation status, each flag an icon plus words. It stays in view while the
 * form scrolls, so the person being recorded for is never off screen. The full header follows in
 * the form.
 */
export function IdentityBar({ personId }: { readonly personId: string }) {
  const tenantId = useTenantId();
  const { person } = useCarePerson(personId);
  const photo = usePersonPhoto(personId, person?.photoDocumentId ?? null);
  const params = useMemo(() => [tenantId, personId], [tenantId, personId]);
  const { data: advanceCare } = useQuery<AdvanceCareRow>(PERSON_ADVANCE_CARE_SQL, params);
  const { flag } = resuscitationFlag(advanceCare, ukIsoDate(new Date()));
  if (!person) return null;
  return <IdentityBarView person={person} photo={photo} resuscitation={flag} />;
}
