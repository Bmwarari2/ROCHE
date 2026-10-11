/**
 * The point-of-care header on every Care mode screen about a person (HZ-001): photo, the name
 * they are known by with the full name, date of birth and NHS number, room, allergies (HZ-007),
 * communication needs, the resuscitation status in words with an icon or "not recorded" (HZ-015),
 * and the prescribed IDDSI levels (HZ-016). Read from the encrypted database, so it shows offline.
 */
import { ukIsoDate } from "@harbour/domain";
import { PersonHeader, Text, useTheme } from "@harbour/ui-native";
import { useQuery } from "@powersync/react";
import { useMemo } from "react";
import { View } from "react-native";
import { useCareProfileState, useTenantId } from "../care/hooks";
import { carePersonHeaderModel } from "../care/person-header";
import { type AdvanceCareRow, PERSON_ADVANCE_CARE_SQL } from "../care/queries";
import { t } from "../i18n/t";
import { type PersonView, toPersonView } from "../people/person-view";
import { PERSON_SQL, type PersonRow, personParams } from "../people/queries";
import { usePersonPhoto } from "../people/use-person-photo";

export interface CarePerson {
  readonly person: PersonView | null;
  readonly loading: boolean;
}

/** The person row on the device for the signed-in tenant. */
export function useCarePerson(personId: string): CarePerson {
  const tenantId = useTenantId();
  const params = useMemo(() => personParams(tenantId, personId), [tenantId, personId]);
  const { data, isLoading } = useQuery<PersonRow>(PERSON_SQL, params);
  const row = data[0];
  return { person: row ? toPersonView(row) : null, loading: isLoading };
}

export function CarePersonHeader({ personId }: { readonly personId: string }) {
  const theme = useTheme();
  const tenantId = useTenantId();
  const { person, loading } = useCarePerson(personId);
  const photo = usePersonPhoto(personId, person?.photoDocumentId ?? null);
  const { profile, loaded: profileLoaded } = useCareProfileState(personId);
  const params = useMemo(() => [tenantId, personId], [tenantId, personId]);
  const { data: advanceCare } = useQuery<AdvanceCareRow>(PERSON_ADVANCE_CARE_SQL, params);

  if (!person) {
    return (
      <Text tone="secondary" testID="person-missing">
        {loading ? t("mobile.person.loading") : t("mobile.person.missing")}
      </Text>
    );
  }
  const { props, details } = carePersonHeaderModel({
    person,
    advanceCare,
    profile,
    profileLoaded,
    today: ukIsoDate(new Date()),
  });
  return (
    <View style={{ gap: theme.space[1] }}>
      <PersonHeader photo={photo} {...props} />
      {details.length > 0 ? (
        <Text
          variant="bodyDense"
          tone="secondary"
          selectable={false}
          testID="resuscitation-details"
        >
          {details.join(" ")}
        </Text>
      ) : null}
    </View>
  );
}
