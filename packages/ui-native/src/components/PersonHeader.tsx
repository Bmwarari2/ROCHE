import { type ImageURISource, StyleSheet, View } from "react-native";
import { formatNhsNumber, fullName, knownAsName, type PersonNameParts } from "../logic/person";
import { formatIsoCalendarDate } from "../logic/time";
import { useTheme } from "../theme/ThemeProvider";
import { Avatar } from "./Avatar";
import { PersonFlags } from "./PersonFlags";
import { Text } from "./Text";

export interface PersonHeaderProps extends PersonNameParts {
  readonly photo?: ImageURISource | null;
  /** Room or bed label, for example "Room 12". */
  readonly room?: string | null;
  /** ISO calendar date (yyyy-mm-dd). */
  readonly dateOfBirth?: string | null;
  readonly nhsNumber?: string | null;
  /** `person.allergy_status`: unknown, no_known_allergies or has_allergies. */
  readonly allergyStatus: string | null | undefined;
  /** Active allergy rows on the device for this person. */
  readonly allergyCount: number;
  /** Display text of each communication need, for example "Large print". */
  readonly communicationNeeds: readonly string[];
  readonly testID?: string;
}

/**
 * Identity block at the top of every record screen. Shows the photo, the name the person is known
 * by and their full name, plus date of birth and NHS number as second identifiers (HZ-001), the
 * room, and the allergy and communication-needs flags (HZ-007, Accessible Information Standard).
 * The photo is passed in already loaded (for example a data URI held in memory), so this package
 * never fetches or caches care images itself.
 * Identifiers are not selectable, so they cannot be copied to the clipboard.
 */
export function PersonHeader({
  photo,
  preferredName,
  givenName,
  familyName,
  room,
  dateOfBirth,
  nhsNumber,
  allergyStatus,
  allergyCount,
  communicationNeeds,
  testID = "person-header",
}: PersonHeaderProps) {
  const theme = useTheme();
  const name = { preferredName, givenName, familyName };
  const knownAs = knownAsName(name);
  const full = fullName(name);
  const born = formatIsoCalendarDate(dateOfBirth);
  const nhs = formatNhsNumber(nhsNumber);
  const identifiers = [born ? `Born ${born}` : null, nhs ? `NHS number ${nhs}` : null].filter(
    (part): part is string => part !== null,
  );

  return (
    <View
      testID={testID}
      style={[
        styles.container,
        {
          backgroundColor: theme.colors.card,
          borderColor: theme.colors.border,
          borderRadius: theme.radius.card,
          padding: theme.space[2],
          gap: theme.space[1.5],
        },
      ]}
    >
      <View style={[styles.identity, { gap: theme.space[2] }]}>
        <Avatar photo={photo} name={name} size={72} testID={`${testID}-avatar`} />
        <View style={styles.names}>
          <Text variant="title" accessibilityRole="header" selectable={false} numberOfLines={2}>
            {knownAs}
          </Text>
          {full && full !== knownAs ? (
            <Text tone="secondary" selectable={false} accessibilityLabel={`Full name ${full}`}>
              {full}
            </Text>
          ) : null}
          {room ? (
            <Text tone="secondary" selectable={false}>
              {room}
            </Text>
          ) : null}
        </View>
      </View>
      {identifiers.length > 0 ? (
        <Text
          variant="bodyDense"
          tone="secondary"
          selectable={false}
          testID={`${testID}-identifiers`}
        >
          {identifiers.join("  ·  ")}
        </Text>
      ) : null}
      <PersonFlags
        allergyStatus={allergyStatus}
        allergyCount={allergyCount}
        communicationNeedsCount={communicationNeeds.length}
        context="record"
        testID={`${testID}-flags`}
      />
      {communicationNeeds.length > 0 ? (
        <View
          accessible
          accessibilityLabel={`Communication needs: ${communicationNeeds.join(", ")}`}
        >
          {communicationNeeds.map((need) => (
            <Text key={need} variant="bodyDense" selectable={false}>
              {need}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { borderWidth: StyleSheet.hairlineWidth },
  identity: { flexDirection: "row", alignItems: "center" },
  names: { flex: 1 },
});
