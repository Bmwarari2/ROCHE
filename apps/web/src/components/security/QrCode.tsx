import { encode } from "uqr";

/**
 * A QR code drawn as one SVG path (uqr, MIT licence). Black on white in both themes so phone
 * cameras can read it. The same value is shown as text beside it for people who cannot scan.
 */
export function QrCode({ value, label }: { readonly value: string; readonly label: string }) {
  const { data } = encode(value, { ecc: "M", border: 2 });
  const size = data.length;
  let path = "";
  data.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) path += `M${x} ${y}h1v1h-1z`;
    });
  });
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      width={200}
      height={200}
      shapeRendering="crispEdges"
      className="rounded-input border border-border"
    >
      <rect width={size} height={size} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
