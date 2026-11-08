import { ComingSoon } from "../components/ComingSoon";
import { t } from "../i18n/t";

export default function FamilyScreen() {
  return (
    <ComingSoon
      title={t("mobile.mode.title", { mode: "family" })}
      description={t("mobile.mode.comingSoon", { mode: "family" })}
    />
  );
}
