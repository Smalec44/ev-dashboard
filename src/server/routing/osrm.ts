import { distanceKm } from "../../lib/geo.ts";
import type { LatLon, RoadRoute } from "../../lib/types.ts";
import { USER_AGENT } from "../http.ts";

/**
 * Road routes from OSRM — by default the instance FOSSGIS runs for the
 * OpenStreetMap community (https://routing.openstreetmap.de/about.html).
 *
 * It is free and needs no key, and its terms come with it: at most one request
 * a second, a User-Agent naming the app, no uptime promise, and no
 * high-traffic or commercial-core use. So every call goes through one queue
 * that spaces them out, answers are cached, a slow answer is abandoned rather
 * than waited on, and every caller keeps a straight-line fallback. Point
 * ROUTING_URL at another OSRM (self-hosted, for anything bigger), or set it to
 * "off" to stop calling out at all.
 */
export const DEFAULT_ROUTING_URL = "https://routing.openstreetmap.de/routed-car";

/** Refused without asking upstream: routing is switched off, or the queue is full. */
export class RoutingUnavailableError extends Error {}

/**
 * The most stops one detour table may carry. The table holds both ends as
 * well, and FOSSGIS answers at most 100 × 100 (101 × 101 is "TooBig").
 */
export const MAX_DETOUR_STOPS = 98;

export interface DetourStop extends LatLon {
  id: string;
}

export interface Router {
  route(from: LatLon, to: LatLon): Promise<RoadRoute>;
  /**
   * Extra road km to call at each stop on the way, by stop id. A stop the
   * router cannot reach from the road is left out rather than guessed.
   */
  detours(from: LatLon, to: LatLon, stops: DetourStop[]): Promise<Map<string, number>>;
}

interface RouterOptions {
  fetch: typeof fetch;
  /** OSRM base URL, e.g. …/routed-car, or "off". */
  baseUrl: string;
  /** Minimum gap between the starts of two upstream calls. */
  intervalMs?: number;
  /** Per call, counted from when it leaves the queue rather than when it joined. */
  timeoutMs?: number;
  /** Calls allowed to wait for their turn; any more fail fast. */
  maxWaiting?: number;
}

const ROUTE_CACHE_PAIRS = 200;
/** Measured stops, across all pairs: a few dozen searches' worth of shortlists. */
const DETOUR_CACHE_STOPS = 5000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const roundPoint = (p: LatLon): LatLon => ({
  lat: Math.round(p.lat * 1e5) / 1e5,
  lon: Math.round(p.lon * 1e5) / 1e5,
});

/**
 * Drops vertices closer than `minGapKm` to the last one kept. OSRM's full
 * geometry has a point every ~40 m, far more than a map line or a
 * nearest-segment search needs; ~150 m keeps every bend a driver would notice
 * at a fraction of the payload. Both ends always survive.
 */
export function thinLine(points: LatLon[], minGapKm = 0.15): LatLon[] {
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last || points.length <= 2) return points.map(roundPoint);
  const kept = [first];
  let previous = first;
  for (const point of points.slice(1, -1)) {
    if (distanceKm(previous, point) >= minGapKm) {
      kept.push(point);
      previous = point;
    }
  }
  kept.push(last);
  return kept.map(roundPoint);
}

interface OsrmBody {
  code?: unknown;
  message?: unknown;
  routes?: unknown;
  distances?: unknown;
}

function describe(body: OsrmBody): string {
  const code = typeof body.code === "string" ? body.code : "no code";
  return typeof body.message === "string" ? `${code}: ${body.message}` : code;
}

/** OSRM's route answer (overview=full, geometries=geojson) as the app's RoadRoute. */
export function parseOsrmRoute(json: unknown): RoadRoute {
  if (typeof json !== "object" || json === null) {
    throw new Error("router answered without a JSON object");
  }
  const body = json as OsrmBody;
  if (body.code !== "Ok") throw new Error(`router answered ${describe(body)}`);
  const route: unknown = Array.isArray(body.routes) ? body.routes[0] : undefined;
  if (typeof route !== "object" || route === null) {
    throw new Error("router answered without a route");
  }
  const { distance, duration, geometry } = route as {
    distance?: unknown;
    duration?: unknown;
    geometry?: { coordinates?: unknown } | null;
  };
  if (typeof distance !== "number" || typeof duration !== "number") {
    throw new Error("router answered without a distance or duration");
  }
  const coordinates: unknown = geometry?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    throw new Error("router answered without a line");
  }
  const line = coordinates.map((pair: unknown) => {
    // GeoJSON order: [lon, lat].
    const [lon, lat] = Array.isArray(pair) ? (pair as unknown[]) : [];
    if (typeof lon !== "number" || typeof lat !== "number") {
      throw new Error("router answered a malformed line");
    }
    return { lat, lon };
  });
  return { distanceKm: distance / 1000, durationMin: duration / 60, line: thinLine(line) };
}

/**
 * OSRM's table answer (annotations=distance): metres from each source to each
 * destination, row by source. A cell is null where the router found no road
 * between the two, which is an answer, not a malformed one.
 */
export function parseOsrmTable(json: unknown): (number | null)[][] {
  if (typeof json !== "object" || json === null) {
    throw new Error("router answered without a JSON object");
  }
  const body = json as OsrmBody;
  if (body.code !== "Ok") throw new Error(`router answered ${describe(body)}`);
  if (!Array.isArray(body.distances)) throw new Error("router answered without distances");
  return body.distances.map((row: unknown) => {
    if (!Array.isArray(row)) throw new Error("router answered a malformed table");
    return row.map((cell: unknown) => {
      if (cell === null) return null;
      if (typeof cell !== "number" || !Number.isFinite(cell)) {
        throw new Error("router answered a malformed table");
      }
      return cell;
    });
  });
}

/** Least-recently-used, with an age limit; Map iteration order is insertion order. */
class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; at: number }>();
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (Date.now() - entry.at > CACHE_TTL_MS) return undefined;
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, { value, at: Date.now() });
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.max) break;
      this.entries.delete(oldest);
    }
  }
}

/**
 * Runs tasks with at least `intervalMs` between their starts, in arrival
 * order. Only calls still waiting for their turn count against `maxWaiting`;
 * past that the caller is refused at once, since a request stuck behind a
 * long queue is worse than the straight-line answer it could have now.
 */
function createQueue(intervalMs: number, maxWaiting: number) {
  let waiting = 0;
  let nextStartAt = 0;
  let tail: Promise<void> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    if (waiting >= maxWaiting) {
      return Promise.reject(new RoutingUnavailableError("router busy"));
    }
    waiting += 1;
    const turn = tail.then(async () => {
      const wait = nextStartAt - Date.now();
      if (wait > 0) await sleep(wait);
      nextStartAt = Date.now() + intervalMs;
      waiting -= 1;
    });
    tail = turn;
    return turn.then(task);
  };
}

/** Rounded to ~10 m, so a town's coordinates hit the same entry however they were typed. */
const pairKey = (from: LatLon, to: LatLon) =>
  [from.lat, from.lon, to.lat, to.lon].map((value) => value.toFixed(4)).join(",");

export function createRouter(options: RouterOptions): Router {
  const { intervalMs = 1000, timeoutMs = 4000, maxWaiting = 8 } = options;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const schedule = createQueue(intervalMs, maxWaiting);
  const routes = new TtlCache<RoadRoute>(ROUTE_CACHE_PAIRS);
  // Two searches for the same pair at once share one upstream call.
  const inFlight = new Map<string, Promise<RoadRoute>>();
  // Per stop on a pair; null remembers "no road to it", so it is not asked again.
  const measuredStops = new TtlCache<number | null>(DETOUR_CACHE_STOPS);

  function call(path: string): Promise<unknown> {
    return schedule(async () => {
      let res: Response;
      let body: unknown;
      try {
        res = await options.fetch(`${baseUrl}${path}`, {
          headers: { "User-Agent": USER_AGENT },
          cache: "no-store",
          signal: AbortSignal.timeout(timeoutMs),
        });
        body = await res.json().catch(() => null);
      } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError") {
          throw new Error(`router did not answer within ${timeoutMs} ms`);
        }
        throw error;
      }
      if (!res.ok) {
        const code = (body as OsrmBody | null)?.code;
        throw new Error(`router returned ${res.status}${typeof code === "string" ? ` (${code})` : ""}`);
      }
      return body;
    });
  }

  function route(from: LatLon, to: LatLon): Promise<RoadRoute> {
    if (baseUrl === "off") {
      return Promise.reject(new RoutingUnavailableError("routing disabled"));
    }
    const key = pairKey(from, to);
    const cached = routes.get(key);
    if (cached) return Promise.resolve(cached);
    const pending = inFlight.get(key);
    if (pending) return pending;

    const coordinates = `${from.lon},${from.lat};${to.lon},${to.lat}`;
    const request = call(`/route/v1/driving/${coordinates}?overview=full&geometries=geojson`)
      .then((body) => {
        const parsed = parseOsrmRoute(body);
        routes.set(key, parsed);
        return parsed;
      })
      .finally(() => {
        inFlight.delete(key);
      });
    inFlight.set(key, request);
    return request;
  }

  /**
   * Road detours for a shortlist, all from one table call: the trip's start,
   * the stops, and its end. Row 0 holds start → each stop and start → end;
   * the last column holds each stop → end. The detour through a stop is the
   * two legs less the direct drive. Stops measured before, on this pair, are
   * served from memory and left out of the request.
   */
  async function detours(
    from: LatLon,
    to: LatLon,
    stops: DetourStop[],
  ): Promise<Map<string, number>> {
    if (stops.length > MAX_DETOUR_STOPS) {
      throw new Error(`at most ${MAX_DETOUR_STOPS} stops per table, not ${stops.length}`);
    }
    if (baseUrl === "off") throw new RoutingUnavailableError("routing disabled");

    const pair = pairKey(from, to);
    // The coordinates are in the key, so a station the feed moves is measured afresh.
    const stopKey = (stop: DetourStop) =>
      `${pair}|${stop.id}|${stop.lat.toFixed(4)},${stop.lon.toFixed(4)}`;
    const found = new Map<string, number>();
    const unmeasured: DetourStop[] = [];
    for (const stop of stops) {
      const known = measuredStops.get(stopKey(stop));
      if (known === undefined) unmeasured.push(stop);
      else if (known !== null) found.set(stop.id, known);
    }
    if (unmeasured.length === 0) return found;

    const n = unmeasured.length;
    const coordinates = [from, ...unmeasured, to].map((p) => `${p.lon},${p.lat}`).join(";");
    const sources = Array.from({ length: n + 1 }, (_, i) => i).join(";");
    const destinations = Array.from({ length: n + 1 }, (_, i) => i + 1).join(";");
    const table = parseOsrmTable(
      await call(
        `/table/v1/driving/${coordinates}?sources=${sources}&destinations=${destinations}&annotations=distance`,
      ),
    );
    if (table.length !== n + 1 || table.some((row) => row.length !== n + 1)) {
      throw new Error("router answered a table of the wrong size");
    }
    const direct = table[0]?.[n];
    if (direct == null) throw new Error("router found no road between the two places");

    unmeasured.forEach((stop, i) => {
      const toStop = table[0]?.[i];
      const onward = table[i + 1]?.[n];
      // Snapping can put a stop a few metres "behind" the road, so a tiny
      // negative is rounding, not a shortcut.
      const km =
        toStop == null || onward == null ? null : Math.max(0, toStop + onward - direct) / 1000;
      measuredStops.set(stopKey(stop), km);
      if (km !== null) found.set(stop.id, km);
    });
    return found;
  }

  return { route, detours };
}

/**
 * The app's one router. Kept on globalThis, not in module scope, so the dev
 * server's hot reloads do not start a fresh queue that forgets the last call
 * was a moment ago. The queue is per server instance: several instances each
 * keep their own one-second spacing.
 */
export function getRouter(): Router {
  const store = globalThis as { __evDashboardRouter?: Router };
  if (!store.__evDashboardRouter) {
    const configured = process.env.ROUTING_URL?.trim();
    store.__evDashboardRouter = createRouter({
      // Resolved per call, so Next's instrumented fetch (and a test's stub) is used.
      fetch: (input, init) => fetch(input, init),
      baseUrl: configured !== undefined && configured !== "" ? configured : DEFAULT_ROUTING_URL,
    });
  }
  return store.__evDashboardRouter;
}
