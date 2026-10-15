import { useTheme } from "@harbour/ui-native";
import { Tabs } from "expo-router";
import CalendarDays from "lucide-react-native/icons/calendar-days";
import ListChecks from "lucide-react-native/icons/list-checks";
import Settings from "lucide-react-native/icons/settings";
import Users from "lucide-react-native/icons/users";

/**
 * Care mode: Today, Round, People and Settings tabs. Tab icons are Lucide (never SF Symbols); see the
 * README for the planned move to expo-router native tabs once they leave "unstable".
 */
export default function CareLayout() {
  const theme = useTheme();
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
          title: "Today",
          tabBarButtonTestID: "tab-today",
          tabBarAccessibilityLabel: "Today",
          tabBarIcon: ({ color, size }) => (
            <CalendarDays color={color} size={size} strokeWidth={1.5} />
          ),
        }}
      />
      <Tabs.Screen
        name="round"
        options={{
          title: "Round",
          tabBarButtonTestID: "tab-round",
          tabBarAccessibilityLabel: "Round",
          tabBarIcon: ({ color, size }) => (
            <ListChecks color={color} size={size} strokeWidth={1.5} />
          ),
        }}
      />
      <Tabs.Screen
        name="people"
        options={{
          title: "People",
          headerShown: false,
          tabBarButtonTestID: "tab-people",
          tabBarAccessibilityLabel: "People",
          tabBarIcon: ({ color, size }) => <Users color={color} size={size} strokeWidth={1.5} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarButtonTestID: "tab-settings",
          tabBarAccessibilityLabel: "Settings",
          tabBarIcon: ({ color, size }) => <Settings color={color} size={size} strokeWidth={1.5} />,
        }}
      />
    </Tabs>
  );
}
