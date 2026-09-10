import { distanceKm, inSwitzerland } from "./geo";
import type { LatLon } from "./types";

/** The two ends of a road route, as /api/road-route takes them. */
export interface RouteEnds {
  from: LatLon;
  to: LatLon;
}

export function routeQuery(from: LatLon, to: LatLon): URLSearchParams {
  return new URLSearchParams({
    fromLat: String(from.lat),
    fromLon: String(from.lon),
    toLat: String(to.lat),
    toLon: String(to.lon),
  });
}

/**
 * The inverse of routeQuery, refusing anything a router should not be asked:
 * missing or non-numeric values, points outside Switzerland, and a "route"
 * from a place to itself.
 */
export function parseRouteQuery(params: URLSearchParams): RouteEnds | null {
  const num = (key: string) => {
    const raw = params.get(key);
    // Number("") is 0, which would pass for a coordinate; blank means absent.
    if (raw === null || raw.trim() === "") return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  const fromLat = num("fromLat");
  const fromLon = num("fromLon");
  const toLat = num("toLat");
  const toLon = num("toLon");
  if (fromLat === null || fromLon === null || toLat === null || toLon === null) return null;
  return routeEnds({ lat: fromLat, lon: fromLon }, { lat: toLat, lon: toLon });
}

/**
 * Two ends a router may be asked about: both inside Switzerland, and not one
 * place twice. Shared by the route and detour endpoints.
 */
export function routeEnds(from: LatLon, to: LatLon): RouteEnds | null {
  if (!inSwitzerland(from) || !inSwitzerland(to)) return null;
  if (from.lat === to.lat && from.lon === to.lon) return null;
  return { from, to };
}

/** Km per degree of latitude, on the same sphere as geo.ts. */
export const KM_PER_DEGREE = (6371 * Math.PI) / 180;

/** A road made ready to measure stations against. */
export interface RouteIndex {
  line: LatLon[];
  /** Km from the start at each vertex of `line`; the last one is `totalKm`. */
  cumKm: number[];
  totalKm: number;
  bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number };
}

/**
 * Indexes a road for projection.
 *
 * The thinned line runs a little shorter than the road the router measured —
 * every 150 m step cuts a corner — so the km along it are stretched evenly to
 * the router's distance. "103 km after Zürich" on the slider, the header's
 * 206 km and a station's progress are then all the same kilometres. Without a
 * distance the line keeps its own length; fractions along it come out the
 * same either way, which is all the map needs.
 */
export function indexRoute(route: { line: LatLon[]; distanceKm?: number }): RouteIndex {
  const { line } = route;
  const cumKm: number[] = [];
  const bbox = { minLat: Infinity, maxLat: -Infinity, minLon: Infinity, maxLon: -Infinity };
  let length = 0;
  let previous: LatLon | undefined;
  for (const point of line) {
    if (previous) length += distanceKm(previous, point);
    cumKm.push(length);
    previous = point;
    bbox.minLat = Math.min(bbox.minLat, point.lat);
    bbox.maxLat = Math.max(bbox.maxLat, point.lat);
    bbox.minLon = Math.min(bbox.minLon, point.lon);
    bbox.maxLon = Math.max(bbox.maxLon, point.lon);
  }
  const totalKm = route.distanceKm ?? length;
  const scale = length > 0 ? totalKm / length : 0;
  const scaled = cumKm.map((km) => km * scale);
  // Pinned rather than left to the multiplication, so the end is exactly totalKm.
  if (length > 0) scaled[scaled.length - 1] = totalKm;
  return { line, cumKm: scaled, totalKm, bbox };
}

/**
 * Where a point meets the road: how far along it, in the index's scaled km,
 * and how far off it, in true km — the router never measured that leg.
 *
 * The nearest segment wins, measured flat in a projection centred on the
 * point. Over the few tens of km that matter here that is within metres of
 * the sphere, and this is the inner loop of every trip search.
 */
export function projectOntoRoute(
  index: RouteIndex,
  point: LatLon,
): { alongKm: number; offKm: number } {
  const { line, cumKm } = index;
  const kx = Math.cos((point.lat * Math.PI) / 180) * KM_PER_DEGREE;
  // The point is the origin; each vertex sits x km east and y km north of it.
  const x = (p: LatLon) => (p.lon - point.lon) * kx;
  const y = (p: LatLon) => (p.lat - point.lat) * KM_PER_DEGREE;
  // Nowhere on an empty road, so never within any detour.
  const first = line[0];
  if (!first) return { alongKm: 0, offKm: Infinity };

  let ax = x(first);
  let ay = y(first);
  let bestSq = ax * ax + ay * ay;
  let bestAlong = 0;
  // Nearest a segment could possibly come on one axis: 0 if it straddles it.
  const gap = (a: number, b: number) => (a > 0 && b > 0 ? Math.min(a, b) : a < 0 && b < 0 ? -Math.max(a, b) : 0);
  for (let i = 1; i < line.length; i++) {
    const vertex = line[i];
    if (!vertex) break;
    const bx = x(vertex);
    const by = y(vertex);
    const gapX = gap(ax, bx);
    const gapY = gap(ay, by);
    // Most segments are nowhere near; the box test skips them cheaply.
    if (gapX * gapX + gapY * gapY < bestSq) {
      const dx = bx - ax;
      const dy = by - ay;
      const lengthSq = dx * dx + dy * dy;
      const t = lengthSq > 0 ? Math.min(Math.max(-(ax * dx + ay * dy) / lengthSq, 0), 1) : 0;
      const px = ax + t * dx;
      const py = ay + t * dy;
      const distSq = px * px + py * py;
      if (distSq < bestSq) {
        bestSq = distSq;
        const start = cumKm[i - 1] ?? 0;
        bestAlong = start + t * ((cumKm[i] ?? start) - start);
      }
    }
    ax = bx;
    ay = by;
  }
  return { alongKm: bestAlong, offKm: Math.sqrt(bestSq) };
}

/** The point `fraction` (0–1) of the way along the road, by road km. */
export function pointAlong(index: RouteIndex, fraction: number): LatLon {
  const { line, cumKm } = index;
  const target = Math.min(Math.max(fraction, 0), 1) * index.totalKm;
  // The first vertex at or past the target.
  let low = 0;
  let high = cumKm.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((cumKm[middle] ?? 0) < target) low = middle + 1;
    else high = middle;
  }
  const end = line[low];
  if (!end) throw new Error("pointAlong on an empty route");
  const start = line[low - 1];
  if (!start) return end;
  const startKm = cumKm[low - 1] ?? 0;
  const endKm = cumKm[low] ?? startKm;
  const t = endKm > startKm ? (target - startKm) / (endKm - startKm) : 0;
  return { lat: start.lat + (end.lat - start.lat) * t, lon: start.lon + (end.lon - start.lon) * t };
}
