import { Text, useTheme } from "@harbour/ui-native";
import { useQuery } from "@powersync/react";
import { useRouter } from "expo-router";
import { useCallback, useMemo } from "react";
import { ActivityIndicator, FlatList, View } from "react-native";
import { useSession } from "../../../app-state/session";
import { PersonListItem } from "../../../components/PersonListItem";
import { Screen } from "../../../components/Screen";
import { type PersonView, toPersonView } from "../../../people/person-view";
import { PEOPLE_LIST_SQL, type PersonRow, peopleListParams } from "../../../people/queries";
import { useRecordScreenProtection } from "../../../security/use-record-protection";

/**
 * People assigned to the signed-in user, read from the encrypted local database, so the list works
 * with no network once synced. Virtualised with FlatList.
 */
export default function PeopleScreen() {
  useRecordScreenProtection("people-list");
  const theme = useTheme();
  const router = useRouter();
  const { me } = useSession();
  const tenantId = me?.tenant.id ?? "";
  const params = useMemo(() => peopleListParams(tenantId), [tenantId]);
  const { data, isLoading, error } = useQuery<PersonRow>(PEOPLE_LIST_SQL, params);
  const people = useMemo(() => data.map(toPersonView), [data]);

  const open = useCallback(
    (personId: string) => router.push({ pathname: "/people/[personId]", params: { personId } }),
    [router],
  );
  const renderItem = useCallback(
    ({ item }: { item: PersonView }) => <PersonListItem person={item} onOpen={open} />,
    [open],
  );

  return (
    <Screen testID="people-screen">
      {error ? (
        <View style={{ padding: theme.space[2] }}>
          <Text tone="danger" accessibilityRole="alert">
            The people list could not be read from this device. Lock and unlock Harbour, then try
            again.
          </Text>
        </View>
      ) : null}
      <FlatList
        testID="people-list"
        data={people}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        windowSize={7}
        removeClippedSubviews
        accessibilityRole="list"
        ListHeaderComponent={
          people.length > 0 ? (
            <View style={{ paddingHorizontal: theme.space[2], paddingVertical: theme.space[1] }}>
              <Text variant="bodyDense" tone="secondary" testID="people-count">
                {people.length === 1 ? "1 person" : `${people.length} people`}
              </Text>
            </View>
          ) : null
        }
        ListEmptyComponent={
          isLoading ? (
            <ActivityIndicator
              style={{ marginTop: theme.space[4] }}
              color={theme.colors.textSecondary}
              accessibilityLabel="Loading people"
            />
          ) : (
            <View style={{ padding: theme.space[3], gap: theme.space[1] }} testID="people-empty">
              <Text emphasis>No people on this device yet</Text>
              <Text tone="secondary">
                People assigned to you appear here after the first sync. Check the banner above for
                the sync status.
              </Text>
            </View>
          )
        }
      />
    </Screen>
  );
}
