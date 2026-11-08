import { ComingSoon } from "../components/ComingSoon";
import { t } from "../i18n/t";

export default function ManageScreen() {
  return (
    <ComingSoon
      title={t("mobile.mode.title", { mode: "manage" })}
      description={t("mobile.mode.comingSoon", { mode: "manage" })}
    />
  );
}
