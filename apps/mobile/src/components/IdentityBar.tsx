import { ukIsoDate } from "@harbour/domain";
import { Avatar, PersonFlags, Text, useTheme } from "@harbour/ui-native";
import { useQuery } from "@powersync/react";
import { useMemo } from "react";
import { View } from "react-native";
import { useTenantId } from "../care/hooks";
import { resuscitationFlag } from "../care/person-summary";
import { type AdvanceCareRow, PERSON_ADVANCE_CARE_SQL } from "../care/queries";
import { usePersonPhoto } from "../people/use-person-photo";
import { useCarePerson } from "./CarePersonHeader";

/**
 * The compact identity bar pinned above every Care mode form (HZ-001, clinical review C7): photo,
 * the name the person is known by with the family name, allergies and the resuscitation status,
 * each flag an icon plus words. It stays in view while the form scrolls, so the person being
 * recorded for is never off screen. The full header follows in the form.
 */
export function IdentityBar({ personId }: { readonly personId: string }) {
  const theme = useTheme();
  const tenantId = useTenantId();
  const { person } = useCarePerson(personId);
  const photo = usePersonPhoto(personId, person?.photoDocumentId ?? null);
  const params = useMemo(() => [tenantId, personId], [tenantId, personId]);
  const { data: advanceCare } = useQuery<AdvanceCareRow>(PERSON_ADVANCE_CARE_SQL, params);
  const { flag } = resuscitationFlag(advanceCare, ukIsoDate(new Date()));
  if (!person) return null;

  return (
    <View
      testID="identity-bar"
      accessible
      accessibilityRole="header"
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: theme.space[1.5],
        paddingHorizontal: theme.space[2],
        paddingVertical: theme.space[1],
        backgroundColor: theme.colors.card,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      }}
    >
      <Avatar
        photo={photo}
        name={{
          preferredName: person.preferredName,
          givenName: person.givenName,
          familyName: person.familyName,
        }}
        size={36}
      />
      <View style={{ flex: 1, gap: theme.space[0.5] }}>
        <Text emphasis numberOfLines={1} selectable={false} testID="identity-bar-name">
          {person.displayName}
        </Text>
        <PersonFlags
          allergyStatus={person.allergyStatus}
          allergyCount={person.allergyCount}
          communicationNeedsCount={0}
          context="record"
          additionalFlags={[flag]}
          testID="identity-bar-flags"
        />
      </View>
    </View>
  );
}
