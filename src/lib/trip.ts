import { distanceKm, detourKm as straightDetourKm, routeProgress as straightProgress } from "./geo";
import { KM_PER_DEGREE, projectOntoRoute, type RouteIndex } from "./route";
import type { LatLon } from "./types";

/**
 * Which stations are stops on a trip. Measured against the real road when the
 * router answered, and against the straight line between the two towns when
 * it did not — the fallback is exactly what the app did before it had roads.
 */
export type TripBasis =
  | { kind: "road"; index: RouteIndex }
  | { kind: "straight"; from: LatLon; to: LatLon };

export interface StationMeasure {
  /**
   * Extra km to call at the station. On a road, an estimate: out to the
   * station and back, twice its distance off the route. On the straight
   * line, how much longer the trip gets through it.
   */
  detourKm: number;
  /** Km from the road; null on the straight line, where there is no road. */
  offRouteKm: number | null;
  /** 0 at the start, 1 at the end, in the same km as `routeKm`. */
  progress: number;
}

export interface MeasuredStations {
  /** Length of the trip: the router's road km, or the straight line's. */
  routeKm: number;
  byId: Map<string, StationMeasure>;
}

type Place = LatLon & { id: string };

/**
 * Half the detour slider's maximum of 60 km: with the detour estimated as
 * twice the distance off the road, nothing further off could ever pass, so
 * the road's box widened by this much is all that needs projecting.
 */
const MAX_OFF_ROUTE_KM = 30;

/**
 * Detour and progress for every station that could be a stop. The expensive
 * part of a trip search, so it runs once per road and station set; moving the
 * sliders only re-runs selectStops.
 */
export function measureStations(stations: readonly Place[], basis: TripBasis): MeasuredStations {
  const byId = new Map<string, StationMeasure>();
  if (basis.kind === "straight") {
    const { from, to } = basis;
    for (const station of stations) {
      byId.set(station.id, {
        detourKm: straightDetourKm(from, to, station),
        offRouteKm: null,
        progress: straightProgress(from, to, station),
      });
    }
    return { routeKm: distanceKm(from, to), byId };
  }

  const { index } = basis;
  const { bbox } = index;
  const padLat = MAX_OFF_ROUTE_KM / KM_PER_DEGREE;
  const widestLat = Math.max(Math.abs(bbox.minLat), Math.abs(bbox.maxLat));
  const padLon = padLat / Math.cos((widestLat * Math.PI) / 180);
  for (const station of stations) {
    if (
      station.lat < bbox.minLat - padLat ||
      station.lat > bbox.maxLat + padLat ||
      station.lon < bbox.minLon - padLon ||
      station.lon > bbox.maxLon + padLon
    ) {
      continue;
    }
    byId.set(station.id, measureOnRoad(index, station));
  }
  return { routeKm: index.totalKm, byId };
}

/**
 * One station against the road. Shared with the live refresh, which has to
 * draw the corridor exactly where the list does.
 */
export function measureOnRoad(index: RouteIndex, point: LatLon): StationMeasure {
  const { alongKm, offKm } = projectOntoRoute(index, point);
  return {
    detourKm: 2 * offKm,
    offRouteKm: offKm,
    progress: index.totalKm > 0 ? alongKm / index.totalKm : 0.5,
  };
}

export interface StopOptions {
  /** The detour slider: the one hard gate on the corridor. */
  maxDetourKm: number;
  /** Where along the way (0–1) the driver wants the break. */
  stopAt: number;
  /** How far along the route a stop may sit from the break, either way. */
  windowKm: number;
}

/**
 * Once the trip is no longer than two windows, the window covers the whole
 * route wherever the break sits, so every corridor station is a stop and
 * the break slider is moot.
 */
const isShortTrip = (routeKm: number, windowKm: number) => routeKm <= 2 * windowKm;

/**
 * A stop is inside the detour cap and near the break. Being near the break
 * is a window in km, so a short trip gets the same tolerance as a long one.
 */
export function isStop(measure: StationMeasure, routeKm: number, opts: StopOptions): boolean {
  if (measure.detourKm > opts.maxDetourKm) return false;
  if (isShortTrip(routeKm, opts.windowKm)) return true;
  return Math.abs(measure.progress - opts.stopAt) <= opts.windowKm / routeKm;
}

export interface StopSelection<T> {
  /** Stops: the corridor stations inside the break window, in input order. */
  candidates: T[];
  /** Detour and progress for the whole corridor, not only the window. */
  detours: Map<string, number>;
  progress: Map<string, number>;
  /** Km off the road; empty on the straight line. */
  offRoute: Map<string, number>;
  shortTrip: boolean;
  /** Stations anywhere along the way within the detour cap. */
  corridorCount: number;
  routeKm: number;
}

/**
 * The stops for the sliders' current values. Detour is the only hard gate on
 * the corridor: being near the break used to be scored rather than filtered,
 * and a strong station 80 km from the chosen point then topped the list. Now
 * only stations within the window around the break are stops at all.
 */
export function selectStops<T extends Place>(
  stations: readonly T[],
  measured: MeasuredStations,
  opts: StopOptions,
): StopSelection<T> {
  const { routeKm, byId } = measured;
  const candidates: T[] = [];
  const detours = new Map<string, number>();
  const progress = new Map<string, number>();
  const offRoute = new Map<string, number>();
  let corridorCount = 0;

  for (const station of stations) {
    const measure = byId.get(station.id);
    if (!measure || measure.detourKm > opts.maxDetourKm) continue;
    corridorCount += 1;
    detours.set(station.id, measure.detourKm);
    progress.set(station.id, measure.progress);
    if (measure.offRouteKm !== null) offRoute.set(station.id, measure.offRouteKm);
    if (isStop(measure, routeKm, opts)) candidates.push(station);
  }

  return {
    candidates,
    detours,
    progress,
    offRoute,
    shortTrip: isShortTrip(routeKm, opts.windowKm),
    corridorCount,
    routeKm,
  };
}

/**
 * Folds true road detours into a road-basis selection. Measured stations get
 * the router's figure — there, to the station and on to the destination,
 * less the direct drive — and the rest keep the estimate, with `detourBasis`
 * saying which is which. A station whose true detour is over the cap leaves
 * every map, and the corridor count with it.
 *
 * Expect some large figures: a service area on the opposite carriageway is
 * a few metres off the route but a long way round by car, because you cannot
 * cross a motorway. That is the right answer, not a glitch.
 */
export function mergeDetours<T extends Place>(
  selection: StopSelection<T>,
  exact: ReadonlyMap<string, number>,
  maxDetourKm: number,
): StopSelection<T> & { detourBasis: Map<string, "road" | "est"> } {
  const detours = new Map<string, number>();
  const progress = new Map(selection.progress);
  const offRoute = new Map(selection.offRoute);
  const detourBasis = new Map<string, "road" | "est">();
  let corridorCount = selection.corridorCount;

  for (const [id, estimate] of selection.detours) {
    const road = exact.get(id);
    if (road === undefined) {
      detours.set(id, estimate);
      detourBasis.set(id, "est");
    } else if (road > maxDetourKm) {
      progress.delete(id);
      offRoute.delete(id);
      corridorCount -= 1;
    } else {
      detours.set(id, road);
      detourBasis.set(id, "road");
    }
  }

  return {
    ...selection,
    candidates: selection.candidates.filter((station) => detours.has(station.id)),
    detours,
    progress,
    offRoute,
    detourBasis,
    corridorCount,
  };
}
