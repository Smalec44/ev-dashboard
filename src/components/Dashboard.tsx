"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { connectorPrices } from "@/data/metrics";
import { REGIONS, findRegion } from "@/data/regions";
import {
  CURATED_STATIONS,
  DEFAULT_RADIUS_KM,
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
import { ResultsMap, type MapArea, type MapRoute } from "./ResultsMap";
import { StationCard } from "./StationCard";
import {
  applyRefresh,
  scopeToParams,
  type RefreshResponse,
  type RefreshScope,
} from "@/lib/refresh";

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

type LiveRefresh =
  | { state: "idle" }
  | { state: "busy"; label: string }
  | { state: "done"; label: string; at: string; count: number; errors: string[] }
  | { state: "error"; message: string };

/** "food and green", from the "facet: reason" lines a refresh reports. */
function liveGaps(errors: string[]): string {
  const facets = errors.map((error) => error.split(":")[0] ?? error);
  return facets.length > 1
    ? `${facets.slice(0, -1).join(", ")} and ${facets.at(-1) ?? ""}`
    : (facets[0] ?? "");
}

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
  // While a name is half-typed nothing matches, and dropping the results for
  // those keystrokes made the whole page jump. The last place that resolved
  // stays on screen until the new one does; the message above says so.
  const [lastRegion, setLastRegion] = useState(() => findRegion("Zürich"));
  const [lastFrom, setLastFrom] = useState(() => findRegion("Zürich"));
  const [lastTo, setLastTo] = useState(() => findRegion("Lugano"));

  function changeQuery(next: string) {
    setQuery(next);
    const found = findRegion(next);
    if (found) setLastRegion(found);
  }
  function changeFromQuery(next: string) {
    setFromQuery(next);
    const found = findRegion(next);
    if (found) setLastFrom(found);
  }
  function changeToQuery(next: string) {
    setToQuery(next);
    const found = findRegion(next);
    if (found) setLastTo(found);
  }
  const [criteria, setCriteria] = useState<Criterion[]>([
    ...DEFAULT_CRITERIA,
    ...DEFAULT_REGION_CRITERIA,
  ]);
  const [threshold, setThreshold] = useState(DEFAULT_FOOD_THRESHOLD);
  const [connector, setConnector] = useState<ConnectorFilter>("ALL");
  const [maxDetour, setMaxDetour] = useState(MAX_DETOUR_KM);
  const [stopAt, setStopAt] = useState(DEFAULT_STOP_AT);
  const [radius, setRadius] = useState(DEFAULT_RADIUS_KM);
  // The federal feed is ~10 MB, so it is fetched at runtime rather than bundled.
  // The curated seed stations stand in until it arrives, and only until then:
  // they carry hand-written uptime and restaurant ratings that no real record
  // has, and mixed into the feed they won every ranking they appeared in.
  const [feedStations, setFeedStations] = useState<ChargingStation[]>([]);
  const stations = feedStations.length > 0 ? feedStations : CURATED_STATIONS;
  const [feed, setFeed] = useState<"loading" | "ready" | "error">("loading");
  /** When the static build was generated; null until it has loaded. */
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [live, setLive] = useState<LiveRefresh>({ state: "idle" });
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
    fetch("/stations.json")
      .then((res) => {
        if (!res.ok) throw new Error(`stations.json returned ${res.status}`);
        return res.json() as Promise<StationFeed>;
      })
      .then((data) => {
        if (cancelled) return;
        setFeedStations(data.stations);
        setGeneratedAt(data.generatedAt);
        setFeed("ready");
      })
      .catch(() => {
        if (!cancelled) setFeed("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const matchedRegion = useMemo(() => findRegion(query), [query]);
  const matchedFrom = useMemo(() => findRegion(fromQuery), [fromQuery]);
  const matchedTo = useMemo(() => findRegion(toQuery), [toQuery]);
  const region = matchedRegion ?? lastRegion;
  const from = matchedFrom ?? lastFrom;
  const to = matchedTo ?? lastTo;
  const endpointsResolved = matchedFrom !== null && matchedTo !== null;
  const sameEndpoints = from !== null && to !== null && from.slug === to.slug;

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

  // The live refresh covers exactly what is being searched, so the button is
  // only offered once the search resolves to somewhere.
  const scope = useMemo<{ scope: RefreshScope; label: string } | null>(() => {
    if (mode === "region") {
      if (!region) return null;
      return {
        scope: { mode: "region", city: region.city, lat: region.lat, lon: region.lon, radiusKm: radius },
        label: region.city,
      };
    }
    if (!trip) return null;
    return {
      scope: {
        mode: "trip",
        from: { lat: trip.from.lat, lon: trip.from.lon },
        to: { lat: trip.to.lat, lon: trip.to.lon },
        maxDetourKm: maxDetour,
      },
      label: `${trip.from.city} → ${trip.to.city}`,
    };
  }, [mode, region, radius, trip, maxDetour]);

  async function refresh() {
    if (!scope || live.state === "busy") return;
    const { label } = scope;
    setLive({ state: "busy", label });
    try {
      const res = await fetch(`/api/refresh?${scopeToParams(scope.scope)}`, {
        cache: "no-store",
      });
      const body = (await res.json()) as RefreshResponse | { error: string };
      if (!res.ok || "error" in body) {
        throw new Error("error" in body ? body.error : `refresh returned ${res.status}`);
      }
      setFeedStations((current) => applyRefresh(current, body, scope.scope));
      setLive({
        state: "done",
        label,
        at: body.refreshedAt,
        count: body.stations.length,
        errors: body.errors,
      });
    } catch (error) {
      setLive({
        state: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

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
  // Memoised: the map redraws its dots whenever this changes identity.
  const visible = useMemo(() => ranked.slice(0, RESULT_LIMIT), [ranked]);

  const mapRoute = useMemo<MapRoute | undefined>(
    () => (trip ? { from: trip.from, to: trip.to, stopAt } : undefined),
    [trip, stopAt],
  );
  const mapArea = useMemo<MapArea | undefined>(
    () =>
      mode === "region" && region ? { centre: region, radiusKm: radius } : undefined,
    [mode, region, radius],
  );

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
    setLastFrom(lastTo);
    setLastTo(lastFrom);
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
            onChange={changeQuery}
            placeholder="e.g. Basel, Lausanne, TI"
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-[1fr_auto_1fr]">
            <RegionCombobox
              id="from"
              label="From"
              value={fromQuery}
              onChange={changeFromQuery}
              placeholder="e.g. Chur, Sion, Bellinzona"
              invalid={fromQuery.trim() !== "" && matchedFrom === null}
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
              onChange={changeToQuery}
              placeholder="e.g. Lugano, Genève, St. Gallen"
              invalid={toQuery.trim() !== "" && matchedTo === null}
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
            <p className="mt-1 text-xs text-muted">
              Where along the way you would like to stop. With “Near the stop
              point” on, stations close to this point rank higher.
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
            <p className="mt-1 text-xs text-muted">
              How far off the direct line a station may sit. Measured as the
              crow flies, so the road adds some on top.
            </p>
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
          feed === "error" || live.state === "error"
            ? "bg-warn-soft text-warn"
            : "bg-surface text-muted"
        }`}
      >
        <span className="min-w-0">
          {feed === "loading" &&
            "Loading the national charging feed — showing seed stations meanwhile. "}
          {feed === "error" &&
            "Could not load the national charging feed. Showing seed stations for the ten original cities only. "}
          {feed === "ready" &&
            generatedAt &&
            `Charging data built ${generatedFormat.format(new Date(generatedAt))}. `}
          {live.state === "busy" &&
            `Refreshing ${live.label} from the federal feed, live stall status and OpenStreetMap — up to a minute for a long trip…`}
          {live.state === "done" && (
            <>
              Live for {live.label} since {generatedFormat.format(new Date(live.at))}
              {" "}({live.count} stations
              {live.errors.length > 0 &&
                `; ${liveGaps(live.errors)} unavailable, kept from the build`}
              ).
            </>
          )}
          {live.state === "error" && `Live refresh failed: ${live.message}`}
        </span>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={live.state === "busy" || !scope}
          title={
            scope
              ? `Re-fetch the federal feed, live stall status and OpenStreetMap for ${scope.label}`
              : "Pick a place first — the refresh covers the current search area"
          }
          className="rounded-lg border border-border bg-surface-muted px-3 py-1.5 font-medium text-foreground transition-colors hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
        >
          {live.state === "busy" ? "Refreshing…" : "Refresh live data"}
        </button>
      </div>

      {mode === "region" && !matchedRegion && query.trim() !== "" && (
        <div className="rounded-xl border border-border bg-surface p-5 text-sm text-muted">
          No region matched “{query}”. Try a city like Bern, Lugano, or a canton
          code like ZH.{region && ` Still showing ${region.city} meanwhile.`}
        </div>
      )}

      {mode === "trip" && !endpointsResolved && (
        <div className="rounded-xl border border-border bg-surface p-5 text-sm text-muted">
          {matchedFrom === null && matchedTo === null
            ? "Neither place was recognised."
            : `No place matched “${matchedFrom === null ? fromQuery : toQuery}”.`}{" "}
          Start typing and pick from the suggestions — any of the{" "}
          {REGIONS.length.toLocaleString("de-CH")} listed towns works.
          {trip && ` Still showing ${trip.from.city} → ${trip.to.city} meanwhile.`}
        </div>
      )}

      {mode === "trip" && sameEndpoints && (
        <div className="rounded-xl border border-border bg-surface p-5 text-sm text-muted">
          Pick two different places to see stops along the way.
        </div>
      )}

      {(mode === "trip" ? Boolean(trip) : Boolean(region)) && (
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
                    {region?.city}{" "}
                    <span className="text-muted">({region?.canton})</span>
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

          <ResultsMap
            {...(mapRoute && { route: mapRoute })}
            {...(mapArea && { area: mapArea })}
            stops={visible}
          />

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
