import { Button, Text, useTheme } from "@harbour/ui-native";
import { useQuery } from "@powersync/react";
import { useRouter } from "expo-router";
import { useMemo } from "react";
import { ScrollView, View } from "react-native";
import { useSession } from "../../app-state/session";
import { Screen } from "../../components/Screen";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "Saturday 11 October 2026" in the device's local time. */
function longDate(date: Date): string {
  return `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

/** Today: a Phase 0 summary. Tasks, alerts and handover arrive with their modules. */
export default function TodayScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { me } = useSession();
  const tenantId = me?.tenant.id ?? "";
  const params = useMemo(() => [tenantId], [tenantId]);
  const { data } = useQuery<{ count: number }>(
    "SELECT COUNT(*) AS count FROM person WHERE tenant_id = ?",
    params,
  );
  const count = Number(data[0]?.count ?? 0);

  return (
    <Screen testID="today-screen">
      <ScrollView contentContainerStyle={{ padding: theme.space[2], gap: theme.space[2] }}>
        <View style={{ gap: theme.space[0.5] }}>
          <Text variant="title" accessibilityRole="header">
            {me ? `Hello, ${me.user.name.split(" ")[0]}` : "Today"}
          </Text>
          <Text tone="secondary">{longDate(new Date())}</Text>
          {me ? <Text tone="secondary">{me.tenant.name}</Text> : null}
        </View>
        <View
          style={{
            backgroundColor: theme.colors.card,
            borderRadius: theme.radius.card,
            borderColor: theme.colors.border,
            borderWidth: 1,
            padding: theme.space[2],
            gap: theme.space[1.5],
          }}
        >
          <Text variant="eyebrow" testID="today-people-count">
            {count === 1 ? "1 person on this device" : `${count} people on this device`}
          </Text>
          <Text tone="secondary">
            Tasks, alerts and handover notes will appear here in a later phase.
          </Text>
          <Button
            label="View people"
            onPress={() => router.push("/people")}
            testID="today-view-people"
          />
        </View>
      </ScrollView>
    </Screen>
  );
}
