/**
 * The Lucide icons this package renders, imported one by one so the bundle carries only these.
 * Icons are monochrome and drawn at a 1.5 stroke (section 8).
 */
import type { ClinicalStatus, clinicalStatus } from "@harbour/ui/tokens";
import type { LucideIcon } from "lucide-react-native";
import CircleAlert from "lucide-react-native/icons/circle-alert";
import CircleCheck from "lucide-react-native/icons/circle-check";
import CircleMinus from "lucide-react-native/icons/circle-minus";
import CircleQuestionMark from "lucide-react-native/icons/circle-question-mark";
import Clock from "lucide-react-native/icons/clock";
import CloudAlert from "lucide-react-native/icons/cloud-alert";
import CloudUpload from "lucide-react-native/icons/cloud-upload";
import HeartOff from "lucide-react-native/icons/heart-off";
import HeartPulse from "lucide-react-native/icons/heart-pulse";
import MessageSquareText from "lucide-react-native/icons/message-square-text";
import RefreshCw from "lucide-react-native/icons/refresh-cw";
import TriangleAlert from "lucide-react-native/icons/triangle-alert";
import User from "lucide-react-native/icons/user";
import Utensils from "lucide-react-native/icons/utensils";
import WifiOff from "lucide-react-native/icons/wifi-off";
import type { AllergyFlag } from "../logic/person";
import type { SyncBannerIcon } from "../logic/sync-banner";

export type { LucideIcon };

export const ICON_STROKE_WIDTH = 1.5;

/** Icons for the care record's own flags: resuscitation status, IDDSI levels and upload state. */
export type CareFlagIcon = "heart-pulse" | "heart-off" | "utensils" | "cloud-upload";

/** Every icon name the tokens and the pure logic can produce; the map below must cover them all. */
export type IconName =
  | (typeof clinicalStatus)[ClinicalStatus]["icon"]
  | SyncBannerIcon
  | AllergyFlag["icon"]
  | CareFlagIcon
  | "message-square-text"
  | "user";

/** Icons referenced by name in the shared tokens and in the pure logic. */
export const namedIcons: Readonly<Record<IconName, LucideIcon>> = {
  "circle-alert": CircleAlert,
  "circle-check": CircleCheck,
  "circle-help": CircleQuestionMark,
  "circle-minus": CircleMinus,
  clock: Clock,
  "cloud-alert": CloudAlert,
  "cloud-upload": CloudUpload,
  "heart-off": HeartOff,
  "heart-pulse": HeartPulse,
  "message-square-text": MessageSquareText,
  "refresh-cw": RefreshCw,
  "triangle-alert": TriangleAlert,
  user: User,
  utensils: Utensils,
  "wifi-off": WifiOff,
};

function isIconName(name: string): name is IconName {
  return Object.hasOwn(namedIcons, name);
}

/** Looks up an icon by name; an unknown name falls back to the alert circle, never to nothing. */
export function iconByName(name: string): LucideIcon {
  return isIconName(name) ? namedIcons[name] : CircleAlert;
}

export { MessageSquareText, TriangleAlert, User };
