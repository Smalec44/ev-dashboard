import { detourKm, distanceKm, routeProgress } from "./geo";
import type { ChargingStation, LatLon } from "./types";

/**
 * What a live refresh covers: the same area the search does. Refreshing the
 * whole country per click would mean hundreds of Overpass queries for
 * stations nobody is looking at, so the client names its search and the
 * server rebuilds exactly that.
 */
export type RefreshScope =
  | { mode: "region"; city: string; lat: number; lon: number; radiusKm: number }
  | {
      mode: "trip";
      from: LatLon;
      to: LatLon;
      maxDetourKm: number;
      /** Where along the route (0–1) the break is; the refresh covers only its window. */
      stopAt: number;
      /** Half-width of that window along the route, in km. */
      windowKm: number;
    };

export interface RefreshResponse {
  refreshedAt: string;
  /** Every station the feed now has inside the scope, freshly enriched. */
  stations: ChargingStation[];
  foodAvailable: boolean;
  greenAvailable: boolean;
  parkingAvailable: boolean;
  /** "facet: reason" per pass that failed; the facet is kept from before. */
  errors: string[];
}

/**
 * Mirrors the search: the radius plus anything labelled with the town, or —
 * for a trip — the detour corridor, cut down to the stretch around the break.
 * A whole Geneva → St. Gallen corridor is hundreds of stations nobody will
 * stop at; the window around the chosen stop is what the driver is looking at.
 */
export function inScope(scope: RefreshScope, station: LatLon & { city?: string }): boolean {
  if (scope.mode === "region") {
    return distanceKm(scope, station) <= scope.radiusKm || station.city === scope.city;
  }
  if (detourKm(scope.from, scope.to, station) > scope.maxDetourKm) return false;
  const alongKm =
    Math.abs(routeProgress(scope.from, scope.to, station) - scope.stopAt) *
    distanceKm(scope.from, scope.to);
  return alongKm <= scope.windowKm;
}

export function scopeToParams(scope: RefreshScope): URLSearchParams {
  if (scope.mode === "region") {
    return new URLSearchParams({
      mode: "region",
      city: scope.city,
      lat: String(scope.lat),
      lon: String(scope.lon),
      radiusKm: String(scope.radiusKm),
    });
  }
  return new URLSearchParams({
    mode: "trip",
    fromLat: String(scope.from.lat),
    fromLon: String(scope.from.lon),
    toLat: String(scope.to.lat),
    toLon: String(scope.to.lon),
    maxDetourKm: String(scope.maxDetourKm),
    stopAt: String(scope.stopAt),
    windowKm: String(scope.windowKm),
  });
}

/** Wider than the UI's sliders, so a future slider change cannot silently 400. */
const MAX_KM = 60;

const inSwitzerland = (p: LatLon) =>
  p.lat >= 45 && p.lat <= 48.5 && p.lon >= 5 && p.lon <= 11;

/** The inverse of scopeToParams, refusing anything malformed or off the map. */
export function scopeFromParams(params: URLSearchParams): RefreshScope | null {
  const num = (key: string) => {
    const value = Number(params.get(key));
    return params.has(key) && Number.isFinite(value) ? value : null;
  };
  const km = (key: string) => {
    const value = num(key);
    return value !== null && value > 0 && value <= MAX_KM ? value : null;
  };

  if (params.get("mode") === "region") {
    const lat = num("lat");
    const lon = num("lon");
    const radiusKm = km("radiusKm");
    const city = params.get("city") ?? "";
    if (lat === null || lon === null || radiusKm === null) return null;
    if (!inSwitzerland({ lat, lon })) return null;
    return { mode: "region", city, lat, lon, radiusKm };
  }
  if (params.get("mode") === "trip") {
    const fromLat = num("fromLat");
    const fromLon = num("fromLon");
    const toLat = num("toLat");
    const toLon = num("toLon");
    const maxDetourKm = km("maxDetourKm");
    const windowKm = km("windowKm");
    const stopAt = num("stopAt");
    if (fromLat === null || fromLon === null || toLat === null || toLon === null) return null;
    if (maxDetourKm === null || windowKm === null) return null;
    if (stopAt === null || stopAt < 0 || stopAt > 1) return null;
    const from = { lat: fromLat, lon: fromLon };
    const to = { lat: toLat, lon: toLon };
    if (!inSwitzerland(from) || !inSwitzerland(to)) return null;
    return { mode: "trip", from, to, maxDetourKm, stopAt, windowKm };
  }
  return null;
}

/**
 * Swaps the scoped stations for the fresh set and leaves the rest untouched.
 *
 * Fresh wins outright for everything the feed says — a station gone from the
 * feed disappears, a new one appears, stall counts and live status are the
 * server's. The OpenStreetMap facets are the exception: when a pass failed,
 * the previous build's food, green or parking for that station is kept rather
 * than replaced with nothing, since "Overpass was busy" is not "no cafés".
 */
export function applyRefresh(
  current: ChargingStation[],
  response: RefreshResponse,
  scope: RefreshScope,
): ChargingStation[] {
  const previous = new Map(current.map((station) => [station.id, station]));
  const freshIds = new Set(response.stations.map((station) => station.id));
  const kept = current.filter(
    (station) => !freshIds.has(station.id) && !inScope(scope, station),
  );
  const fresh = response.stations.map((station) => {
    const old = previous.get(station.id);
    if (!old) return station;
    const merged: ChargingStation = { ...station };
    if (!response.foodAvailable) {
      merged.food = old.food;
      if (old.foodCount !== undefined) merged.foodCount = old.foodCount;
      else delete merged.foodCount;
    }
    if (!response.greenAvailable) {
      if (old.green !== undefined) merged.green = old.green;
      else delete merged.green;
      if (old.greenScore !== undefined) merged.greenScore = old.greenScore;
      else delete merged.greenScore;
    }
    if (!response.parkingAvailable) {
      if (old.parking) merged.parking = old.parking;
      else delete merged.parking;
    }
    return merged;
  });
  return [...kept, ...fresh];
}
