import { useTheme } from "@harbour/ui-native";
import { Tabs } from "expo-router";
import CalendarDays from "lucide-react-native/icons/calendar-days";
import ClipboardList from "lucide-react-native/icons/clipboard-list";
import Clock from "lucide-react-native/icons/clock";
import GraduationCap from "lucide-react-native/icons/graduation-cap";
import ListChecks from "lucide-react-native/icons/list-checks";
import Settings from "lucide-react-native/icons/settings";
import Users from "lucide-react-native/icons/users";
import { useSession } from "../../app-state/session";
import { t } from "../../i18n/t";
import { useDmdSubsetRefresh } from "../../medicines/use-dmd-subset";
import { TRAINING_SELF } from "../../training/hooks";

/** Who takes part in the handover, as the API and the handover streams decide (care.md rule 14). */
const HANDOVER_PERMISSION = "care.handover.manage";

/** Who has a Shifts tab: those who clock their own time or work alone (scheduling.md section 18). */
const SHIFTS_PERMISSIONS = ["scheduling.timesheet.self", "scheduling.lone_worker.check_in"];

/**
 * Care mode: Today, Round, Handover (only for those who take part in the handover, whose phone
 * receives it), Shifts (only for those who clock their own time or work alone), Training beside it
 * (only for those who read their own training; H-1365), People and Settings
 * tabs. Tab icons are Lucide (never SF Symbols); see the
 * README for the planned move to expo-router native tabs once they leave "unstable".
 */
export default function CareLayout() {
  const theme = useTheme();
  // The dm+d rows the MARs need, kept fresh while connected (slice 68).
  useDmdSubsetRefresh();
  const { me } = useSession();
  const handover = (me?.permissions ?? []).includes(HANDOVER_PERMISSION);
  const shifts = SHIFTS_PERMISSIONS.some((p) => (me?.permissions ?? []).includes(p));
  const training = (me?.permissions ?? []).includes(TRAINING_SELF);
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: theme.colors.accent,
        tabBarInactiveTintColor: theme.colors.textSecondary,
        tabBarStyle: { backgroundColor: theme.colors.bg, borderTopColor: theme.colors.border },
        // Type never goes below 15 pt on mobile (section 8), tab labels included.
        tabBarLabelStyle: { fontSize: theme.minFontSize },
        tabBarAllowFontScaling: true,
        headerStyle: { backgroundColor: theme.colors.bg },
        headerTitleStyle: { color: theme.colors.text, fontSize: theme.type.body.fontSize },
        headerShadowVisible: false,
      }}
    >
      <Tabs.Screen
        name="today"
        options={{
          title: t("mobile.today.title"),
          tabBarButtonTestID: "tab-today",
          tabBarAccessibilityLabel: t("mobile.today.title"),
          tabBarIcon: ({ color, size }) => (
            <CalendarDays color={color} size={size} strokeWidth={1.5} />
          ),
        }}
      />
      <Tabs.Screen
        name="round"
        options={{
          title: t("mobile.round.title"),
          // The round has its own stack (round/_layout.tsx), which draws the header.
          headerShown: false,
          tabBarButtonTestID: "tab-round",
          tabBarAccessibilityLabel: t("mobile.round.title"),
          tabBarIcon: ({ color, size }) => (
            <ListChecks color={color} size={size} strokeWidth={1.5} />
          ),
        }}
      />
      <Tabs.Screen
        name="handover"
        options={{
          title: t("mobile.handover.title"),
          tabBarButtonTestID: "tab-handover",
          tabBarAccessibilityLabel: t("mobile.handover.title"),
          // Hidden for those the handover streams send nothing to, so the phone never says
          // "not compiled yet" for a handover it could never receive.
          href: handover ? undefined : null,
          tabBarIcon: ({ color, size }) => (
            <ClipboardList color={color} size={size} strokeWidth={1.5} />
          ),
        }}
      />
      <Tabs.Screen
        name="shifts"
        options={{
          title: t("mobile.tabs.shifts"),
          headerShown: false,
          tabBarButtonTestID: "tab-shifts",
          tabBarAccessibilityLabel: t("mobile.tabs.shifts"),
          href: shifts ? undefined : null,
          tabBarIcon: ({ color, size }) => <Clock color={color} size={size} strokeWidth={1.5} />,
        }}
      />
      <Tabs.Screen
        name="training"
        options={{
          // Beside Shifts (H-1365): the member's own courses, for holders of TRAINING_SELF.
          title: t("mobile.training.title"),
          headerShown: false,
          tabBarButtonTestID: "tab-training",
          tabBarAccessibilityLabel: t("mobile.training.title"),
          href: training ? undefined : null,
          tabBarIcon: ({ color, size }) => (
            <GraduationCap color={color} size={size} strokeWidth={1.5} />
          ),
        }}
      />
      <Tabs.Screen
        name="people"
        options={{
          title: t("mobile.tabs.people"),
          headerShown: false,
          tabBarButtonTestID: "tab-people",
          tabBarAccessibilityLabel: t("mobile.tabs.people"),
          tabBarIcon: ({ color, size }) => <Users color={color} size={size} strokeWidth={1.5} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: t("mobile.tabs.settings"),
          tabBarButtonTestID: "tab-settings",
          tabBarAccessibilityLabel: t("mobile.tabs.settings"),
          tabBarIcon: ({ color, size }) => <Settings color={color} size={size} strokeWidth={1.5} />,
        }}
      />
    </Tabs>
  );
}
