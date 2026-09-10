import assert from "node:assert/strict";
import { test } from "node:test";
import { detourKm, distanceKm, routeProgress } from "./geo.ts";
import { indexRoute } from "./route.ts";
import {
  isStop,
  measureStations,
  mergeDetours,
  selectStops,
  type MeasuredStations,
  type StopOptions,
} from "./trip.ts";
import type { LatLon } from "./types.ts";

type Place = LatLon & { id: string };

/**
 * An L-shaped road: 0.5° north, then 0.66° east. The straight chord between
 * its ends cuts the corner, and the middle of that chord is over 20 km from
 * any part of the road.
 */
const L_START = { lat: 46.5, lon: 7 };
const L_CORNER = { lat: 47, lon: 7 };
const L_END = { lat: 47, lon: 7.66 };
const L_ROAD = indexRoute({
  distanceKm: distanceKm(L_START, L_CORNER) + distanceKm(L_CORNER, L_END),
  line: [L_START, L_CORNER, L_END],
});

/** No window to speak of: these tests are about the corridor. */
const WIDE: StopOptions = { maxDetourKm: 25, stopAt: 0.5, windowKm: 1000 };

const ids = (places: Place[]) => places.map((place) => place.id);

test("on a winding road the corridor follows the road, not the line between the towns", () => {
  const onChord = { id: "on-chord", lat: 46.75, lon: 7.33 };
  const besideRoad = { id: "beside-road", lat: 46.75, lon: 7.02 };
  const stations = [onChord, besideRoad];

  const road = measureStations(stations, { kind: "road", index: L_ROAD });
  assert.ok((road.byId.get("on-chord")?.offRouteKm ?? 0) > 20, "the chord's middle is far off the road");
  assert.deepEqual(ids(selectStops(stations, road, WIDE).candidates), ["beside-road"]);

  const straight = measureStations(stations, { kind: "straight", from: L_START, to: L_END });
  assert.deepEqual(ids(selectStops(stations, straight, WIDE).candidates), ["on-chord", "beside-road"]);
});

test("the break window is 20 km either way along a 100 km road", () => {
  const opts = { maxDetourKm: 25, stopAt: 0.5, windowKm: 20 };
  const at = (progress: number) => ({ detourKm: 1, offRouteKm: 0.5, progress });
  assert.equal(isStop(at(0.3), 100, opts), true);
  assert.equal(isStop(at(0.7), 100, opts), true);
  assert.equal(isStop(at(0.29), 100, opts), false);
  assert.equal(isStop(at(0.71), 100, opts), false);
  // Inside the window but past the detour cap is still out.
  assert.equal(isStop({ detourKm: 26, offRouteKm: 13, progress: 0.5 }, 100, opts), false);
});

test("a trip of two windows or less lists the whole corridor", () => {
  const station = { id: "early", lat: 47, lon: 8 };
  const measured = (routeKm: number): MeasuredStations => ({
    routeKm,
    byId: new Map([["early", { detourKm: 1, offRouteKm: null, progress: 0 }]]),
  });
  const opts = { maxDetourKm: 25, stopAt: 0.5, windowKm: 20 };
  const short = selectStops([station], measured(40), opts);
  assert.equal(short.shortTrip, true);
  assert.deepEqual(ids(short.candidates), ["early"]);
  const long = selectStops([station], measured(40.5), opts);
  assert.equal(long.shortTrip, false);
  assert.deepEqual(ids(long.candidates), []);
  assert.equal(long.corridorCount, 1);
});

/** The trip search exactly as Dashboard ran it before roads, kept here as the reference. */
function straightLineTrip(stations: Place[], from: LatLon, to: LatLon, maxDetour: number, stopAt: number) {
  const STOP_WINDOW_KM = 20;
  const directKm = distanceKm(from, to);
  const detours = new Map<string, number>();
  const progress = new Map<string, number>();
  const candidates: Place[] = [];
  for (const station of stations) {
    const extra = detourKm(from, to, station);
    if (extra > maxDetour) continue;
    detours.set(station.id, extra);
    progress.set(station.id, routeProgress(from, to, station));
    candidates.push(station);
  }
  const shortTrip = directKm <= 2 * STOP_WINDOW_KM;
  const window = STOP_WINDOW_KM / directKm;
  const nearBreak = shortTrip
    ? candidates
    : candidates.filter((s) => Math.abs((progress.get(s.id) ?? 0.5) - stopAt) <= window);
  return { directKm, shortTrip, detours, progress, candidates: nearBreak, corridorCount: candidates.length };
}

test("without a road, stops are exactly what the straight-line search found", () => {
  const zurich = { lat: 47.3769, lon: 8.5417 };
  const lugano = { lat: 46.0037, lon: 8.9511 };
  const stations: Place[] = [
    { id: "zug", lat: 47.1662, lon: 8.5155 },
    { id: "luzern", lat: 47.0502, lon: 8.3093 },
    { id: "schwyz", lat: 47.0207, lon: 8.6541 },
    { id: "altdorf", lat: 46.8804, lon: 8.6444 },
    { id: "goeschenen", lat: 46.667, lon: 8.586 },
    { id: "andermatt", lat: 46.6356, lon: 8.5939 },
    { id: "airolo", lat: 46.5286, lon: 8.6117 },
    { id: "biasca", lat: 46.3593, lon: 8.9707 },
    { id: "bellinzona", lat: 46.193, lon: 9.017 },
    { id: "chur", lat: 46.8508, lon: 9.532 },
    { id: "bern", lat: 46.948, lon: 7.4474 },
    { id: "glarus", lat: 47.0404, lon: 9.068 },
  ];
  const measured = measureStations(stations, { kind: "straight", from: zurich, to: lugano });

  for (const [maxDetour, stopAt] of [[25, 0.5], [10, 0.3], [60, 0.8], [2, 0.5]] as const) {
    const expected = straightLineTrip(stations, zurich, lugano, maxDetour, stopAt);
    const actual = selectStops(stations, measured, { maxDetourKm: maxDetour, stopAt, windowKm: 20 });
    const label = `detour ${maxDetour}, break ${stopAt}`;
    assert.equal(actual.routeKm, expected.directKm, label);
    assert.equal(actual.shortTrip, expected.shortTrip, label);
    assert.deepEqual(ids(actual.candidates), ids(expected.candidates), label);
    assert.deepEqual(actual.detours, expected.detours, label);
    assert.deepEqual(actual.progress, expected.progress, label);
    assert.equal(actual.corridorCount, expected.corridorCount, label);
    assert.equal(actual.offRoute.size, 0, label);
  }
});

test("exact road detours replace the estimates they cover, and one over the cap drops out", () => {
  const stations: Place[] = [
    { id: "measured", lat: 47, lon: 8 },
    { id: "estimated", lat: 47, lon: 8 },
    { id: "far-by-road", lat: 47, lon: 8 },
  ];
  const measure = (detourKm: number) => ({ detourKm, offRouteKm: detourKm / 2, progress: 0.5 });
  const measured: MeasuredStations = {
    routeKm: 100,
    byId: new Map([
      ["measured", measure(2)],
      ["estimated", measure(4)],
      ["far-by-road", measure(6)],
    ]),
  };
  const selection = selectStops(stations, measured, { maxDetourKm: 25, stopAt: 0.5, windowKm: 20 });
  const exact = new Map([
    ["measured", 3.5],
    // Across the motorway from its service area: close as the crow flies, far by car.
    ["far-by-road", 31],
  ]);

  const merged = mergeDetours(selection, exact, 25);
  assert.deepEqual(ids(merged.candidates), ["measured", "estimated"]);
  assert.deepEqual([...merged.detours], [["measured", 3.5], ["estimated", 4]]);
  assert.deepEqual([...merged.detourBasis], [["measured", "road"], ["estimated", "est"]]);
  for (const map of [merged.detours, merged.progress, merged.offRoute, merged.detourBasis]) {
    assert.equal(map.has("far-by-road"), false);
  }
  assert.equal(merged.corridorCount, 2);
  // The selection it came from is left as it was.
  assert.equal(selection.detours.get("measured"), 2);
});
