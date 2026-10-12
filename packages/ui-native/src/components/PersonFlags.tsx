import { StyleSheet, View } from "react-native";
import { communicationFlagLabel, describeAllergyFlag, type HeaderFlag } from "../logic/person";
import { useTheme } from "../theme/ThemeProvider";
import { iconByName, MessageSquareText } from "./icons";
import { FlagChip } from "./StatusChip";

export interface PersonFlagsProps {
  /** `person.allergy_status`: unknown, no_known_allergies or has_allergies. */
  readonly allergyStatus: string | null | undefined;
  /** Active allergy rows on the device for this person. */
  readonly allergyCount: number;
  readonly communicationNeedsCount: number;
  /**
   * Lists pass "list" to hide the calm "No known allergies" chip and limit alert fatigue (HZ-005);
   * record screens pass "record" so every allergy state is always shown (HZ-007).
   */
  readonly context?: "list" | "record";
  /** Further flags after allergies and communication needs, such as the resuscitation status. */
  readonly additionalFlags?: readonly HeaderFlag[];
  readonly testID?: string;
}

/** Allergy and communication-needs flags, each an icon plus words, never colour alone. */
export function PersonFlags({
  allergyStatus,
  allergyCount,
  communicationNeedsCount,
  context = "record",
  additionalFlags = [],
  testID = "person-flags",
}: PersonFlagsProps) {
  const theme = useTheme();
  const allergy = describeAllergyFlag(allergyStatus, allergyCount);
  const showAllergy = context === "record" || allergy.showInLists;
  if (!showAllergy && communicationNeedsCount <= 0 && additionalFlags.length === 0) return null;

  return (
    <View testID={testID} style={[styles.row, { gap: theme.space[1] }]}>
      {showAllergy ? (
        <FlagChip
          tone={allergy.tone}
          icon={iconByName(allergy.icon)}
          label={allergy.label}
          accessibilityLabel={allergy.accessibilityLabel}
          testID={`${testID}-allergies`}
        />
      ) : null}
      {communicationNeedsCount > 0 ? (
        <FlagChip
          tone="info"
          icon={MessageSquareText}
          label={communicationFlagLabel(communicationNeedsCount)}
          testID={`${testID}-communication`}
        />
      ) : null}
      {additionalFlags.map((flag) => (
        <FlagChip
          key={flag.key}
          tone={flag.tone}
          icon={iconByName(flag.icon)}
          label={flag.label}
          accessibilityLabel={flag.accessibilityLabel}
          testID={`${testID}-${flag.key}`}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center" },
});
