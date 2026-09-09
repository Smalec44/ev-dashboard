import { Dashboard } from "@/components/Dashboard";
import { MetricCard } from "@/components/MetricCard";
import { Sparkline } from "@/components/Sparkline";
import { NATIONAL_METRICS } from "@/data/metrics";

const numberFormat = new Intl.NumberFormat("de-CH");
const chfFormat = new Intl.NumberFormat("de-CH", {
  style: "currency",
  currency: "CHF",
  maximumFractionDigits: 0,
});
const dateFormat = new Intl.DateTimeFormat("en-CH", {
  day: "numeric",
  month: "long",
  year: "numeric",
});

export default function Home() {
  const m = NATIONAL_METRICS;
  const partialMonth = m.monthlyRegistrations.find((point) => point.partial);

  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-10">
      <header className="mb-8">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">
          Switzerland · {m.periodLabel}
        </p>
        <h1 className="mt-1 text-2xl font-semibold">EV Owner Dashboard</h1>
        <p className="mt-1 text-sm text-muted">
          Market metrics and charging recommendations, ranked on your terms.
          Figures as of {dateFormat.format(new Date(m.asOf))}.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="New EVs sold"
          value={numberFormat.format(m.newEvsSold)}
          changePct={m.newEvsSoldChangePct}
          footnote={`${m.evShareOfNewCarsPct}% of new registrations · YTD`}
        />
        <MetricCard
          label="Average EV price"
          value={chfFormat.format(m.averageEvPriceChf)}
          changePct={m.averageEvPriceChangePct}
          footnote="New vehicle, list price"
        />
        <MetricCard
          label="AC charging"
          value={`CHF ${m.averageAcPricePerKwh.toFixed(2)}`}
          changePct={m.averageAcPriceChangePct}
          footnote="Per kWh, national average"
        />
        <MetricCard
          label="DC charging"
          value={`CHF ${m.averageDcPricePerKwh.toFixed(2)}`}
          changePct={m.averageDcPriceChangePct}
          footnote="Per kWh, national average"
        />
      </div>

      <section className="mt-4 rounded-xl border border-border bg-surface p-5">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-medium">Monthly BEV registrations</h2>
          <span className="text-xs text-muted">{m.periodLabel}</span>
        </div>
        <Sparkline points={m.monthlyRegistrations} />
        {partialMonth && (
          <p className="mt-2 text-xs text-muted">
            <span className="text-warn">*</span> {partialMonth.month} is a
            partial month — counted to {dateFormat.format(new Date(m.asOf))},
            so it sits below a full month by design.
          </p>
        )}
      </section>

      <div className="mt-10">
        <Dashboard />
      </div>

      <footer className="mt-10 border-t border-border pt-4 text-xs text-muted">
        Figures are seeded sample data for demonstration, not official
        statistics.
      </footer>
    </main>
  );
}
