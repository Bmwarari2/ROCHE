/**
 * Whether a screen shows its list and its detail side by side (MOB-013, master prompt 17.4): on a
 * tablet in landscape, when both panes still fit at the reader's text size. Everywhere else, and
 * whenever larger text would squeeze a pane, the screen keeps the single pane it has on a phone, so
 * Dynamic Type and 200% text never clip a pane (WCAG 1.4.4, 1.4.10).
 *
 * Widths are density-independent points, as `useWindowDimensions` gives them. `fontScale` is the
 * operating system's text size (1 is the default; 2 is 200%).
 */

/** The shorter side of a tablet: Android's `sw600dp` and the narrowest iPad window are at least this. */
export const TABLET_MIN_SHORT_SIDE = 600;

/**
 * Pane widths at the default text size, and what each grows by for each extra 100% of text.
 * Why these: a list row (photo, name on two lines, flags) reads at 300 pt; the detail (the
 * point-of-care header and a form's buttons) needs 420 pt. Text at 200% needs about half as much
 * again for the list and the same again for the detail, measured on the person header.
 */
export const LIST_PANE_MIN = 300;
export const LIST_PANE_GROWTH = 160;
export const DETAIL_PANE_MIN = 420;
export const DETAIL_PANE_GROWTH = 420;

/** The list takes this share of the width when there is room to spare. */
export const LIST_PANE_SHARE = 0.38;

export interface WindowSize {
  readonly width: number;
  readonly height: number;
  /** The text size multiplier; 1 when unknown. */
  readonly fontScale?: number;
}

export type SplitLayout =
  | { readonly mode: "single" }
  | { readonly mode: "split"; readonly listWidth: number; readonly detailWidth: number };

const SINGLE: SplitLayout = { mode: "single" };

/** The smallest widths each pane may have at this text size. */
export function paneMinimums(fontScale = 1): { list: number; detail: number } {
  // Text smaller than the default never makes a pane narrower than its default minimum.
  const extra = Math.max(0, (Number.isFinite(fontScale) ? fontScale : 1) - 1);
  return {
    list: Math.ceil(LIST_PANE_MIN + LIST_PANE_GROWTH * extra),
    detail: Math.ceil(DETAIL_PANE_MIN + DETAIL_PANE_GROWTH * extra),
  };
}

export function splitLayout({ width, height, fontScale = 1 }: WindowSize): SplitLayout {
  if (!(width > 0) || !(height > 0)) return SINGLE;
  const tablet = Math.min(width, height) >= TABLET_MIN_SHORT_SIDE;
  const landscape = width > height;
  if (!tablet || !landscape) return SINGLE;
  const min = paneMinimums(fontScale);
  if (width < min.list + min.detail) return SINGLE;
  const listWidth = Math.min(
    Math.max(Math.round(width * LIST_PANE_SHARE), min.list),
    width - min.detail,
  );
  return { mode: "split", listWidth, detailWidth: width - listWidth };
}
