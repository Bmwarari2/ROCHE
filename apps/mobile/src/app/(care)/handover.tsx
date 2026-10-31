import { Text, useTheme } from "@harbour/ui-native";
import { useQuery, useStatus } from "@powersync/react";
import { useEffect, useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import { useSession } from "../../app-state/session";
import { useVault } from "../../app-state/vault";
import {
  type AcknowledgementRow,
  acknowledgementState,
  expectedHandover,
  type HandoverItemViewRow,
  type HandoverRow,
  handoverEmpty,
  handoverHeader,
  handoverItems,
  handoverStatusView,
  shownItems,
} from "../../care/handover-view";
import { useAcknowledgeHandover, useTenantId } from "../../care/hooks";
import {
  HANDOVER_ITEMS_SQL,
  HANDOVER_LOCATIONS_SQL,
  HANDOVER_SHIFTS_SQL,
  HANDOVERS_SQL,
  MY_ACKNOWLEDGEMENT_SQL,
} from "../../care/queries";
import { Card } from "../../components/Card";
import { HandoverLocationCard } from "../../components/HandoverLocationCard";
import { Screen } from "../../components/Screen";
import { UploadIssues } from "../../components/UploadIssues";
import { appEnv } from "../../config/app-env";
import { t } from "../../i18n/t";
import { useRecordScreenProtection } from "../../security/use-record-protection";
import { HANDOVER_SHIFTS_META_ID, parseHandoverShifts } from "../../sync/handover-shifts";
import { lastSyncedAtOf } from "../../sync/sync-state";

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

/** One home's outgoing handover, its items and the reader's acknowledgement. */
function LocationHandover({
  location,
  handovers,
  shifts,
  now,
  lastSyncedAt,
}: {
  readonly location: LocationRow;
  readonly handovers: readonly HandoverRow[];
  readonly shifts: ReturnType<typeof parseHandoverShifts>;
  readonly now: Date;
  readonly lastSyncedAt: Date | null;
}) {
  const tenantId = useTenantId();
  const { me } = useSession();
  const acknowledge = useAcknowledgeHandover();
  const here = useMemo(
    () => handovers.filter((h) => h.location_id === location.id),
    [handovers, location.id],
  );
  const expected = expectedHandover({ now, nation: location.nation, shifts, handovers: here });
  // With no pattern the phone cannot tell which handover to expect: it shows the latest it holds,
  // said as such, never as the expected one.
  const shown =
    expected.kind === "not_final" || expected.kind === "final"
      ? expected.handover
      : expected.kind === "unknown"
        ? (here[0] ?? null)
        : null;
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
      locationId={location.id}
      locationName={location.name ?? t("mobile.handover.title")}
      status={handoverStatusView(expected)}
      latestOnly={expected.kind === "unknown" && shown !== null}
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

/**
 * The shift handover on the phone (care.md rule 14 and section 6; CARE-013, HZ-018): for each home
 * the phone holds, the outgoing handover, its state ("not compiled yet", "not final", final, or
 * "cannot tell"), its items worded from their summaries, and "I have read this handover", saved
 * here and sent when there is a connection. What the phone holds and from when is said first
 * (HZ-028), and the needs-attention list sits above, so a refused acknowledgement is never out of
 * sight (HZ-006).
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
  const shifts = useMemo(() => {
    const value = shiftRows[0]?.value;
    if (!value) return null;
    try {
      return parseHandoverShifts(JSON.parse(value));
    } catch {
      return null;
    }
  }, [shiftRows]);
  const lastSyncedAt = appEnv.demoMode ? vault.demoSeededAt : lastSyncedAtOf(status);
  const header = handoverHeader({
    now,
    windowDays: vault.offlineWindowDays,
    lastSyncedAt,
    demo: appEnv.demoMode,
  });

  return (
    <Screen testID="handover-screen">
      <ScrollView contentContainerStyle={{ padding: theme.space[2], gap: theme.space[2] }}>
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
        {locations.length === 0 ? (
          <Text testID="handover-no-locations">{t("mobile.handover.noLocations")}</Text>
        ) : null}
        {locations.map((location) => (
          <LocationHandover
            key={location.id}
            location={location}
            handovers={handovers}
            shifts={shifts}
            now={now}
            lastSyncedAt={lastSyncedAt}
          />
        ))}
      </ScrollView>
    </Screen>
  );
}
