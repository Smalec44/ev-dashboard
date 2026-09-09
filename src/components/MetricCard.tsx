interface MetricCardProps {
  label: string;
  value: string;
  changePct?: number;
  footnote?: string;
}

function ChangeBadge({ changePct }: { changePct: number }) {
  const positive = changePct >= 0;
  return (
    <span
      className={`text-xs font-medium tabular-nums ${
        positive ? "text-accent" : "text-warn"
      }`}
    >
      {positive ? "▲" : "▼"} {Math.abs(changePct).toFixed(1)}%
    </span>
  );
}

export function MetricCard({
  label,
  value,
  changePct,
  footnote,
}: MetricCardProps) {
  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <div className="text-xs font-medium uppercase tracking-wide text-muted">
        {label}
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums">{value}</span>
        {changePct !== undefined && <ChangeBadge changePct={changePct} />}
      </div>
      {footnote && <p className="mt-1 text-xs text-muted">{footnote}</p>}
    </div>
  );
}
