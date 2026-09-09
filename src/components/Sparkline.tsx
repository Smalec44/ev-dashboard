import type { TrendPoint } from "@/lib/types";

const WIDTH = 320;
const HEIGHT = 64;
const PADDING_Y = 6;

export function Sparkline({ points }: { points: TrendPoint[] }) {
  if (points.length < 2) return null;

  // Scale on complete months only — a part-counted month would otherwise drag
  // the floor down and flatten the variation that actually matters.
  const scaleValues = points.filter((p) => !p.partial).map((p) => p.value);
  // With nothing settled there is no scale to draw against: min/max would be
  // ±Infinity and every coordinate NaN, and the area polygon below would read
  // off the end of an empty array.
  if (scaleValues.length === 0) return null;
  const min = Math.min(...scaleValues);
  const max = Math.max(...scaleValues);
  const span = max - min || 1;

  const coords = points.map((point, index) => {
    const raw =
      HEIGHT -
      PADDING_Y -
      ((point.value - min) / span) * (HEIGHT - PADDING_Y * 2);
    return {
      x: (index / (points.length - 1)) * WIDTH,
      y: Math.min(Math.max(raw, PADDING_Y), HEIGHT - PADDING_Y),
      point,
    };
  });

  const settled = coords.filter(({ point }) => !point.partial);
  const line = (list: typeof coords) =>
    list.map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

  // The partial month is drawn as a dashed continuation so the dip reads as
  // "month not finished" rather than "registrations collapsed".
  const tail = coords.slice(settled.length - 1);

  return (
    <div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="h-16 w-full"
        role="img"
        aria-label={`Monthly BEV registrations, ${points[0].month} to ${points[points.length - 1].month}`}
      >
        <polygon
          points={`0,${HEIGHT} ${line(settled)} ${settled[settled.length - 1].x.toFixed(1)},${HEIGHT}`}
          className="fill-accent-soft"
        />
        <polyline
          points={line(settled)}
          fill="none"
          className="stroke-accent"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {tail.length > 1 && (
          <polyline
            points={line(tail)}
            fill="none"
            className="stroke-accent opacity-50"
            strokeWidth={2}
            strokeDasharray="3 3"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {/* Zero-length round-capped lines: dots that survive preserveAspectRatio="none". */}
        {coords.map(({ x, y, point }) => (
          <line
            key={point.month}
            x1={x}
            y1={y}
            x2={x}
            y2={y}
            strokeLinecap="round"
            strokeWidth={point.partial ? 3 : 4}
            vectorEffect="non-scaling-stroke"
            className={point.partial ? "stroke-muted" : "stroke-accent"}
          />
        ))}
      </svg>

      <div className="mt-1.5 flex justify-between text-[10px] tabular-nums text-muted">
        {points.map((point) => (
          <span
            key={point.month}
            className={point.partial ? "font-medium text-warn" : undefined}
          >
            {point.month}
            {point.partial && "*"}
          </span>
        ))}
      </div>
    </div>
  );
}
