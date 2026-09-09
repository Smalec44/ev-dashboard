import type { LatLon } from "../../lib/types.ts";

/** Overpass order: south, west, north, east. */
export type Bbox = [south: number, west: number, north: number, east: number];

/** Overpass's own bounds object, as returned by `out bb`. */
export interface Bounds {
  minlat: number;
  minlon: number;
  maxlat: number;
  maxlon: number;
}

export function haversineMetres(a: LatLon, b: LatLon): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Metres from a point to the nearest edge of a bounding box; 0 when inside. */
export function metresToBounds(point: LatLon, b: Bounds): number {
  const dLat = Math.max(b.minlat - point.lat, 0, point.lat - b.maxlat);
  const dLon = Math.max(b.minlon - point.lon, 0, point.lon - b.maxlon);
  if (dLat === 0 && dLon === 0) return 0;
  return haversineMetres(point, {
    lat: point.lat + (b.minlat - point.lat > 0 ? dLat : -dLat),
    lon: point.lon + (b.minlon - point.lon > 0 ? dLon : -dLon),
  });
}

/**
 * Overpass boxes are grouped by geography, not by city name.
 *
 * The name is the operator's free text: 26 sites simply say "Schweiz", and
 * Buchs, Marbach and Bürglen each name several places a hundred kilometres
 * apart. Grouping on it produced one box of 24,700 km² and 103,000 km² of box
 * in all — for a country of 41,000 — which is both a lot of POIs downloaded
 * twice and exactly the shape of query Overpass answers with a 504.
 *
 * A fixed grid on the coordinates has neither problem: every box is about a
 * cell wide, and the total tracks where the chargers actually are. Cells are
 * ~11 km on both sides at Swiss latitudes. BBOX_PAD_DEG is far wider than the
 * 400 m search radius, so a site against a cell edge still sees its POIs.
 */
export const CELL_LAT_DEG = 0.1;
export const CELL_LON_DEG = 0.15;
export const BBOX_PAD_DEG = 0.012;

export function cellKey(point: LatLon): string {
  const row = Math.floor(point.lat / CELL_LAT_DEG);
  const col = Math.floor(point.lon / CELL_LON_DEG);
  return `${row}:${col}`;
}

export function bboxFor(points: LatLon[]): Bbox {
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  return [
    Math.min(...lats) - BBOX_PAD_DEG,
    Math.min(...lons) - BBOX_PAD_DEG,
    Math.max(...lats) + BBOX_PAD_DEG,
    Math.max(...lons) + BBOX_PAD_DEG,
  ];
}

/** One padded box per occupied grid cell, tight around the points inside it. */
export function cellBboxes(points: LatLon[]): Bbox[] {
  const byCell = new Map<string, LatLon[]>();
  for (const point of points) {
    const key = cellKey(point);
    const cell = byCell.get(key);
    if (cell) cell.push(point);
    else byCell.set(key, [point]);
  }
  return [...byCell.values()].map(bboxFor);
}
