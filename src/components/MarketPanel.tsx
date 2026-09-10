"use client";

import { useEffect, useState } from "react";
import type { MarketData, RegistrationYear, TrendPoint } from "@/lib/types";
import { MetricCard } from "./MetricCard";
import { Sparkline } from "./Sparkline";

const numberFormat = new Intl.NumberFormat("de-CH");
const timeFormat = new Intl.DateTimeFormat("en-CH", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Zurich",
});

/** "3 h ago", "2 days ago": a headline's age reads faster than its date. */
function ago(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function pctChange(current: number, previous: number): number | undefined {
  return previous > 0 ? ((current - previous) / previous) * 100 : undefined;
}

function RegistrationTiles({
  years,
  chargingPrices,
}: {
  years: RegistrationYear[];
  chargingPrices: ChargingPrices;
}) {
  const latest = years.at(-1);
  const previous = years.at(-2);
  if (!latest) return null;
  const share = latest.total > 0 ? (latest.bev / latest.total) * 100 : null;
  const points: TrendPoint[] = years.map((y) => ({ label: String(y.year), value: y.bev }));
  const change = previous ? pctChange(latest.bev, previous.bev) : undefined;
  const shareChange =
    previous && previous.total > 0 && share !== null
      ? share - (previous.bev / previous.total) * 100
      : undefined;

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="New electric cars"
          value={numberFormat.format(latest.bev)}
          {...(change !== undefined && { changePct: change })}
          footnote={`Registered in ${latest.year} · vs ${previous?.year ?? "—"}`}
        />
        <MetricCard
          label="Share of new cars"
          value={share === null ? "—" : `${share.toFixed(1)}%`}
          {...(shareChange !== undefined && { changePct: shareChange })}
          footnote={`Battery-electric, ${latest.year} · points vs ${previous?.year ?? "—"}`}
        />
        <MetricCard
          label="AC charging"
          value={chargingPrices.ac === null ? "—" : `CHF ${chargingPrices.ac.toFixed(2)}`}
          higherIsBetter={false}
          footnote={`Per kWh · estimate over ${numberFormat.format(chargingPrices.stations)} public sites`}
        />
        <MetricCard
          label="DC charging"
          value={chargingPrices.dc === null ? "—" : `CHF ${chargingPrices.dc.toFixed(2)}`}
          higherIsBetter={false}
          footnote="Per kWh · estimate from operator tariffs"
        />
      </div>

      <section className="mt-4 rounded-xl border border-border bg-surface p-5">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-sm font-medium">New electric cars per year</h3>
          <span className="text-xs text-muted">
            {points[0]?.label}–{points.at(-1)?.label} · Federal Statistical Office
          </span>
        </div>
        <Sparkline points={points} label="New electric cars per year" />
      </section>
    </>
  );
}

async function fetchMarket(): Promise<MarketData> {
  const res = await fetch("/api/market", { cache: "no-store" });
  if (!res.ok) throw new Error(`market returned ${res.status}`);
  return (await res.json()) as MarketData;
}

export interface ChargingPrices {
  ac: number | null;
  dc: number | null;
  stations: number;
}

/**
 * The figures above the search: registrations from the statistics office,
 * charging tariffs from the station data, and the latest EV headlines.
 * The figures are folded away by default — most visits are about finding a
 * charger — and the whole panel re-fetches on Refresh.
 */
export function MarketPanel({ chargingPrices }: { chargingPrices: ChargingPrices }) {
  const [market, setMarket] = useState<MarketData | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [open, setOpen] = useState(false);

  async function refresh() {
    setState("loading");
    try {
      setMarket(await fetchMarket());
      setState("ready");
    } catch {
      setState("error");
    }
  }

  useEffect(() => {
    let cancelled = false;
    fetchMarket()
      .then((data) => {
        if (cancelled) return;
        setMarket(data);
        setState("ready");
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Ages are measured from the fetch, not from the render, so the render
  // stays pure; the difference is seconds.
  const now = market ? Date.parse(market.fetchedAt) : 0;
  const gaps = market?.errors.map((error) => error.split(":")[0] ?? error) ?? [];

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-3">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls="market-figures"
          className="flex items-center gap-2 text-sm font-medium transition-colors hover:text-accent"
        >
          <span aria-hidden="true" className="inline-block w-3 text-muted">
            {open ? "▾" : "▸"}
          </span>
          Market figures
          <span className="text-xs font-normal text-muted">
            {market?.registrations
              ? `· ${market.registrations.at(-1)?.year ?? ""} registrations & charging tariffs`
              : "· registrations & charging tariffs"}
          </span>
        </button>
        <span className="flex items-center gap-3 text-xs text-muted">
          {state === "loading" && "Fetching figures and news…"}
          {state === "error" && (
            <span className="text-warn">Could not reach the sources.</span>
          )}
          {state === "ready" &&
            market &&
            `Fetched ${timeFormat.format(new Date(market.fetchedAt))}` +
              (gaps.length > 0 ? ` · ${gaps.join(", ")} unavailable` : "")}
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={state === "loading"}
            className="rounded-lg border border-border bg-surface-muted px-3 py-1.5 font-medium text-foreground transition-colors hover:text-accent disabled:cursor-wait disabled:opacity-60"
          >
            {state === "loading" ? "Refreshing…" : "Refresh figures & news"}
          </button>
        </span>
      </div>

      <div id="market-figures" hidden={!open}>
        {market?.registrations ? (
          <RegistrationTiles years={market.registrations} chargingPrices={chargingPrices} />
        ) : (
          <p className="rounded-xl border border-border bg-surface p-5 text-sm text-muted">
            {state === "loading"
              ? "Fetching registrations from the Federal Statistical Office…"
              : "Registrations are unavailable right now — refresh to try again."}
          </p>
        )}
      </div>

      <section className="rounded-xl border border-border bg-surface p-5">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-medium">EV news from Europe</h2>
          <span className="text-xs text-muted">
            {market?.news?.[0] ? `via ${market.news[0].source}` : "top 5 headlines"}
          </span>
        </div>
        {market?.news && market.news.length > 0 ? (
          <ol className="mt-2 divide-y divide-border text-sm">
            {market.news.map((item) => (
              <li key={item.url} className="flex items-baseline justify-between gap-3 py-2">
                <a
                  href={item.url}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 font-medium underline decoration-border underline-offset-2 hover:text-accent"
                >
                  {item.title}
                </a>
                <span className="shrink-0 text-xs text-muted" title={timeFormat.format(new Date(item.publishedAt))}>
                  {ago(item.publishedAt, now)}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-2 text-sm text-muted">
            {state === "loading" ? "Loading headlines…" : "No headlines right now — refresh to try again."}
          </p>
        )}
      </section>
    </section>
  );
}
