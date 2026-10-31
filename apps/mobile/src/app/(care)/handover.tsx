import {
  FlagChip,
  iconByName,
  ListItem,
  SplitView,
  Text,
  useSplitLayout,
  useTheme,
} from "@harbour/ui-native";
import { useQuery, useStatus } from "@powersync/react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import { useSession } from "../../app-state/session";
import { useVault } from "../../app-state/vault";
import {
  type AcknowledgementRow,
  acknowledgementState,
  type HandoverEntry,
  type HandoverItemViewRow,
  type HandoverRow,
  handoverEmpty,
  handoverEntries,
  handoverHeader,
  handoverItems,
  shownItems,
} from "../../care/handover-view";
import { useAcknowledgeHandover, useTenantId } from "../../care/hooks";
import {
  HANDOVER_ITEMS_SQL,
  HANDOVER_LOCATIONS_SQL,
  HANDOVER_PEOPLE_HOMES_SQL,
  HANDOVER_SHIFTS_SQL,
  HANDOVERS_SQL,
  META_VALUE_SQL,
  MY_ACKNOWLEDGEMENT_SQL,
} from "../../care/queries";
import { Card } from "../../components/Card";
import { HandoverLocationCard } from "../../components/HandoverLocationCard";
import { Screen } from "../../components/Screen";
import { UploadIssues } from "../../components/UploadIssues";
import { appEnv } from "../../config/app-env";
import { t } from "../../i18n/t";
import { useRecordScreenProtection } from "../../security/use-record-protection";
import {
  HANDOVER_SHIFTS_META_ID,
  type HandoverShifts,
  parseCachedHandoverConfig,
} from "../../sync/handover-shifts";
import { OFFLINE_DAYS_META_ID, parseCachedOfflineDays } from "../../sync/offline-days";
import { lastSyncedAtOf } from "../../sync/sync-state";
import { useWriteScope } from "../../sync/write-scope-store";

/** The time, again each minute, so the expected handover moves on when a shift changes. */
function useMinute(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

interface LocationRow {
  readonly id: string;
  readonly name: string | null;
  readonly nation: string | null;
}

/** One handover card: a handover (or none), its items and the reader's acknowledgement. */
function HandoverEntryCard({
  location,
  entry,
  lastSyncedAt,
}: {
  readonly location: LocationRow;
  readonly entry: HandoverEntry;
  readonly lastSyncedAt: Date | null;
}) {
  const tenantId = useTenantId();
  const { me } = useSession();
  const acknowledge = useAcknowledgeHandover();
  const shown = entry.handover;
  const itemParams = useMemo(() => [tenantId, shown?.id ?? ""], [tenantId, shown?.id]);
  const ackParams = useMemo(
    () => [tenantId, shown?.id ?? "", me?.tenantUserId ?? ""],
    [tenantId, shown?.id, me?.tenantUserId],
  );
  const { data: itemRows } = useQuery<HandoverItemViewRow>(HANDOVER_ITEMS_SQL, itemParams);
  const { data: ackRows } = useQuery<AcknowledgementRow>(MY_ACKNOWLEDGEMENT_SQL, ackParams);
  const ack = shown ? (ackRows[0] ?? null) : null;
  const items = useMemo(
    () => (shown ? handoverItems(itemRows, ack) : null),
    [shown, itemRows, ack],
  );
  const state = items ? acknowledgementState(items, ack) : "nothing_to_acknowledge";

  return (
    <HandoverLocationCard
      locationId={`${location.id}-${entry.role}`}
      locationName={location.name ?? t("mobile.handover.title")}
      status={entry.status}
      latestOnly={entry.role === "latest" && shown !== null}
      items={items}
      empty={handoverEmpty(lastSyncedAt, appEnv.demoMode)}
      acknowledgement={state}
      onAcknowledge={
        shown && items && items.length > 0
          ? () =>
              acknowledge(
                { id: shown.id, tenant_id: shown.tenant_id, location_id: shown.location_id },
                shownItems(items),
              )
          : null
      }
    />
  );
}

/** A home and its handover cards, newest first (`handoverEntries`). */
interface LocationEntries {
  readonly location: LocationRow;
  readonly entries: readonly HandoverEntry[];
}

function locationEntries(
  locations: readonly LocationRow[],
  handovers: readonly HandoverRow[],
  shifts: HandoverShifts | null,
  now: Date,
): LocationEntries[] {
  return locations.map((location) => ({
    location,
    entries: handoverEntries({
      now,
      nation: location.nation,
      shifts,
      handovers: handovers.filter((h) => h.location_id === location.id),
    }),
  }));
}

/** A home's handover cards. */
function LocationHandover({
  location,
  entries,
  lastSyncedAt,
}: {
  readonly location: LocationRow;
  readonly entries: readonly HandoverEntry[];
  readonly lastSyncedAt: Date | null;
}) {
  return (
    <>
      {entries.map((entry) => (
        <HandoverEntryCard
          key={entry.role}
          location={location}
          entry={entry}
          lastSyncedAt={lastSyncedAt}
        />
      ))}
    </>
  );
}

/**
 * The shift handover on the phone (care.md rule 14 and section 6; CARE-013, HZ-018): for each home
 * the phone holds, the outgoing handover, its state ("not compiled yet", "not final", final, or
 * "cannot tell"), its items worded from their summaries, and "I have read this handover", saved
 * here and sent when there is a connection. What the phone holds and from when is said first
 * (HZ-028), and the needs-attention list sits above, so a refused acknowledgement is never out of
 * sight (HZ-006).
 *
 * On a tablet in landscape (MOB-013) the homes are listed on the left, each with its handover's
 * state as an icon and a word, and the chosen home's handover is read and acknowledged on the
 * right. The first home is shown until the reader chooses another.
 */
export default function HandoverScreen() {
  useRecordScreenProtection("handover");
  const theme = useTheme();
  const vault = useVault();
  const status = useStatus();
  const tenantId = useTenantId();
  const now = useMinute();
  const tenantParams = useMemo(() => [tenantId], [tenantId]);
  const shiftParams = useMemo(() => [HANDOVER_SHIFTS_META_ID], []);
  const { data: locations } = useQuery<LocationRow>(HANDOVER_LOCATIONS_SQL, tenantParams);
  const { data: handovers } = useQuery<HandoverRow>(HANDOVERS_SQL, tenantParams);
  const { data: shiftRows } = useQuery<{ value: string }>(HANDOVER_SHIFTS_SQL, shiftParams);
  const writeScope = useWriteScope();
  const { data: peopleHomes } = useQuery<{ id: string; location_id: string }>(
    HANDOVER_PEOPLE_HOMES_SQL,
    tenantParams,
  );
  const config = useMemo(() => parseCachedHandoverConfig(shiftRows[0]?.value), [shiftRows]);
  // Only homes whose handover the phone receives (clinical review M2): those the token names; with
  // assignment, the homes of the people assigned to the reader (the token's person ids); and any
  // home with a handover on the phone. With no copy kept (a demo, or before the first token),
  // every home is listed and its card says it cannot tell.
  const reached = useMemo(() => {
    if (!config) return locations;
    const homes = new Set(config.locationIds);
    const assignedIds = config.assigned ? new Set(writeScope?.personIds ?? []) : new Set();
    for (const p of peopleHomes) if (assignedIds.has(p.id)) homes.add(p.location_id);
    for (const h of handovers) homes.add(h.location_id);
    return locations.filter((l) => homes.has(l.id));
  }, [config, locations, peopleHomes, handovers, writeScope]);
  const lastSyncedAt = appEnv.demoMode ? vault.demoSeededAt : lastSyncedAtOf(status);
  const daysParams = useMemo(() => [OFFLINE_DAYS_META_ID], []);
  const { data: daysRows } = useQuery<{ value: string }>(META_VALUE_SQL, daysParams);
  const offlineDays = useMemo(() => parseCachedOfflineDays(daysRows[0]?.value), [daysRows]);
  const header = handoverHeader({
    now,
    offlineDays,
    lastSyncedAt,
    demo: appEnv.demoMode,
  });
  const homes = useMemo(
    () => locationEntries(reached, handovers, config?.shifts ?? null, now),
    [reached, handovers, config, now],
  );
  const layout = useSplitLayout();
  const [chosen, setChosen] = useState<string | null>(null);
  const chosenHome = homes.find((h) => h.location.id === chosen) ?? null;
  const shownHome = chosenHome ?? homes[0] ?? null;

  const top: ReactNode = (
    <>
      <Card title={t("mobile.handover.onThisPhone")} testID="handover-header">
        <View accessible style={{ gap: theme.space[0.5] }}>
          <Text testID="handover-window">{header.holds}</Text>
          <Text variant="bodyDense" tone="secondary" testID="handover-synced">
            {header.synced}
          </Text>
          <Text variant="bodyDense" tone="secondary">
            {header.incomplete}
          </Text>
        </View>
      </Card>
      <UploadIssues />
      {reached.length === 0 ? (
        <Text testID="handover-no-locations">{t("mobile.handover.noLocations")}</Text>
      ) : null}
    </>
  );

  if (layout.mode !== "split") {
    return (
      <Screen testID="handover-screen">
        <ScrollView contentContainerStyle={{ padding: theme.space[2], gap: theme.space[2] }}>
          {top}
          {homes.map(({ location, entries }) => (
            <LocationHandover
              key={location.id}
              location={location}
              entries={entries}
              lastSyncedAt={lastSyncedAt}
            />
          ))}
        </ScrollView>
      </Screen>
    );
  }

  const shownName = shownHome?.location.name ?? t("mobile.handover.title");
  return (
    <Screen testID="handover-screen">
      <SplitView
        testID="handover-split"
        listWidth={layout.listWidth}
        detailKey={chosenHome?.location.id ?? null}
        detailTitle={shownHome ? t("mobile.split.handoverOf", { home: shownName }) : null}
        list={
          <ScrollView
            contentContainerStyle={{ paddingVertical: theme.space[2], gap: theme.space[2] }}
          >
            <View style={{ paddingHorizontal: theme.space[2], gap: theme.space[2] }}>{top}</View>
            {homes.length > 0 ? (
              <View accessibilityRole="list">
                <Text
                  variant="eyebrow"
                  accessibilityRole="header"
                  style={{ paddingHorizontal: theme.space[2], paddingBottom: theme.space[1] }}
                >
                  {t("mobile.split.homes")}
                </Text>
                {homes.map(({ location, entries }) => (
                  <ListItem
                    key={location.id}
                    testID={`handover-home-${location.id}`}
                    title={location.name ?? t("mobile.handover.title")}
                    accessibilityLabel={[
                      location.name ?? t("mobile.handover.title"),
                      ...entries.map((e) => e.status.chip.label),
                    ].join(". ")}
                    accessibilityHint={t("mobile.split.openHandoverHint")}
                    accessories={
                      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space[1] }}>
                        {entries.map((entry) => (
                          <FlagChip
                            key={entry.role}
                            tone={entry.status.chip.tone}
                            icon={iconByName(entry.status.chip.icon)}
                            label={entry.status.chip.label}
                          />
                        ))}
                      </View>
                    }
                    showChevron={false}
                    selected={shownHome?.location.id === location.id}
                    selectedLabel={t("mobile.split.shown")}
                    onPress={() => setChosen(location.id)}
                  />
                ))}
              </View>
            ) : null}
          </ScrollView>
        }
        detail={
          shownHome ? (
            <ScrollView
              key={shownHome.location.id}
              contentContainerStyle={{ padding: theme.space[2], gap: theme.space[2] }}
            >
              <LocationHandover
                location={shownHome.location}
                entries={shownHome.entries}
                lastSyncedAt={lastSyncedAt}
              />
            </ScrollView>
          ) : (
            <View style={{ padding: theme.space[3] }} testID="handover-split-empty">
              <Text tone="secondary">{t("mobile.split.chooseHandover")}</Text>
            </View>
          )
        }
      />
    </Screen>
  );
}
