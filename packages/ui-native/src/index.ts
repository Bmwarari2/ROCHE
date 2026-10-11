/**
 * Harbour native components. Brand comes only from the shared tokens (`@harbour/ui/tokens`);
 * navigation chrome is left to the platform (expo-router stack and tabs).
 */
export { Avatar, type AvatarProps } from "./components/Avatar";
export {
  Button,
  type ButtonHaptic,
  type ButtonProps,
  type ButtonVariant,
} from "./components/Button";
export { ICON_STROKE_WIDTH, iconByName, type LucideIcon } from "./components/icons";
export { ListItem, type ListItemProps } from "./components/ListItem";
export { PersonFlags, type PersonFlagsProps } from "./components/PersonFlags";
export { PersonHeader, type PersonHeaderProps } from "./components/PersonHeader";
export {
  FlagChip,
  type FlagChipProps,
  StatusChip,
  type StatusChipProps,
} from "./components/StatusChip";
export { SyncBanner, type SyncBannerProps } from "./components/SyncBanner";
export { Text, type TextProps, type TextTone } from "./components/Text";
export * from "./logic/index";
export {
  type HapticsAdapter,
  ThemeProvider,
  type ThemeProviderProps,
  useHaptics,
  useTheme,
  useThemePreference,
} from "./theme/ThemeProvider";
