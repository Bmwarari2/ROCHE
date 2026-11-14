import { Children, createContext, isValidElement, type ReactNode, useContext } from "react";
import { View } from "react-native";
import { useTheme } from "../theme/ThemeProvider";
import { Text } from "./Text";

/**
 * Grouped lists in the platform's own style (ADR-0138):
 * - iOS: an inset grouped list, one rounded group with hairline dividers inset to the text;
 * - Android: Material 3 Expressive segmented rows, each its own surface, 2 dp apart, with the
 *   group's large corners at the ends.
 * A `ListSection` groups static rows; inside a FlatList, wrap each row in `ListSectionItem` with its
 * index and the count instead.
 */

export interface ListPosition {
  readonly first: boolean;
  readonly last: boolean;
}

const ListPositionContext = createContext<ListPosition | null>(null);

/** Where a row sits in its group, or null outside one. */
export function useListPosition(): ListPosition | null {
  return useContext(ListPositionContext);
}

/** The gap between Material 3 segmented rows, and the small corner between them. */
const SEGMENT_GAP = 2;
const SEGMENT_INNER_RADIUS = 4;

export interface ListSectionItemProps {
  readonly index: number;
  readonly count: number;
  readonly children: ReactNode;
}

/** One row of a group: its corners, its gap and its divider follow its place in the group. */
export function ListSectionItem({ index, count, children }: ListSectionItemProps) {
  const theme = useTheme();
  const first = index === 0;
  const last = index === count - 1;
  const outer = theme.radius.card;
  const inner = theme.platform === "android" ? SEGMENT_INNER_RADIUS : 0;
  return (
    <View
      style={{
        backgroundColor: theme.colors.card,
        overflow: "hidden",
        marginTop: !first && theme.platform === "android" ? SEGMENT_GAP : 0,
        borderTopLeftRadius: first ? outer : inner,
        borderTopRightRadius: first ? outer : inner,
        borderBottomLeftRadius: last ? outer : inner,
        borderBottomRightRadius: last ? outer : inner,
        // High contrast outlines the group, since tone alone separates it from the page.
        borderWidth: theme.highContrast ? 1 : 0,
        borderColor: theme.colors.border,
      }}
    >
      <ListPositionContext.Provider value={{ first, last }}>
        {children}
      </ListPositionContext.Provider>
    </View>
  );
}

export interface ListSectionHeaderProps {
  readonly title: string;
  readonly testID?: string;
}

/**
 * A group's heading, spoken as a heading: a quiet label inset to the rows' text on iOS, the
 * Material 3 list subheader in the brand colour on Android.
 */
export function ListSectionHeader({ title, testID }: ListSectionHeaderProps) {
  const theme = useTheme();
  const android = theme.platform === "android";
  return (
    <Text
      testID={testID}
      accessibilityRole="header"
      variant="bodyDense"
      tone={android ? "accent" : "secondary"}
      emphasis={android}
      style={{
        paddingHorizontal: theme.space[2],
        paddingTop: theme.space[1],
        paddingBottom: theme.space[1],
      }}
    >
      {title}
    </Text>
  );
}

export interface ListSectionProps {
  readonly title?: string;
  /** Words under the group, such as what the rows are for. */
  readonly footer?: string;
  readonly children: ReactNode;
  readonly testID?: string;
}

export function ListSection({ title, footer, children, testID }: ListSectionProps) {
  const theme = useTheme();
  const rows = Children.toArray(children).filter(isValidElement);
  return (
    <View testID={testID}>
      {title ? <ListSectionHeader title={title} /> : null}
      {rows.map((row, index) => (
        <ListSectionItem key={row.key ?? index} index={index} count={rows.length}>
          {row}
        </ListSectionItem>
      ))}
      {footer ? (
        <Text
          variant="bodyDense"
          tone="secondary"
          style={{ paddingHorizontal: theme.space[2], paddingTop: theme.space[1] }}
        >
          {footer}
        </Text>
      ) : null}
    </View>
  );
}
