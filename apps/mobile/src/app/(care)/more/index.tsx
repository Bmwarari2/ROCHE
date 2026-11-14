import { ListItem, ListSection, useTheme } from "@harbour/ui-native";
import { type Href, useRouter } from "expo-router";
import ClipboardList from "lucide-react-native/icons/clipboard-list";
import Clock from "lucide-react-native/icons/clock";
import GraduationCap from "lucide-react-native/icons/graduation-cap";
import Settings from "lucide-react-native/icons/settings";
import { ScrollView } from "react-native";
import { careDestinations } from "../../../app-state/care-destinations";
import { useSession } from "../../../app-state/session";
import { Screen } from "../../../components/Screen";
import { type MessageKey, t } from "../../../i18n/t";

interface Destination {
  readonly key: string;
  readonly title: MessageKey;
  readonly href: Href;
  readonly icon: typeof Settings;
}

/**
 * More (ADR-0138): Handover, Shifts and Training for those who have them, and Settings, in one
 * grouped list. Each is one tap from here, and the tab keeps where the member was.
 */
export default function MoreScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { me } = useSession();
  const destinations = careDestinations(me?.permissions ?? []);
  const rows: Destination[] = [
    ...(destinations.handover
      ? [
          {
            key: "handover",
            title: "mobile.handover.title",
            href: "/more/handover",
            icon: ClipboardList,
          } as const,
        ]
      : []),
    ...(destinations.shifts
      ? [{ key: "shifts", title: "mobile.tabs.shifts", href: "/more/shifts", icon: Clock } as const]
      : []),
    ...(destinations.training
      ? [
          {
            key: "training",
            title: "mobile.training.title",
            href: "/more/training",
            icon: GraduationCap,
          } as const,
        ]
      : []),
    { key: "settings", title: "mobile.tabs.settings", href: "/more/settings", icon: Settings },
  ];
  return (
    <Screen testID="more-screen">
      <ScrollView contentContainerStyle={{ padding: theme.space[2] }}>
        <ListSection>
          {rows.map(({ key, title, href, icon: Icon }) => (
            <ListItem
              key={key}
              testID={`more-${key}`}
              title={t(title)}
              leading={<Icon color={theme.colors.accent} size={24} strokeWidth={1.75} />}
              onPress={() => router.push(href)}
            />
          ))}
        </ListSection>
      </ScrollView>
    </Screen>
  );
}
