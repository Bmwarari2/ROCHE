import { PersonHeader, Text, useTheme } from "@harbour/ui-native";
import { useQuery } from "@powersync/react";
import { Stack, useLocalSearchParams } from "expo-router";
import { useMemo } from "react";
import { ScrollView, View } from "react-native";
import { useSession } from "../../../app-state/session";
import { Screen } from "../../../components/Screen";
import { toPersonView } from "../../../people/person-view";
import {
  type AllergyRow,
  PERSON_ALLERGIES_SQL,
  PERSON_SQL,
  type PersonRow,
  personAllergiesParams,
  personParams,
} from "../../../people/queries";
import { usePersonPhoto } from "../../../people/use-person-photo";
import { useRecordScreenProtection } from "../../../security/use-record-protection";

/** Person record placeholder: identity header with safety flags, and active allergies. */
export default function PersonScreen() {
  useRecordScreenProtection("person-record");
  const theme = useTheme();
  const { personId } = useLocalSearchParams<{ personId: string }>();
  const { me } = useSession();
  const tenantId = me?.tenant.id ?? "";
  const id = typeof personId === "string" ? personId : "";

  const personQuery = useMemo(() => personParams(tenantId, id), [tenantId, id]);
  const allergyQuery = useMemo(() => personAllergiesParams(tenantId, id), [tenantId, id]);
  const { data: rows, isLoading } = useQuery<PersonRow>(PERSON_SQL, personQuery);
  const { data: allergies } = useQuery<AllergyRow>(PERSON_ALLERGIES_SQL, allergyQuery);
  const row = rows[0];
  const person = row ? toPersonView(row) : null;
  const photo = usePersonPhoto(id, person?.photoDocumentId ?? null);

  return (
    <Screen testID="person-screen">
      <Stack.Screen options={{ title: person?.displayName ?? "Record" }} />
      <ScrollView contentContainerStyle={{ padding: theme.space[2], gap: theme.space[2] }}>
        {person ? (
          <>
            <PersonHeader
              photo={photo}
              preferredName={person.preferredName}
              givenName={person.givenName}
              familyName={person.familyName}
              room={person.room}
              dateOfBirth={person.dateOfBirth}
              nhsNumber={person.nhsNumber}
              allergyStatus={person.allergyStatus}
              allergyCount={person.allergyCount}
              communicationNeeds={person.communicationNeeds}
            />
            {allergies.length > 0 ? (
              <View
                testID="allergy-list"
                style={{
                  backgroundColor: theme.colors.card,
                  borderRadius: theme.radius.card,
                  borderColor: theme.colors.border,
                  borderWidth: 1,
                  padding: theme.space[2],
                  gap: theme.space[1],
                }}
              >
                <Text variant="eyebrow" accessibilityRole="header">
                  Allergies
                </Text>
                {allergies.map((allergy) => (
                  <View key={allergy.id} accessible style={{ gap: theme.space[0.5] }}>
                    <Text emphasis selectable={false}>
                      {allergy.substance ?? "Substance not recorded"}
                    </Text>
                    <Text variant="bodyDense" tone="secondary" selectable={false}>
                      {[
                        allergy.reaction ? `Reaction: ${allergy.reaction}` : null,
                        allergy.severity ? `Severity: ${allergy.severity}` : null,
                      ]
                        .filter(Boolean)
                        .join(". ") || "No reaction details recorded"}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}
            <Text tone="secondary">
              Care notes, charts and medicines arrive in later phases of Harbour.
            </Text>
          </>
        ) : (
          <Text tone="secondary" testID="person-missing">
            {isLoading
              ? "Loading record"
              : "This record is not on this device. It may no longer be assigned to you."}
          </Text>
        )}
      </ScrollView>
    </Screen>
  );
}
