"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { connectorPrices } from "@/data/metrics";
import { REGIONS, findRegion } from "@/data/regions";
import {
  CURATED_STATIONS,
  DEFAULT_RADIUS_KM,
  mergeStations,
  stationsNearRegion,
  type StationFeed,
} from "@/data/stations";
import { detourKm as computeDetour, distanceKm, routeProgress } from "@/lib/geo";
import type { ChargingStation } from "@/lib/types";
import {
  DEFAULT_CRITERIA,
  DEFAULT_FOOD_THRESHOLD,
  DEFAULT_REGION_CRITERIA,
  DEFAULT_TRIP_CRITERIA,
  REGION_CRITERIA,
  TRIP_CRITERIA,
  rankStations,
  type Criterion,
} from "@/lib/ranking";

// Criteria that only mean something in one mode; swapped on every mode change
// so a stale "detour" chip cannot silently contribute nothing to the score.
const MODE_ONLY = new Set<Criterion>(
  [...TRIP_CRITERIA, ...REGION_CRITERIA].map((c) => c.id),
);
import { RankingControls, type ConnectorFilter } from "./RankingControls";
import { RegionCombobox } from "./RegionCombobox";
import { StationCard } from "./StationCard";

type Mode = "region" | "trip";

const MODES: { id: Mode; label: string }[] = [
  { id: "region", label: "By region" },
  { id: "trip", label: "Between two places" },
];

const MAX_DETOUR_KM = 25;
const MAX_RADIUS_KM = 25;

/**
 * A nationwide feed puts thousands of stations behind a single query — Zürich
 * alone returns ~180, a long trip over 1600. Rendering every card is slow and
 * useless, and the list is already sorted, so only the head is worth showing.
 */
const RESULT_LIMIT = 50;

/** Fraction of the route at each end treated as "still at the endpoint". */
const ENDPOINT_MARGIN = 0.1;

/** The break slider stays inside the margins: a stop at 0% is not a stop. */
const STOP_AT_MIN = ENDPOINT_MARGIN;
const STOP_AT_MAX = 1 - ENDPOINT_MARGIN;
const DEFAULT_STOP_AT = 0.5;

/** Only ever rendered after the fetch resolves, so it never runs on the server. */
const generatedFormat = new Intl.DateTimeFormat("en-CH", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Zurich",
});

/** How often "open now" is re-checked against the clock. */
const CLOCK_REFRESH_MS = 60_000;

/**
 * useSyncExternalStore compares snapshots by identity, so this has to be one
 * cached Date that changes only on a tick — returning `new Date()` per call
 * makes every render look like a new value and loops forever.
 */
let clockSnapshot: Date | null = null;

function subscribeToClock(onChange: () => void): () => void {
  clockSnapshot = new Date();
  const id = setInterval(() => {
    clockSnapshot = new Date();
    onChange();
  }, CLOCK_REFRESH_MS);
  return () => {
    clearInterval(id);
    clockSnapshot = null;
  };
}

function getClockSnapshot(): Date | null {
  return clockSnapshot;
}

/** No clock before hydration, so open/closed renders as "unknown" on the server. */
function getServerClockSnapshot(): Date | null {
  return null;
}

export function Dashboard() {
  const [mode, setMode] = useState<Mode>("region");
  const [query, setQuery] = useState("Zürich");
  const [fromQuery, setFromQuery] = useState("Zürich");
  const [toQuery, setToQuery] = useState("Lugano");
  const [criteria, setCriteria] = useState<Criterion[]>([
    ...DEFAULT_CRITERIA,
    ...DEFAULT_REGION_CRITERIA,
  ]);
  const [threshold, setThreshold] = useState(DEFAULT_FOOD_THRESHOLD);
  const [connector, setConnector] = useState<ConnectorFilter>("ALL");
  const [maxDetour, setMaxDetour] = useState(MAX_DETOUR_KM);
  const [stopAt, setStopAt] = useState(DEFAULT_STOP_AT);
  const [radius, setRadius] = useState(DEFAULT_RADIUS_KM);
  // The federal feed is ~3 MB, so it is fetched at runtime rather than bundled.
  // The curated seed stations render immediately and are replaced on arrival.
  const [stations, setStations] = useState<ChargingStation[]>(CURATED_STATIONS);
  const [feed, setFeed] = useState<"loading" | "ready" | "error">("loading");
  // When the loaded data was built; null until the first successful fetch,
  // which also tells the status row whether a failure lost anything.
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  // Bumped by the refresh button; the effect re-runs and skips the HTTP cache.
  const [reloads, setReloads] = useState(0);
  // "Open now" is read against the venue's own Swiss clock, so it does not
  // depend on where the viewer is — but it does depend on when the render
  // happens, and the server's moment is not the browser's.
  // useSyncExternalStore serves the server snapshot (null) through the first
  // client render too, so hydration always matches; the real clock only
  // appears once subscribed, and re-renders on its own schedule rather than
  // a manual setState in an effect.
  const now = useSyncExternalStore(subscribeToClock, getClockSnapshot, getServerClockSnapshot);

  useEffect(() => {
    let cancelled = false;
    // A refresh has to reach the server: the file is static and the browser
    // would otherwise happily hand back the copy it already holds.
    fetch("/stations.json", { cache: reloads === 0 ? "default" : "reload" })
      .then((res) => {
        if (!res.ok) throw new Error(`stations.json returned ${res.status}`);
        return res.json() as Promise<StationFeed>;
      })
      .then((data) => {
        if (cancelled) return;
        setStations(mergeStations(data.stations));
        setGeneratedAt(data.generatedAt);
        setFeed("ready");
      })
      .catch(() => {
        if (!cancelled) setFeed("error");
      });
    return () => {
      cancelled = true;
    };
  }, [reloads]);

  function refresh() {
    setFeed("loading");
    setReloads((count) => count + 1);
  }

  const region = useMemo(() => findRegion(query), [query]);
  const from = useMemo(() => findRegion(fromQuery), [fromQuery]);
  const to = useMemo(() => findRegion(toQuery), [toQuery]);
  const endpointsResolved = from !== null && to !== null;
  const sameEndpoints = endpointsResolved && from.slug === to.slug;

  const byConnector = useMemo(
    () =>
      connector === "ALL"
        ? stations
        : stations.filter((s) => s.connectorType === connector),
    [connector, stations],
  );

  const trip = useMemo(() => {
    if (mode !== "trip" || !from || !to || sameEndpoints) return null;
    const directKm = distanceKm(from, to);
    const detours = new Map<string, number>();
    const progress = new Map<string, number>();
    const candidates = [];

    for (const station of byConnector) {
      // Detour is the only hard gate. Being near the halfway point is scored
      // instead of filtered, because a hard band returns nothing on routes
      // whose middle stretch simply has no charging sites.
      const extra = computeDetour(from, to, station);
      if (extra > maxDetour) continue;
      detours.set(station.id, extra);
      progress.set(station.id, routeProgress(from, to, station));
      candidates.push(station);
    }

    // Stations sitting in the origin or destination city are not "stops on the
    // way". Drop the end stretches, but fall back to the full set rather than
    // showing nothing when the two places are close together.
    const middle = candidates.filter((s) => {
      const along = progress.get(s.id) ?? 0.5;
      return along >= ENDPOINT_MARGIN && along <= 1 - ENDPOINT_MARGIN;
    });
    const usedEndpoints = middle.length === 0;

    return {
      from,
      to,
      directKm,
      detours,
      progress,
      candidates: usedEndpoints ? candidates : middle,
      usedEndpoints,
    };
  }, [mode, sameEndpoints, from, to, byConnector, maxDetour]);

  const nearby = useMemo(() => {
    if (mode !== "region" || !region) return null;
    const found = stationsNearRegion(byConnector, region, radius);
    return {
      stations: found.map((entry) => entry.station),
      distances: new Map(found.map((e) => [e.station.id, e.distanceKm])),
    };
  }, [mode, region, byConnector, radius]);

  const ranked = useMemo(() => {
    if (mode === "trip") {
      if (!trip) return [];
      return rankStations(trip.candidates, {
        criteria,
        foodThreshold: threshold,
        detourKm: trip.detours,
        maxDetourKm: maxDetour,
        routeProgress: trip.progress,
        stopAt,
      });
    }
    if (!nearby) return [];
    return rankStations(nearby.stations, {
      criteria,
      foodThreshold: threshold,
      distanceKm: nearby.distances,
      radiusKm: radius,
    });
  }, [mode, trip, nearby, criteria, threshold, maxDetour, radius, stopAt]);

  const prices = useMemo(
    () => connectorPrices(ranked.map((r) => r.station)),
    [ranked],
  );
  const flaggedCount = ranked.filter((r) => r.belowFoodThreshold).length;
  const visible = ranked.slice(0, RESULT_LIMIT);

  function changeMode(next: Mode) {
    setMode(next);
    setCriteria((current) => {
      const base = current.filter((id) => !MODE_ONLY.has(id));
      return next === "trip"
        ? [...base, ...DEFAULT_TRIP_CRITERIA]
        : [...base, ...DEFAULT_REGION_CRITERIA];
    });
  }

  function swapDirection() {
    setFromQuery(toQuery);
    setToQuery(fromQuery);
  }

  function toggleCriterion(id: Criterion) {
    setCriteria((current) =>
      current.includes(id)
        ? current.filter((value) => value !== id)
        : [...current, id],
    );
  }

  return (
    <section className="space-y-6">
      <div className="rounded-xl border border-border bg-surface p-5">
        <div className="mb-5 flex gap-2">
          {MODES.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              onClick={() => changeMode(id)}
              aria-pressed={mode === id}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                mode === id
                  ? "bg-accent-soft text-accent"
                  : "text-muted hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {mode === "region" ? (
          <RegionCombobox
            id="region"
            label="Search region or city"
            value={query}
            onChange={setQuery}
            placeholder="e.g. Basel, Lausanne, TI"
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-[1fr_auto_1fr]">
            <RegionCombobox
              id="from"
              label="From"
              value={fromQuery}
              onChange={setFromQuery}
              placeholder="e.g. Chur, Sion, Bellinzona"
              invalid={fromQuery.trim() !== "" && from === null}
            />
            <button
              type="button"
              onClick={swapDirection}
              title="Swap direction"
              aria-label="Swap direction"
              className="mt-2 self-end rounded-lg border border-border bg-surface-muted px-3 py-2 text-base text-muted transition-colors hover:text-foreground sm:mt-0"
            >
              <span aria-hidden="true">⇄</span>
            </button>
            <RegionCombobox
              id="to"
              label="To"
              value={toQuery}
              onChange={setToQuery}
              placeholder="e.g. Lugano, Genève, St. Gallen"
              invalid={toQuery.trim() !== "" && to === null}
            />
          </div>
        )}

        {mode === "region" && (
          <div className="mt-5">
            <div className="flex items-center justify-between gap-3">
              <label
                htmlFor="radius"
                className="text-xs font-medium uppercase tracking-wide text-muted"
              >
                Search radius
              </label>
              <span className="text-sm font-medium tabular-nums">
                {radius} km
              </span>
            </div>
            <input
              id="radius"
              type="range"
              min={1}
              max={MAX_RADIUS_KM}
              step={1}
              value={radius}
              onChange={(event) => setRadius(Number(event.target.value))}
              className="mt-2 w-full accent-accent"
            />
            <p className="mt-1 text-xs text-muted">
              Around the town centre. Stations the feed already labels with this
              town are always included, however far out they sit.
            </p>
          </div>
        )}

        {mode === "trip" && (
          <div className="mt-5">
            <div className="flex items-center justify-between gap-3">
              <label
                htmlFor="stop-at"
                className="text-xs font-medium uppercase tracking-wide text-muted"
              >
                Charging break
              </label>
              <span className="text-sm font-medium tabular-nums">
                {trip
                  ? `≈ ${Math.round(stopAt * trip.directKm)} km after ${trip.from.city}`
                  : `${Math.round(stopAt * 100)}% of the way`}
              </span>
            </div>
            <input
              id="stop-at"
              type="range"
              min={STOP_AT_MIN}
              max={STOP_AT_MAX}
              step={0.01}
              value={stopAt}
              onChange={(event) => setStopAt(Number(event.target.value))}
              aria-valuetext={`${Math.round(stopAt * 100)}% of the way`}
              className="mt-2 w-full accent-accent"
            />
            <div className="mt-1 flex justify-between text-xs text-muted">
              <span>{from?.city ?? "Start"}</span>
              <span className="tabular-nums">{Math.round(stopAt * 100)}%</span>
              <span>{to?.city ?? "End"}</span>
            </div>
          </div>
        )}

        {mode === "trip" && (
          <div className="mt-5">
            <div className="flex items-center justify-between gap-3">
              <label
                htmlFor="detour"
                className="text-xs font-medium uppercase tracking-wide text-muted"
              >
                Maximum detour
              </label>
              <span className="text-sm font-medium tabular-nums">
                {maxDetour} km
              </span>
            </div>
            <input
              id="detour"
              type="range"
              min={2}
              max={60}
              step={1}
              value={maxDetour}
              onChange={(event) => setMaxDetour(Number(event.target.value))}
              className="mt-2 w-full accent-accent"
            />
          </div>
        )}

        <div className="mt-5">
          <RankingControls
            criteria={criteria}
            onToggleCriterion={toggleCriterion}
            connector={connector}
            onConnectorChange={setConnector}
            threshold={threshold}
            onThresholdChange={setThreshold}
            mode={mode}
          />
        </div>
      </div>

      <div
        className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border px-4 py-3 text-xs ${
          feed === "error" ? "bg-warn-soft text-warn" : "bg-surface text-muted"
        }`}
      >
        <span>
          {feed === "loading" &&
            (generatedAt
              ? "Refreshing the national charging feed…"
              : "Loading the national charging feed — showing seed stations meanwhile.")}
          {feed === "error" &&
            (generatedAt
              ? `Refresh failed — still showing the data from ${generatedFormat.format(new Date(generatedAt))}.`
              : "Could not load the national charging feed. Showing seed stations for the ten original cities only.")}
          {feed === "ready" &&
            generatedAt &&
            `Charging data generated ${generatedFormat.format(new Date(generatedAt))}.`}
        </span>
        <button
          type="button"
          onClick={refresh}
          disabled={feed === "loading"}
          className="rounded-lg border border-border bg-surface-muted px-3 py-1.5 font-medium text-foreground transition-colors hover:text-accent disabled:cursor-wait disabled:opacity-60"
        >
          {feed === "loading" ? "Refreshing…" : feed === "error" ? "Retry" : "Refresh data"}
        </button>
      </div>

      {mode === "region" && !region && query.trim() !== "" && (
        <div className="rounded-xl border border-border bg-surface p-5 text-sm text-muted">
          No region matched “{query}”. Try a city like Bern, Lugano, or a canton
          code like ZH.
        </div>
      )}

      {mode === "trip" && !endpointsResolved && (
        <div className="rounded-xl border border-border bg-surface p-5 text-sm text-muted">
          {from === null && to === null
            ? "Neither place was recognised."
            : `No place matched “${from === null ? fromQuery : toQuery}”.`}{" "}
          Start typing and pick from the suggestions — any of the{" "}
          {REGIONS.length.toLocaleString("de-CH")} listed towns works.
        </div>
      )}

      {mode === "trip" && sameEndpoints && (
        <div className="rounded-xl border border-border bg-surface p-5 text-sm text-muted">
          Pick two different places to see stops along the way.
        </div>
      )}

      {(mode === "trip"
        ? endpointsResolved && !sameEndpoints
        : Boolean(region)) && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">
                {mode === "trip" ? (
                  <>
                    {from?.city} <span className="text-muted">→</span>{" "}
                    {to?.city}
                  </>
                ) : (
                  <>
                    {region!.city}{" "}
                    <span className="text-muted">({region!.canton})</span>
                  </>
                )}
              </h2>
              <p className="text-sm text-muted">
                {mode === "trip" && trip
                  ? `${Math.round(trip.directKm)} km direct · ${ranked.length} stop${ranked.length === 1 ? "" : "s"} within ${maxDetour} km`
                  : `${ranked.length} charging ${ranked.length === 1 ? "spot" : "spots"} within ${radius} km`}
                {flaggedCount > 0 &&
                  ` · ${flaggedCount} flagged for thin food nearby`}
              </p>
            </div>
            <div className="flex gap-4 text-sm">
              <div>
                <span className="text-muted">AC avg </span>
                <span className="font-medium tabular-nums">
                  {prices.ac !== null ? `CHF ${prices.ac.toFixed(2)}` : "—"}
                </span>
              </div>
              <div>
                <span className="text-muted">DC avg </span>
                <span className="font-medium tabular-nums">
                  {prices.dc !== null ? `CHF ${prices.dc.toFixed(2)}` : "—"}
                </span>
              </div>
            </div>
          </div>

          {criteria.length === 0 && (
            <div className="rounded-xl border border-border bg-surface p-5 text-sm text-muted">
              Pick at least one ranking criterion to order these spots.
            </div>
          )}

          {ranked.length === 0 ? (
            <div className="rounded-xl border border-border bg-surface p-5 text-sm text-muted">
              {mode === "trip"
                ? `No charging spots within ${maxDetour} km of the direct line. Widen the detour, or switch the connector filter to All.`
                : `No ${connector === "ALL" ? "" : `${connector} `}charging spots within ${radius} km of ${region?.city}. Widen the radius, or switch the connector filter to All.`}
            </div>
          ) : (
            <div className="space-y-4">
              {visible.map((item, index) => (
                <StationCard
                  key={item.station.id}
                  ranked={item}
                  rank={index + 1}
                  threshold={threshold}
                  detourKm={trip?.detours.get(item.station.id)}
                  routeProgress={trip?.progress.get(item.station.id)}
                  distanceKm={nearby?.distances.get(item.station.id)}
                  searchedCity={region?.city}
                  route={trip ? { from: trip.from, to: trip.to } : undefined}
                  now={now}
                />
              ))}
            </div>
          )}

          {ranked.length > visible.length && (
            <p className="text-xs text-muted">
              Showing the {visible.length} best of {ranked.length} matches.
              Narrow the search with the connector filter{" "}
              {mode === "trip" ? "or a shorter detour" : "or another city"}.
            </p>
          )}

          {mode === "trip" && ranked.length > 0 && (
            <p className="text-xs text-muted">
              {trip?.usedEndpoints &&
                "These two places are close enough that every stop sits near one end, so endpoint stations are included. "}
              Detours are straight-line distances, so real road numbers will be
              higher — use them to compare candidates, not to plan fuel stops.
            </p>
          )}
        </>
      )}
    </section>
  );
}
