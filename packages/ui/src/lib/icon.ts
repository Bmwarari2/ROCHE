/**
 * Shared props for Lucide icons: a 1.5 px stroke at every size (section 8) and hidden from
 * assistive technology, because every icon in the design system sits next to a visible word.
 */
export const iconProps = {
  strokeWidth: 1.5,
  nonScalingStroke: true,
  "aria-hidden": true,
} as const;
