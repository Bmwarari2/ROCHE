import { useTheme } from "@harbour/ui-native";
import { Tabs } from "expo-router";
import CalendarDays from "lucide-react-native/icons/calendar-days";
import ClipboardList from "lucide-react-native/icons/clipboard-list";
import ListChecks from "lucide-react-native/icons/list-checks";
import Settings from "lucide-react-native/icons/settings";
import Users from "lucide-react-native/icons/users";
import { useSession } from "../../app-state/session";
import { t } from "../../i18n/t";

/** Who takes part in the handover, as the API and the handover streams decide (care.md rule 14). */
const HANDOVER_PERMISSION = "care.handover.manage";

/**
 * Care mode: Today, Round, Handover (only for those who take part in the handover, whose phone
 * receives it), People and Settings tabs. Tab icons are Lucide (never SF Symbols); see the
 * README for the planned move to expo-router native tabs once they leave "unstable".
 */
export default function CareLayout() {
  const theme = useTheme();
  const { me } = useSession();
  const handover = (me?.permissions ?? []).includes(HANDOVER_PERMISSION);
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
