import { Button, Text, useTheme } from "@harbour/ui-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useRef } from "react";
import { View } from "react-native";
import { t } from "../i18n/t";

/**
 * The camera reading a medicine pack's barcode (ADR-0081): GS1 DataMatrix and linear GTINs. The
 * frames are read on the device and never stored or sent; the code goes to `onScanned` once, and
 * the panel decides whether it matches. Without camera permission the carer is told so and can
 * give an override reason instead.
 */
export function PackScanner({
  onScanned,
  onCancel,
}: {
  readonly onScanned: (raw: string) => void;
  readonly onCancel: () => void;
}) {
  const theme = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const done = useRef(false);
  if (!permission) return null;
  if (!permission.granted) {
    return (
      <View style={{ gap: theme.space[1] }} testID="pack-scanner-permission">
        <Text>{t("mobile.meds.cameraNeeded")}</Text>
        {permission.canAskAgain ? (
          <Button label={t("mobile.meds.allowCamera")} onPress={() => void requestPermission()} />
        ) : null}
        <Button label={t("mobile.round.cancel")} variant="secondary" onPress={onCancel} />
      </View>
    );
  }
  return (
    <View style={{ gap: theme.space[1] }} testID="pack-scanner">
      <CameraView
        style={{ height: 240, borderRadius: theme.radius.card }}
        facing="back"
        accessibilityLabel={t("mobile.meds.cameraLabel")}
        barcodeScannerSettings={{
          barcodeTypes: ["datamatrix", "ean13", "ean8", "upc_a", "upc_e", "code128"],
        }}
        onBarcodeScanned={({ data }) => {
          if (done.current) return;
          done.current = true;
          onScanned(data);
        }}
      />
      <Button label={t("mobile.round.cancel")} variant="secondary" onPress={onCancel} />
    </View>
  );
}
