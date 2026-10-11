import type { BodySide, BodyView } from "@harbour/domain";
import { Text, useTheme } from "@harbour/ui-native";
import { Pressable, StyleSheet, View } from "react-native";
import Svg, { Circle, Rect } from "react-native-svg";
import { drawnSide, VIEWER_ZONES, type ViewerZone } from "../care/body-map";
import { t } from "../i18n/t";

interface BodyMapDrawingProps {
  readonly view: BodyView;
  readonly zone: ViewerZone | null;
  readonly onZone: (zone: ViewerZone) => void;
}

const sideWords = (side: BodySide) => t("mobile.bodyMap.sideWords", { side });

/**
 * A plain body outline split into three columns the carer taps (HZ-019). Each column is a button
 * that names the person's own side for the view shown, and the person's left and right are written
 * under the drawing, so the orientation never has to be worked out from the picture alone.
 */
export function BodyMapDrawing({ view, zone, onZone }: BodyMapDrawingProps) {
  const theme = useTheme();
  const stroke = theme.colors.text;
  const fill = theme.colors.bgSecondary;
  // The person's side under each edge of the drawing, for this view.
  const underLeft = drawnSide(view, "viewer_left");
  const underRight = drawnSide(view, "viewer_right");

  return (
    <View style={{ gap: theme.space[1] }} testID="body-map-drawing">
      <View style={styles.frame}>
        <Svg
          width="100%"
          height="100%"
          viewBox="0 0 120 240"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Circle cx={60} cy={22} r={16} stroke={stroke} strokeWidth={1.5} fill={fill} />
          <Rect
            x={38}
            y={40}
            width={44}
            height={82}
            rx={10}
            stroke={stroke}
            strokeWidth={1.5}
            fill={fill}
          />
          <Rect
            x={20}
            y={44}
            width={14}
            height={80}
            rx={7}
            stroke={stroke}
            strokeWidth={1.5}
            fill={fill}
          />
          <Rect
            x={86}
            y={44}
            width={14}
            height={80}
            rx={7}
            stroke={stroke}
            strokeWidth={1.5}
            fill={fill}
          />
          <Rect
            x={40}
            y={124}
            width={18}
            height={104}
            rx={8}
            stroke={stroke}
            strokeWidth={1.5}
            fill={fill}
          />
          <Rect
            x={62}
            y={124}
            width={18}
            height={104}
            rx={8}
            stroke={stroke}
            strokeWidth={1.5}
            fill={fill}
          />
        </Svg>
        <View style={[StyleSheet.absoluteFill, styles.columns]}>
          {VIEWER_ZONES.map((z) => {
            const selected = z === zone;
            return (
              <Pressable
                key={z}
                testID={`body-map-zone-${z}`}
                accessibilityRole="radio"
                accessibilityState={{ selected, checked: selected }}
                accessibilityLabel={t("mobile.bodyMap.zone", {
                  side: sideWords(drawnSide(view, z)),
                })}
                onPress={() => onZone(z)}
                style={[
                  styles.column,
                  {
                    borderColor: selected ? theme.colors.accent : "transparent",
                    borderWidth: selected ? 3 : 0,
                    borderRadius: theme.radius.input,
                  },
                ]}
              >
                {selected ? (
                  <View
                    style={[styles.marker, { backgroundColor: theme.colors.accent }]}
                    accessibilityElementsHidden
                    importantForAccessibility="no"
                  />
                ) : null}
              </Pressable>
            );
          })}
        </View>
      </View>
      <View style={styles.labels} accessibilityElementsHidden importantForAccessibility="no">
        <Text variant="bodyDense" emphasis>
          {t("mobile.bodyMap.sideName", { side: underLeft })}
        </Text>
        <Text variant="bodyDense" emphasis>
          {t("mobile.bodyMap.sideName", { side: underRight })}
        </Text>
      </View>
      <Text variant="bodyDense" tone="secondary">
        {t("mobile.bodyMap.drawingHint", { view })}
      </Text>
      {zone ? (
        <Text emphasis testID="body-map-drawn-side">
          {t("mobile.bodyMap.drawnAt", { side: sideWords(drawnSide(view, zone)) })}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { width: "100%", maxWidth: 320, height: 300, alignSelf: "center" },
  columns: { flexDirection: "row" },
  column: { flex: 1, alignItems: "center", justifyContent: "center", minHeight: 44 },
  marker: { width: 18, height: 18, borderRadius: 9 },
  labels: {
    flexDirection: "row",
    justifyContent: "space-between",
    maxWidth: 320,
    width: "100%",
    alignSelf: "center",
  },
});
