import type { BodySide, BodyView } from "@harbour/domain";
import { Text, useTheme } from "@harbour/ui-native";
import { useState } from "react";
import { type LayoutChangeEvent, Pressable, StyleSheet, View } from "react-native";
import Svg, { Circle, Line, Rect } from "react-native-svg";
import {
  CENTRE_HALF_WIDTH,
  DRAWING,
  drawnSide,
  toDrawing,
  VIEWER_ZONES,
  type ViewerZone,
  zoneAt,
} from "../care/body-map";
import { t } from "../i18n/t";

interface BodyMapDrawingProps {
  readonly view: BodyView;
  readonly zone: ViewerZone | null;
  readonly onZone: (zone: ViewerZone) => void;
}

const sideWords = (side: BodySide) => t("mobile.bodyMap.sideWords", { side });

/**
 * A plain body outline the carer taps where the mark is (HZ-019, clinical review C5). The tap is
 * read against the body's midline, with a narrow centre band over the head and trunk only, so a
 * mark on a leg or an arm is always on a side (`zoneAt`). The person's left and right are written
 * under the drawing for the view shown, the side is spelt out once chosen, and three buttons below
 * choose the same zones for screen readers and for anyone who prefers them.
 */
export function BodyMapDrawing({ view, zone, onZone }: BodyMapDrawingProps) {
  const theme = useTheme();
  const stroke = theme.colors.text;
  const fill = theme.colors.bgSecondary;
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  const [tapped, setTapped] = useState<{ x: number; y: number } | null>(null);
  // The person's side under each edge of the drawing, for this view.
  const underLeft = drawnSide(view, "viewer_left");
  const underRight = drawnSide(view, "viewer_right");

  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setFrame({ width, height });
  };

  return (
    <View style={{ gap: theme.space[1] }} testID="body-map-drawing">
      <Pressable
        style={styles.frame}
        onLayout={onLayout}
        accessible={false}
        importantForAccessibility="no-hide-descendants"
        testID="body-map-canvas"
        onPress={(event) => {
          const point = toDrawing(
            { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY },
            frame,
          );
          if (!point) return;
          setTapped(point);
          onZone(zoneAt(point));
        }}
      >
        <Svg width="100%" height="100%" viewBox={`0 0 ${DRAWING.width} ${DRAWING.height}`}>
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
          {/* The midline band over the head and trunk, so the centre is visible as well as tappable. */}
          <Line
            x1={DRAWING.midline - CENTRE_HALF_WIDTH}
            y1={6}
            x2={DRAWING.midline - CENTRE_HALF_WIDTH}
            y2={DRAWING.legsTop}
            stroke={stroke}
            strokeWidth={0.5}
            strokeDasharray="2 2"
          />
          <Line
            x1={DRAWING.midline + CENTRE_HALF_WIDTH}
            y1={6}
            x2={DRAWING.midline + CENTRE_HALF_WIDTH}
            y2={DRAWING.legsTop}
            stroke={stroke}
            strokeWidth={0.5}
            strokeDasharray="2 2"
          />
          {tapped && zone ? (
            <Circle
              cx={tapped.x}
              cy={tapped.y}
              r={5}
              stroke={theme.colors.bg}
              strokeWidth={1.5}
              fill={theme.colors.accent}
            />
          ) : null}
        </Svg>
      </Pressable>
      <View style={styles.labels} accessibilityElementsHidden importantForAccessibility="no">
        <Text variant="bodyDense" emphasis>
          {t("mobile.bodyMap.sideName", { side: underLeft })}
        </Text>
        <Text variant="bodyDense" emphasis>
          {t("mobile.bodyMap.sideName", { side: underRight })}
        </Text>
      </View>
      <View style={[styles.zones, { gap: theme.space[1] }]} accessibilityRole="radiogroup">
        {VIEWER_ZONES.map((z) => {
          const selected = z === zone;
          const side = drawnSide(view, z);
          return (
            <Pressable
              key={z}
              testID={`body-map-zone-${z}`}
              accessibilityRole="radio"
              accessibilityState={{ selected, checked: selected }}
              accessibilityLabel={t("mobile.bodyMap.zone", { side: sideWords(side) })}
              onPress={() => {
                setTapped(null);
                onZone(z);
              }}
              style={{
                flex: 1,
                minHeight: theme.touchTarget,
                alignItems: "center",
                justifyContent: "center",
                borderRadius: theme.radius.input,
                borderWidth: selected ? 2 : 1,
                borderColor: selected ? theme.colors.accent : theme.colors.border,
                backgroundColor: theme.colors.card,
                paddingHorizontal: theme.space[1],
              }}
            >
              <Text variant="bodyDense" emphasis={selected}>
                {t("mobile.bodyMap.sideName", { side })}
              </Text>
            </Pressable>
          );
        })}
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
  labels: {
    flexDirection: "row",
    justifyContent: "space-between",
    maxWidth: 320,
    width: "100%",
    alignSelf: "center",
  },
  zones: { flexDirection: "row", maxWidth: 320, width: "100%", alignSelf: "center" },
});
