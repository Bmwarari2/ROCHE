"use client";

import { type MouseEvent, useId } from "react";
import { type BodyView, DRAWING, hotspots, nearestHotspot } from "@/lib/body-map";
import { t } from "@/lib/i18n";

export interface DrawnMark {
  readonly id: string;
  readonly region: string;
  readonly side: "left" | "right" | "midline";
}

type Point = readonly [number, number];

// The limbs on your left of the drawing; the other side is their mirror image.
const ARM: readonly Point[] = [
  [76, 98],
  [60, 150],
  [52, 205],
  [46, 258],
];
const LEG: readonly Point[] = [
  [106, 252],
  [98, 350],
  [98, 440],
];

const mirrorPoint = ([x, y]: Point): Point => [DRAWING.width - x, y];
const pathOf = (points: readonly Point[]) =>
  points.map(([x, y], index) => `${index === 0 ? "M" : "L"} ${x} ${y}`).join(" ");

/** A limb as a thick rounded line with an outline, so it reads in both themes. */
function Limb({ points, width }: { readonly points: readonly Point[]; readonly width: number }) {
  const d = pathOf(points);
  return (
    <>
      <path
        d={d}
        fill="none"
        strokeWidth={width + 3}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-text-tertiary"
      />
      <path
        d={d}
        fill="none"
        strokeWidth={width}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-bg-secondary"
      />
    </>
  );
}

/**
 * The body drawing for one view (HZ-019). The labels say which side is the person's left and
 * right: the front view faces you, so the person's right is on your left; the back view faces
 * away. Tapping finds the nearest body area and side as drawn. It is a picture for pointer users:
 * the list of body areas beside it does the same job for keyboard and screen reader users.
 */
export function BodyDrawing({
  view,
  selected,
  marks,
  onSelect,
}: {
  readonly view: BodyView;
  /** "knee:left": the area and side chosen, or null. */
  readonly selected: string | null;
  readonly marks: readonly DrawnMark[];
  readonly onSelect: (value: string) => void;
}) {
  const titleId = useId();
  const spots = hotspots(view);
  const chosen = spots.find((spot) => spot.value === selected) ?? null;
  const markSpots = marks.flatMap((mark) => {
    const spot = spots.find((s) => s.region === mark.region && s.side === mark.side);
    return spot ? [{ id: mark.id, x: spot.x, y: spot.y }] : [];
  });
  const onYourLeft =
    view === "front" ? t("care.bodyMap.personRight") : t("care.bodyMap.personLeft");
  const onYourRight =
    view === "front" ? t("care.bodyMap.personLeft") : t("care.bodyMap.personRight");

  const pick = (event: MouseEvent<SVGSVGElement>) => {
    const matrix = event.currentTarget.getScreenCTM();
    if (!matrix) return;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    const spot = nearestHotspot(view, point.x, point.y);
    if (spot) onSelect(spot.value);
  };

  return (
    <div className="flex w-full max-w-[240px] flex-col gap-1">
      {/* The drawing's title says the same for screen readers; these labels are for the eye, at a
          size that stays readable when the drawing shrinks on a phone. */}
      <p
        className="m-0 flex justify-between gap-2 text-body-dense font-semibold"
        aria-hidden="true"
        data-body-orientation={view}
      >
        <span>{onYourLeft}</span>
        <span className="text-end">{onYourRight}</span>
      </p>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: tapping the picture is for pointers; the body area list beside it is the keyboard and screen reader equivalent. */}
      <svg
        viewBox={`0 0 ${DRAWING.width} ${DRAWING.height}`}
        width={DRAWING.width}
        height={DRAWING.height}
        role="img"
        aria-labelledby={titleId}
        className="h-auto max-w-full cursor-crosshair select-none"
        data-body-view={view}
        onClick={pick}
      >
        <title id={titleId}>{t("care.bodyMap.drawing", { view })}</title>
        <Limb points={ARM} width={18} />
        <Limb points={ARM.map(mirrorPoint)} width={18} />
        <Limb points={LEG} width={26} />
        <Limb points={LEG.map(mirrorPoint)} width={26} />
        <g className="fill-bg-secondary stroke-text-tertiary" strokeWidth={1.5}>
          <ellipse cx={120} cy={38} rx={22} ry={28} />
          <rect x={110} y={64} width={20} height={18} rx={4} />
          <path d="M 74 92 Q 120 80 166 92 L 172 160 Q 168 210 160 252 L 80 252 Q 72 210 68 160 Z" />
          <ellipse cx={96} cy={462} rx={15} ry={10} />
          <ellipse cx={DRAWING.width - 96} cy={462} rx={15} ry={10} />
        </g>
        <line
          x1={DRAWING.centre}
          y1={22}
          x2={DRAWING.centre}
          y2={DRAWING.height - 4}
          className="stroke-text-tertiary"
          strokeDasharray="3 5"
        />
        {spots.map((spot) => (
          <circle key={spot.value} cx={spot.x} cy={spot.y} r={2} className="fill-text-tertiary" />
        ))}
        {markSpots.map((mark) => (
          <circle
            key={mark.id}
            cx={mark.x}
            cy={mark.y}
            r={5}
            strokeWidth={2}
            className="fill-text stroke-bg"
            data-mark={mark.id}
          />
        ))}
        {chosen ? (
          <g data-selected={chosen.value}>
            <circle
              cx={chosen.x}
              cy={chosen.y}
              r={10}
              fill="none"
              strokeWidth={3}
              className="stroke-accent"
            />
            <path
              d={`M ${chosen.x - 5} ${chosen.y} L ${chosen.x + 5} ${chosen.y} M ${chosen.x} ${chosen.y - 5} L ${chosen.x} ${chosen.y + 5}`}
              strokeWidth={2}
              className="stroke-accent"
            />
          </g>
        ) : null}
      </svg>
    </div>
  );
}
