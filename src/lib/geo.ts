import type { LatLon } from "./types";

const EARTH_RADIUS_KM = 6371;

const toRad = (deg: number) => (deg * Math.PI) / 180;

export function distanceKm(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/**
 * Extra distance added by stopping at `via` on the way from `from` to `to`.
 * Straight-line, so it under-reads against real Swiss roads — treat it as a
 * comparison between candidates, not a routing estimate.
 */
export function detourKm(from: LatLon, to: LatLon, via: LatLon): number {
  return distanceKm(from, via) + distanceKm(via, to) - distanceKm(from, to);
}

/** How far along the route the stop sits, 0 = at origin, 1 = at destination. */
export function routeProgress(from: LatLon, to: LatLon, via: LatLon): number {
  const legs = distanceKm(from, via) + distanceKm(via, to);
  if (legs === 0) return 0.5;
  return distanceKm(from, via) / legs;
}
