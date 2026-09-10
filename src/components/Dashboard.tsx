"use client";

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { connectorPrices } from "@/data/metrics";
import { REGIONS, findRegion } from "@/data/regions";
import {
  CURATED_STATIONS,
  DEFAULT_RADIUS_KM,
  stationsNearRegion,
  type StationFeed,
} from "@/data/stations";
import { routeViaStationUrl, stationMapUrl } from "@/lib/maps";
import { indexRoute, routeQuery, type RouteIndex } from "@/lib/route";
import { measureStations, mergeDetours, selectStops, type TripBasis } from "@/lib/trip";
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
import { StationCard, cardElementId } from "./StationCard";
import { useRoadDetours, type DetourStop } from "./useRoadDetours";
import { useRoadRoute } from "./useRoadRoute";
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
 * useless, so the list is paged and lives in a box of bounded height; the map
 * shows the same page, so every dot has a card to jump to.
 */
const PAGE_SIZE = 20;

/** Fraction of the route at each end treated as "still at the endpoint". */
const ENDPOINT_MARGIN = 0.1;

/**
 * How far along the route a stop may sit from the chosen break, either way.
 * The break slider used to be a preference the score nudged towards, which
 * meant a strong station 80 km from the chosen point still topped the list.
 * Now it is a window: only stations inside it are candidates at all.
 */
const STOP_WINDOW_KM = 20;

/**
 * Stops that get their true road detour. The router's distance table tops
 * out at 100 × 100 places: the trip's two ends plus 98 stops.
 */
const EXACT_DETOUR_STOPS = 98;

/** One empty shortlist, so the detour hook sees the same one every render. */
const NO_STOPS: DetourStop[] = [];

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

/** "2 h 39 min", or "25 min" under the hour. */
function formatDuration(minutes: number): string {
  const total = Math.round(minutes);
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return hours === 0 ? `${rest} min` : `${hours} h ${String(rest).padStart(2, "0")} min`;
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
  // The station the map or a card was last clicked on; the top match until then.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The page is remembered together with the search it belongs to, so a new
  // search starts on page one without an effect having to reset anything.
  const [paging, setPaging] = useState<{ search: string; page: number }>({ search: "", page: 0 });
  const listBox = useRef<HTMLDivElement>(null);
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
  // Called on every render, with no ends outside trip mode, so the hook order
  // never changes; it answers "idle" then and fetches nothing.
  const tripEnds = mode === "trip" && !sameEndpoints;
  const roadRoute = useRoadRoute(tripEnds ? from : null, tripEnds ? to : null);
  const road = roadRoute.state === "ready" ? roadRoute.route : null;

  const byConnector = useMemo(
    () =>
      connector === "ALL"
        ? stations
        : stations.filter((s) => s.connectorType === connector),
    [connector, stations],
  );

  const roadIndex = useMemo(() => (road ? indexRoute(road) : null), [road]);

  // The expensive half of a trip search — one projection onto the road per
  // station — so it runs when the road or the stations change, never on a
  // slider move. Until the road arrives, and if it never does, the straight
  // line between the two towns stands in.
  const measured = useMemo(() => {
    if (!tripEnds || !from || !to) return null;
    const basis: TripBasis = roadIndex
      ? { kind: "road", index: roadIndex }
      : { kind: "straight", from, to };
    return { from, to, stations: byConnector, basis, ...measureStations(byConnector, basis) };
  }, [tripEnds, from, to, roadIndex, byConnector]);

  // The stops as the estimates have them, before any true road detour applies.
  const selection = useMemo(() => {
    if (!measured) return null;
    return {
      from: measured.from,
      to: measured.to,
      basis: measured.basis.kind,
      ...selectStops(measured.stations, measured, {
        maxDetourKm: maxDetour,
        stopAt,
        windowKm: STOP_WINDOW_KM,
      }),
    };
  }, [measured, maxDetour, stopAt]);

  // The stops most worth measuring exactly: the smallest estimated detours.
  const shortlist = useMemo(() => {
    if (selection?.basis !== "road") return NO_STOPS;
    const estimate = (id: string) => selection.detours.get(id) ?? Infinity;
    return [...selection.candidates]
      .sort((a, b) => estimate(a.id) - estimate(b.id))
      .slice(0, EXACT_DETOUR_STOPS)
      .map(({ id, lat, lon }) => ({ id, lat, lon }));
  }, [selection]);
  // Called on every render, like useRoadRoute; off the road it asks nothing.
  const exactDetours = useRoadDetours(
    selection?.basis === "road" ? routeQuery(selection.from, selection.to).toString() : null,
    shortlist,
  );

  const trip = useMemo(() => {
    if (!selection) return null;
    // The straight line has no road to measure on: its detours stay as they are.
    if (selection.basis !== "road") return { ...selection, detourBasis: null };
    return { ...selection, ...mergeDetours(selection, exactDetours, maxDetour) };
  }, [selection, exactDetours, maxDetour]);

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
  const scope = useMemo<{
    scope: RefreshScope;
    label: string;
    /** The road the list was measured on, if any: the refresh merges along it. */
    index: RouteIndex | null;
  } | null>(() => {
    if (mode === "region") {
      if (!region) return null;
      return {
        scope: { mode: "region", city: region.city, lat: region.lat, lon: region.lon, radiusKm: radius },
        label: region.city,
        index: null,
      };
    }
    if (!trip || !measured) return null;
    return {
      scope: {
        mode: "trip",
        from: { lat: trip.from.lat, lon: trip.from.lon },
        to: { lat: trip.to.lat, lon: trip.to.lon },
        maxDetourKm: maxDetour,
        stopAt,
        // A short trip lists the whole corridor, so the refresh must cover it too.
        windowKm: trip.shortTrip ? Math.max(STOP_WINDOW_KM, trip.routeKm) : STOP_WINDOW_KM,
        // The server follows the road only when told to, so both sides agree.
        basis: trip.basis,
      },
      label: `${trip.from.city} → ${trip.to.city}`,
      index: measured.basis.kind === "road" ? measured.basis.index : null,
    };
  }, [mode, region, radius, trip, measured, maxDetour, stopAt]);

  async function refresh() {
    if (!scope || live.state === "busy") return;
    // Taken together at the click, before any await: the corridor asked for
    // and the road it was measured on, even if a new road lands meanwhile.
    const { label, scope: requested, index } = scope;
    setLive({ state: "busy", label });
    try {
      const res = await fetch(`/api/refresh?${scopeToParams(requested)}`, {
        cache: "no-store",
      });
      const body = (await res.json()) as RefreshResponse | { error: string };
      if (!res.ok || "error" in body) {
        throw new Error("error" in body ? body.error : `refresh returned ${res.status}`);
      }
      // applyRefresh uses the road only if the server rebuilt along it too.
      setFeedStations((current) => applyRefresh(current, body, requested, index ?? undefined));
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

  // The static build can be a day old, so the first search is refreshed live
  // once per page load — but only once the national feed is in, since the
  // fresh stations are merged into it and the feed would overwrite them.
  // Later searches refresh on request only: each refresh is a round of
  // Overpass queries on shared public servers.
  const refreshedOnLoad = useRef(false);
  const refreshOnLoad = useEffectEvent(() => {
    if (refreshedOnLoad.current || !scope || live.state !== "idle") return;
    refreshedOnLoad.current = true;
    void refresh();
  });
  useEffect(() => {
    if (feed !== "ready") return;
    // Deferred to a callback: the refresh sets state straight away.
    const id = setTimeout(() => {
      refreshOnLoad();
    }, 0);
    return () => {
      clearTimeout(id);
    };
  }, [feed, scope]);

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

  // Everything that changes what the list contains, in one string.
  const searchKey = [
    mode,
    region?.slug,
    from?.slug,
    to?.slug,
    connector,
    criteria.join(","),
    radius,
    maxDetour,
    stopAt,
    live.state === "done" ? live.at : "",
  ].join("|");
  const pageCount = Math.max(1, Math.ceil(ranked.length / PAGE_SIZE));
  const page = paging.search === searchKey ? Math.min(paging.page, pageCount - 1) : 0;
  const pageStart = page * PAGE_SIZE;
  // Memoised: the map redraws its dots whenever this changes identity.
  const visible = useMemo(
    () => ranked.slice(pageStart, pageStart + PAGE_SIZE),
    [ranked, pageStart],
  );

  function goToPage(next: number) {
    setPaging({ search: searchKey, page: Math.min(Math.max(next, 0), pageCount - 1) });
    listBox.current?.scrollTo({ top: 0 });
  }

  const selected =
    visible.find((item) => item.station.id === selectedId) ?? visible[0];

  const select = useCallback((id: string, scrollTo: boolean) => {
    setSelectedId(id);
    if (scrollTo) {
      // Instant, not smooth: the re-render that follows the click cancels a
      // smooth scroll in Chrome, and the card is often thousands of px away.
      document.getElementById(cardElementId(id))?.scrollIntoView({ block: "center" });
    }
  }, []);
  // Stable, so the map does not redraw its dots on every clock tick.
  const selectFromMap = useCallback((id: string) => select(id, true), [select]);

  const mapRoute = useMemo<MapRoute | undefined>(
    () =>
      trip
        ? { from: trip.from, to: trip.to, stopAt, ...(road && { road: road.line }) }
        : undefined,
    [trip, stopAt, road],
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
              className="mt-1 justify-self-center rounded-lg border border-border bg-surface-muted px-3 py-2 text-base text-muted transition-colors hover:text-foreground sm:mt-0 sm:self-end"
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

        {mode === "trip" && trip?.shortTrip && (
          <p className="mt-5 text-xs text-muted">
            Short trip — every station along the way is listed; the break
            slider appears for trips over {2 * STOP_WINDOW_KM} km.
          </p>
        )}

        {mode === "trip" && !trip?.shortTrip && (
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
                  ? `≈ ${Math.round(stopAt * trip.routeKm)} km after ${trip.from.city}`
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
              Where along the way you would like to stop. Only stations within{" "}
              {STOP_WINDOW_KM} km of this point are listed; “Near the stop
              point” ranks the closest first.
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
              {trip?.basis === "road"
                ? "Extra driving to reach the station and get back on the route, estimated as twice its distance off the road."
                : "How far off the direct line a station may sit. Measured as the crow flies, so the road adds some on top."}
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
            `Refreshing ${live.label} from the federal feed, live stall status and OpenStreetMap — this can take up to a minute…`}
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
                  ? `${road ? `${Math.round(road.distanceKm)} km by road · ${formatDuration(road.durationMin)}` : `${Math.round(trip.routeKm)} km direct`} · ${ranked.length} stop${ranked.length === 1 ? "" : "s"} ${trip.shortTrip ? "along the way" : `within ${STOP_WINDOW_KM} km of the break`}, ${trip.basis === "road" ? `≤ ${maxDetour} km detour` : `${maxDetour} km off the line`}`
                  : `${ranked.length} charging ${ranked.length === 1 ? "spot" : "spots"} within ${radius} km`}
                {flaggedCount > 0 &&
                  ` · ${flaggedCount} flagged for thin food nearby`}
              </p>
              {mode === "trip" && roadRoute.state === "failed" && (
                <p className="mt-0.5 text-xs text-warn" title={roadRoute.message}>
                  Road route unavailable — using straight-line distances.
                </p>
              )}
            </div>
            <div
              className="flex gap-4 text-sm"
              title="Ad-hoc tariffs as published by each operator, with the date they were checked on every card. The federal feed carries no prices; operators without a published tariff get a national default."
            >
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
                <span className="text-muted"> · ad-hoc tariffs</span>
              </div>
            </div>
          </div>

          {selected && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-sm">
              <span className="min-w-0">
                <span className="text-muted">Selected: </span>
                <span className="font-medium">{selected.station.name}</span>
                <span className="text-muted">
                  {" · "}
                  {selected.station.city} · click a dot on the map or a card to
                  change
                </span>
              </span>
              <a
                href={
                  trip
                    ? routeViaStationUrl(trip.from, selected.station, trip.to)
                    : stationMapUrl(selected.station)
                }
                target="_blank"
                rel="noreferrer"
                className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-background transition-opacity hover:opacity-90"
              >
                {trip ? "Open route in Google Maps" : "Open in Google Maps"}{" "}
                <span aria-hidden="true">↗</span>
              </a>
            </div>
          )}

          <ResultsMap
            {...(mapRoute && { route: mapRoute })}
            {...(mapArea && { area: mapArea })}
            stops={visible}
            selectedId={selected?.station.id ?? null}
            onSelect={selectFromMap}
          />

          {criteria.length === 0 && (
            <div className="rounded-xl border border-border bg-surface p-5 text-sm text-muted">
              Pick at least one ranking criterion to order these spots.
            </div>
          )}

          {ranked.length === 0 ? (
            <div className="rounded-xl border border-border bg-surface p-5 text-sm text-muted">
              {mode === "trip"
                ? trip?.shortTrip
                  ? `No charging spots along the way within ${trip.basis === "road" ? `a ${maxDetour} km detour` : `${maxDetour} km of the line`}. Widen the detour, or switch the connector filter to All.`
                  : `No charging spots within ${STOP_WINDOW_KM} km of the break point${trip && trip.corridorCount > 0 ? ` (${trip.corridorCount} elsewhere along the way)` : ""}. Move the break, widen the detour, or switch the connector filter to All.`
                : `No ${connector === "ALL" ? "" : `${connector} `}charging spots within ${radius} km of ${region?.city}. Widen the radius, or switch the connector filter to All.`}
            </div>
          ) : (
            <div
              ref={listBox}
              className="max-h-[75vh] space-y-4 overflow-y-auto rounded-xl border border-border bg-background p-3"
            >
              {visible.map((item, index) => (
                <StationCard
                  key={item.station.id}
                  ranked={item}
                  rank={pageStart + index + 1}
                  threshold={threshold}
                  detourKm={trip?.detours.get(item.station.id)}
                  offRouteKm={trip?.offRoute.get(item.station.id)}
                  detourBasis={trip?.detourBasis?.get(item.station.id)}
                  routeProgress={trip?.progress.get(item.station.id)}
                  distanceKm={nearby?.distances.get(item.station.id)}
                  searchedCity={region?.city}
                  route={trip ? { from: trip.from, to: trip.to } : undefined}
                  now={now}
                  selected={selected?.station.id === item.station.id}
                  onSelect={() => select(item.station.id, false)}
                />
              ))}
            </div>
          )}

          {ranked.length > PAGE_SIZE && (
            <nav
              aria-label="Result pages"
              className="flex flex-wrap items-center justify-between gap-3 text-sm"
            >
              <span className="text-muted tabular-nums">
                {pageStart + 1}–{Math.min(pageStart + PAGE_SIZE, ranked.length)} of{" "}
                {ranked.length} · page {page + 1} of {pageCount}
              </span>
              <span className="flex gap-2">
                <button
                  type="button"
                  onClick={() => goToPage(page - 1)}
                  disabled={page === 0}
                  className="rounded-lg border border-border bg-surface-muted px-3 py-1.5 text-xs font-medium transition-colors hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
                >
                  ← Previous
                </button>
                <button
                  type="button"
                  onClick={() => goToPage(page + 1)}
                  disabled={page >= pageCount - 1}
                  className="rounded-lg border border-border bg-surface-muted px-3 py-1.5 text-xs font-medium transition-colors hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Next →
                </button>
              </span>
            </nav>
          )}

          {mode === "trip" && ranked.length > 0 && (
            <p className="text-xs text-muted">
              {trip?.basis === "road"
                ? "Road route © OpenStreetMap contributors, via OSRM (FOSSGIS). Detours marked by road are measured on the road network; est. are twice the distance off the route."
                : "Detours are straight-line distances, so real road numbers will be higher — use them to compare candidates, not to plan fuel stops."}
            </p>
          )}
        </>
      )}
    </section>
  );
}
