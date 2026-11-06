import { SplitView, Text, useSplitLayout, useTheme } from "@harbour/ui-native";
import { useQuery } from "@powersync/react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { ActivityIndicator, FlatList, View } from "react-native";
import { useSession } from "../../../app-state/session";
import { chosenPerson } from "../../../care/split-selection";
import { PersonListItem } from "../../../components/PersonListItem";
import { PersonRecord } from "../../../components/PersonRecord";
import { Screen } from "../../../components/Screen";
import { t } from "../../../i18n/t";
import { type PersonView, toPersonView } from "../../../people/person-view";
import { PEOPLE_LIST_SQL, type PersonRow, peopleListParams } from "../../../people/queries";
import { useRecordScreenProtection } from "../../../security/use-record-protection";

/**
 * People assigned to the signed-in user, read from the encrypted local database, so the list works
 * with no network once synced. Virtualised with FlatList.
 *
 * On a tablet in landscape (MOB-013) the chosen person's record sits beside the list, with the
 * point-of-care header at the top of its pane (HZ-001). The choice is the route's `person`
 * parameter, so it is still there when a note or chart saved from the record comes back; it is
 * shown only while that person is in the list, by id, so a list that re-sorts as sync applies
 * changes never swaps the record under the reader.
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
  const layout = useSplitLayout();
  const split = layout.mode === "split";
  const { person: chosen } = useLocalSearchParams<{ person?: string }>();
  const selected = split ? chosenPerson(people, chosen) : null;

  const open = useCallback(
    (personId: string) =>
      split
        ? router.setParams({ person: personId })
        : router.push({ pathname: "/people/[personId]", params: { personId } }),
    [router, split],
  );
  const selectedId = selected?.id ?? null;
  // Turned to portrait with a record beside the list: the record opens as its own screen, so the
  // reader keeps their place, and the choice is cleared so it never comes back unasked (#73
  // reviews: accessibility M5, clinical H2).
  const wasSplit = useRef(split);
  const lastSelected = useRef<string | null>(selectedId);
  if (split) lastSelected.current = selectedId;
  useEffect(() => {
    if (wasSplit.current && !split && lastSelected.current) {
      const personId = lastSelected.current;
      lastSelected.current = null;
      router.setParams({ person: undefined });
      router.push({ pathname: "/people/[personId]", params: { personId } });
    }
    wasSplit.current = split;
  }, [split, router]);
  const renderItem = useCallback(
    ({ item }: { item: PersonView }) => (
      <PersonListItem
        person={item}
        onOpen={open}
        opensBeside={split}
        selected={item.id === selectedId}
      />
    ),
    [open, split, selectedId],
  );

  const list = (
    <View style={{ flex: 1 }}>
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
        extraData={selectedId}
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
    </View>
  );

  return (
    <Screen testID="people-screen">
      {layout.mode === "split" ? (
        <SplitView
          testID="people-split"
          listWidth={layout.listWidth}
          list={list}
          detailKey={selectedId}
          detailTitle={
            selected ? t("mobile.split.recordOf", { person: selected.displayName }) : null
          }
          detail={
            selected ? (
              <View testID="person-screen" style={{ flex: 1 }}>
                <PersonRecord key={selected.id} personId={selected.id} task={null} />
              </View>
            ) : (
              <View style={{ padding: theme.space[3] }} testID="people-split-empty">
                <Text tone="secondary">{t("mobile.split.choosePerson")}</Text>
              </View>
            )
          }
        />
      ) : (
        list
      )}
    </Screen>
  );
}
