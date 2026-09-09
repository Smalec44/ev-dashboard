"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { connectorPrices } from "@/data/metrics";
import { REGIONS, findRegion, matchRegions } from "@/data/regions";
import {
  CURATED_STATIONS,
  DEFAULT_RADIUS_KM,
  mergeStations,
  stationsNearRegion,
  type StationFeed,
} from "@/data/stations";
import { detourKm as computeDetour, distanceKm, routeProgress } from "@/lib/geo";
import type { ChargingStation, Region } from "@/lib/types";
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

/**
 * Datalist entries, built once. Names shared across cantons (Buchs SG/AG,
 * Wohlen AG/BE, …) are qualified so picking one is unambiguous; findRegion
 * folds the punctuation away and matches the canton-qualified alias.
 */
// Folded the same way findRegion folds, so pairs that differ only by diacritic
// (Brugg AG vs Brügg BE) count as ambiguous too — lowercasing alone misses them.
const foldCity = (value: string) =>
  value.toLowerCase().normalize("NFD").replace(/[^a-z]/g, "");

const AMBIGUOUS_CITIES = new Set(
  REGIONS.map((r) => foldCity(r.city)).filter(
    (city, i, all) => all.indexOf(city) !== i,
  ),
);

function optionValue(region: Region): string {
  return AMBIGUOUS_CITIES.has(foldCity(region.city))
    ? `${region.city} (${region.canton})`
    : region.city;
}

/**
 * One datalist per input, holding only the current query's best matches.
 * A shared list of all 1000 towns made Chrome render a full-height popup
 * detached from the field as soon as a single letter matched hundreds.
 */
function RegionOptions({ id, query }: { id: string; query: string }) {
  const options = useMemo(() => matchRegions(query), [query]);
  return (
    <datalist id={id}>
      {options.map((region) => (
        <option key={region.slug} value={optionValue(region)}>
          {region.canton}
        </option>
      ))}
    </datalist>
  );
}

/** Fraction of the route at each end treated as "still at the endpoint". */
const ENDPOINT_MARGIN = 0.1;

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

/** The server has no viewer clock to trust, so it renders as "unknown". */
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
  const [radius, setRadius] = useState(DEFAULT_RADIUS_KM);
  // The federal feed is ~3 MB, so it is fetched at runtime rather than bundled.
  // The curated seed stations render immediately and are replaced on arrival.
  const [stations, setStations] = useState<ChargingStation[]>(CURATED_STATIONS);
  const [feed, setFeed] = useState<"loading" | "ready" | "error">("loading");
  // "Open now" depends on the viewer's clock, which the server doesn't have.
  // useSyncExternalStore serves the server snapshot (null) through the first
  // client render too, so hydration always matches; the real clock only
  // appears once subscribed, and re-renders on its own schedule rather than
  // a manual setState in an effect.
  const now = useSyncExternalStore(subscribeToClock, getClockSnapshot, getServerClockSnapshot);

  useEffect(() => {
    let cancelled = false;
    fetch("/stations.json")
      .then((res) => {
        if (!res.ok) throw new Error(`stations.json returned ${res.status}`);
        return res.json() as Promise<StationFeed>;
      })
      .then((data) => {
        if (cancelled) return;
        setStations(mergeStations(data.stations));
        setFeed("ready");
      })
      .catch(() => {
        if (!cancelled) setFeed("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
        routeProgress: trip.progress,
      });
    }
    if (!nearby) return [];
    return rankStations(nearby.stations, {
      criteria,
      foodThreshold: threshold,
      distanceKm: nearby.distances,
    });
  }, [mode, trip, nearby, criteria, threshold]);

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
          <div>
            <label
              htmlFor="region"
              className="text-xs font-medium uppercase tracking-wide text-muted"
            >
              Search region or city
            </label>
            <RegionOptions id="regions-single" query={query} />
            <input
              id="region"
              list="regions-single"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="e.g. Basel, Lausanne, TI"
              className="mt-2 w-full rounded-lg border border-border bg-background px-3 py-2 text-base outline-none focus:border-accent"
            />
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label
                htmlFor="from"
                className="text-xs font-medium uppercase tracking-wide text-muted"
              >
                From
              </label>
              <RegionOptions id="regions-from" query={fromQuery} />
              <input
                id="from"
                list="regions-from"
                value={fromQuery}
                onChange={(event) => setFromQuery(event.target.value)}
                placeholder="e.g. Chur, Sion, Bellinzona"
                aria-invalid={fromQuery.trim() !== "" && from === null}
                className={`mt-2 w-full rounded-lg border bg-background px-3 py-2 text-base outline-none focus:border-accent ${
                  fromQuery.trim() !== "" && from === null
                    ? "border-warn"
                    : "border-border"
                }`}
              />
            </div>
            <div>
              <label
                htmlFor="to"
                className="text-xs font-medium uppercase tracking-wide text-muted"
              >
                To
              </label>
              <RegionOptions id="regions-to" query={toQuery} />
              <input
                id="to"
                list="regions-to"
                value={toQuery}
                onChange={(event) => setToQuery(event.target.value)}
                placeholder="e.g. Lugano, Genève, St. Gallen"
                aria-invalid={toQuery.trim() !== "" && to === null}
                className={`mt-2 w-full rounded-lg border bg-background px-3 py-2 text-base outline-none focus:border-accent ${
                  toQuery.trim() !== "" && to === null
                    ? "border-warn"
                    : "border-border"
                }`}
              />
            </div>
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

      {feed !== "ready" && (
        <p
          className={`rounded-xl border border-border px-4 py-3 text-xs ${
            feed === "error" ? "bg-warn-soft text-warn" : "bg-surface text-muted"
          }`}
        >
          {feed === "loading"
            ? "Loading the national charging feed — showing seed stations meanwhile."
            : "Could not load the national charging feed. Showing seed stations for the ten original cities only."}
        </p>
      )}

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
