interface MetricCardProps {
  label: string;
  value: string;
  changePct?: number;
  /**
   * Whether a rise is good news. False for the price cards: EV list prices and
   * per-kWh tariffs going up is the opposite of the sales figure going up, and
   * colouring both green told the reader the wrong story.
   */
  higherIsBetter?: boolean;
  /** "%" for a relative change, "pts" when the value itself is a percentage. */
  changeUnit?: "%" | "pts";
  footnote?: string;
}

function ChangeBadge({
  changePct,
  higherIsBetter,
  unit,
}: {
  changePct: number;
  higherIsBetter: boolean;
  unit: "%" | "pts";
}) {
  const rising = changePct >= 0;
  const good = rising === higherIsBetter;
  return (
    <span
      className={`text-xs font-medium tabular-nums ${
        good ? "text-accent" : "text-warn"
      }`}
    >
      {/* The arrow carries the direction visually; spell it out for readers
          that announce the text rather than the glyph. */}
      <span aria-hidden="true">{rising ? "▲" : "▼"}</span>
      <span className="sr-only">{rising ? "up" : "down"}</span>{" "}
      {Math.abs(changePct).toFixed(1)}
      {unit === "%" ? "%" : " pts"}
    </span>
  );
}

export function MetricCard({
  label,
  value,
  changePct,
  higherIsBetter = true,
  changeUnit = "%",
  footnote,
}: MetricCardProps) {
  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <div className="text-xs font-medium uppercase tracking-wide text-muted">
        {label}
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums">{value}</span>
        {changePct !== undefined && (
          <ChangeBadge changePct={changePct} higherIsBetter={higherIsBetter} unit={changeUnit} />
        )}
      </div>
      {footnote && <p className="mt-1 text-xs text-muted">{footnote}</p>}
    </div>
  );
}
