import { ICON_STROKE_WIDTH, ListItem, ListSection, useTheme } from "@harbour/ui-native";
import ClipboardList from "lucide-react-native/icons/clipboard-list";
import Clock from "lucide-react-native/icons/clock";
import GraduationCap from "lucide-react-native/icons/graduation-cap";
import Settings from "lucide-react-native/icons/settings";
import {
  careDestinations,
  LONE_WORKER_CHECK_IN,
  TIMESHEET_SELF,
} from "../app-state/care-destinations";
import { t } from "../i18n/t";

/** The icon on each row of More, the platforms' list icon size; the divider starts after it. */
const ICON_SIZE = 24;

/** Where each row of More goes. */
export type MoreDestination = "handover" | "shifts" | "training" | "settings";

export interface MoreRow {
  readonly key: MoreDestination;
  readonly title: string;
  readonly subtitle: string;
  readonly icon: typeof Settings;
}

/**
 * More's rows, from the member's permissions (ADR-0138): Handover, Shifts and Training for those
 * who have them, and Settings always. Each says in a line what it holds, so nothing moved under
 * More is hidden behind a bare word (redesign accessibility review M4).
 */
export function moreRows(permissions: readonly string[]): MoreRow[] {
  const destinations = careDestinations(permissions);
  const clock = permissions.includes(TIMESHEET_SELF);
  const lone = permissions.includes(LONE_WORKER_CHECK_IN);
  const shiftsKind = clock && lone ? "both" : clock ? "clock" : "lone";
  return [
    ...(destinations.handover
      ? [
          {
            key: "handover" as const,
            title: t("mobile.handover.title"),
            subtitle: t("mobile.more.handoverHint"),
            icon: ClipboardList,
          },
        ]
      : []),
    ...(destinations.shifts
      ? [
          {
            key: "shifts" as const,
            title: t("mobile.tabs.shifts"),
            subtitle: t("mobile.more.shiftsHint", { kind: shiftsKind }),
            icon: Clock,
          },
        ]
      : []),
    ...(destinations.training
      ? [
          {
            key: "training" as const,
            title: t("mobile.training.title"),
            subtitle: t("mobile.more.trainingHint"),
            icon: GraduationCap,
          },
        ]
      : []),
    {
      key: "settings",
      title: t("mobile.tabs.settings"),
      subtitle: t("mobile.more.settingsHint"),
      icon: Settings,
    },
  ];
}

/** More as one grouped list; the screen supplies where each row goes. */
export function MoreList({
  permissions,
  onOpen,
}: {
  readonly permissions: readonly string[];
  readonly onOpen: (destination: MoreDestination) => void;
}) {
  const theme = useTheme();
  return (
    <ListSection testID="more-list">
      {moreRows(permissions).map(({ key, title, subtitle, icon: Icon }) => (
        <ListItem
          key={key}
          testID={`more-${key}`}
          title={title}
          subtitle={subtitle}
          leadingSize={ICON_SIZE}
          leading={
            <Icon color={theme.colors.accent} size={ICON_SIZE} strokeWidth={ICON_STROKE_WIDTH} />
          }
          onPress={() => onOpen(key)}
        />
      ))}
    </ListSection>
  );
}
