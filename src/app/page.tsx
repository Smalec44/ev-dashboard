import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Dashboard } from "@/components/Dashboard";
import { MarketPanel } from "@/components/MarketPanel";
import { connectorPrices } from "@/data/metrics";
import type { StationFeed } from "@/data/stations";
import { activeAttributions } from "@/server/domain/attribution";

/**
 * National charging tariffs, averaged over the whole station file at build
 * time. They are per-operator estimates (the federal feed carries no
 * prices), so a build-time figure is exactly as current as a live one.
 */
function nationalChargingPrices() {
  const feed = JSON.parse(
    readFileSync(join(process.cwd(), "public/stations.json"), "utf8"),
  ) as StationFeed;
  return { ...connectorPrices(feed.stations), stations: feed.stations.length };
}

export default function Home() {
  const attributions = activeAttributions();
  const chargingPrices = nationalChargingPrices();

  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-10">
      <header className="mb-6">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">
          Switzerland
        </p>
        <h1 className="mt-1 text-2xl font-semibold">EV Owner Dashboard</h1>
        <p className="mt-1 text-sm text-muted">
          Charging recommendations ranked on your terms, with the national
          figures and the day&apos;s EV news.
        </p>
      </header>

      <MarketPanel chargingPrices={chargingPrices} />

      <div className="mt-10">
        <Dashboard />
      </div>

      {/*
        Attribution is a licence term, not a courtesy: the amenity data is
        ODbL, which requires the credit to be shown wherever the data is. It
        renders here, server-side, so it is present even when the station feed
        fetch fails and the page falls back to the curated seed stations.
      */}
      <footer className="mt-10 space-y-2 border-t border-border pt-4 text-xs text-muted">
        <ul className="space-y-1">
          {attributions.map((attribution) => (
            <li key={attribution.source}>
              <a
                href={attribution.url}
                target="_blank"
                rel="noreferrer"
                className="underline decoration-border underline-offset-2 hover:text-foreground"
              >
                {attribution.text}
              </a>{" "}
              <span className="text-muted">({attribution.licence})</span>
              {attribution.commercialUseRestricted && (
                <span className="text-warn"> · commercial use restricted</span>
              )}
            </li>
          ))}
        </ul>
      </footer>
    </main>
  );
}
