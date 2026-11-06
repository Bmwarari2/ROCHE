import { Button, useTheme } from "@harbour/ui-native";
import { useRouter } from "expo-router";
import { ScrollView } from "react-native";
import { useSession } from "../../../app-state/session";
import { ClockCard } from "../../../components/ClockCard";
import { Screen } from "../../../components/Screen";
import { ShiftList } from "../../../components/ShiftList";
import { UploadIssues } from "../../../components/UploadIssues";
import { t } from "../../../i18n/t";
import {
  LONE_WORKER_CHECK_IN,
  TIMESHEET_SELF,
  useClock,
  useMinute,
} from "../../../scheduling/hooks";

/**
 * The member's own shifts and clock on the phone (scheduling.md section 18; SCHED-002, SCHED-004):
 * "needs attention" first, so a refused clock-in is never out of sight (HZ-006, HZ-124), then the
 * clock, the coming week's shifts and, for those who work alone, lone working.
 */
export default function ShiftsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { me } = useSession();
  const now = useMinute();
  const { view, record } = useClock(now);
  const permissions = me?.permissions ?? [];
  const timesheet = permissions.includes(TIMESHEET_SELF);
  const lone = permissions.includes(LONE_WORKER_CHECK_IN);
  return (
    <Screen testID="shifts-screen">
      <ScrollView contentContainerStyle={{ padding: theme.space[2], gap: theme.space[2] }}>
        <UploadIssues />
        {timesheet ? <ClockCard view={view} onAction={record} /> : null}
        {timesheet ? <ShiftList items={view.shifts} /> : null}
        {lone ? (
          <Button
            label={t("mobile.lone.open")}
            variant="secondary"
            onPress={() => router.push("/shifts/lone-working")}
            testID="shifts-lone-working"
          />
        ) : null}
      </ScrollView>
    </Screen>
  );
}
