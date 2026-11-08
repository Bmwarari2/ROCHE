import { useEffect } from "react";
import { clearNoticeForOthers, clearSavedNotice, useSavedNotice } from "../care/saved-notice";
import { appEnv } from "../config/app-env";
import { SavedNoticeView } from "./SavedNoticeView";

/**
 * The save confirmation on a person's record (HZ-001): what was saved, for whom and at what time,
 * in words with an icon, until it is hidden (a 44 pt button), another person's record opens, the
 * app locks, or 15 minutes pass. Not a live region: the save announced it once already. Hiding it
 * moves screen reader focus on (`onHidden`), so focus is never lost (WCAG 2.4.3).
 */
export function SavedNoticeLine({
  personId,
  onHidden,
}: {
  readonly personId: string;
  readonly onHidden?: () => void;
}) {
  const notice = useSavedNotice(personId);
  // Opening a person's record drops a notice that names someone else.
  useEffect(() => {
    clearNoticeForOthers(personId);
  }, [personId]);
  if (!notice) return null;
  return (
    <SavedNoticeView
      notice={notice}
      demo={appEnv.demoMode}
      onHide={() => {
        clearSavedNotice();
        onHidden?.();
      }}
    />
  );
}
