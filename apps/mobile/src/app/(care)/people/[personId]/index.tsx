import { Stack, useLocalSearchParams } from "expo-router";
import { useCarePerson } from "../../../../components/CarePersonHeader";
import { PersonRecord } from "../../../../components/PersonRecord";
import { Screen } from "../../../../components/Screen";
import { t } from "../../../../i18n/t";
import { useRecordScreenProtection } from "../../../../security/use-record-protection";

/**
 * A person's record in Care mode, as its own screen: on a phone, in portrait, and wherever a list
 * beside it would not fit (MOB-013). The record itself is `PersonRecord`.
 */
export default function PersonScreen() {
  useRecordScreenProtection("person-record");
  const { personId, task } = useLocalSearchParams<{ personId: string; task?: string }>();
  const id = typeof personId === "string" ? personId : "";
  const { person } = useCarePerson(id);
  return (
    <Screen testID="person-screen">
      <Stack.Screen options={{ title: person?.displayName ?? t("mobile.person.title") }} />
      <PersonRecord personId={id} task={typeof task === "string" && task ? task : null} />
    </Screen>
  );
}
