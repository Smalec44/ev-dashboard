import assert from "node:assert/strict";
import { test } from "node:test";
import { distanceKm } from "./geo.ts";
import {
  applyRefresh,
  inScope,
  scopeFromParams,
  scopeToParams,
  type RefreshResponse,
  type RefreshScope,
} from "./refresh.ts";
import { indexRoute } from "./route.ts";
import type { ChargingStation } from "./types.ts";

/** Element at `index`, failing the test loudly rather than typing as undefined. */
function at<T>(list: T[], index: number): T {
  const item = list[index];
  assert.ok(item !== undefined, `no element at ${index}`);
  return item;
}

function station(id: string, lat: number, lon: number, extra: Partial<ChargingStation> = {}): ChargingStation {
  return {
    id,
    lat,
    lon,
    name: id,
    operator: "Someone",
    city: "Somewhere",
    canton: "ZH",
    address: "Somewhere",
    connectorType: "AC",
    maxPowerKw: 22,
    stalls: 2,
    pricePerKwh: 0.45,
    food: [],
    ...extra,
  };
}

const zurich: RefreshScope = { mode: "region", city: "Zürich", lat: 47.3769, lon: 8.5417, radiusKm: 5 };

const ok = { foodAvailable: true, greenAvailable: true, parkingAvailable: true, errors: [] };

test("a refresh replaces the stations inside the scope and leaves the rest alone", () => {
  const inside = station("in", 47.38, 8.54, { stalls: 2 });
  const gone = station("gone", 47.39, 8.55);
  const far = station("far", 46.0, 8.95);
  const fresh = station("in", 47.38, 8.54, { stalls: 4 });
  const brandNew = station("new", 47.37, 8.53);

  const next = applyRefresh([inside, gone, far], { ...ok, refreshedAt: "t", stations: [fresh, brandNew] }, zurich);
  const ids = next.map((s) => s.id).sort();
  assert.deepEqual(ids, ["far", "in", "new"]);
  assert.equal(next.find((s) => s.id === "in")?.stalls, 4);
});

test("a station labelled with the town is in scope however far out it sits", () => {
  const labelled = station("labelled", 47.6, 8.9, { city: "Zürich" });
  const next = applyRefresh([labelled], { ...ok, refreshedAt: "t", stations: [] }, zurich);
  assert.deepEqual(next, []);
});

test("when an OpenStreetMap pass failed, that facet is kept from before", () => {
  const before = station("in", 47.38, 8.54, {
    food: [{ name: "Café", cuisine: null, walkingMinutes: 3 }],
    foodCount: 1,
    greenScore: 70,
    green: [{ name: null, category: "park", distanceMetres: 50 }],
    parking: { free: true },
  });
  const fresh = station("in", 47.38, 8.54, { food: [], foodCount: null, green: [], greenScore: null });
  const next = applyRefresh(
    [before],
    { refreshedAt: "t", stations: [fresh], foodAvailable: false, greenAvailable: true, parkingAvailable: false, errors: ["food: 504", "parking: 504"] },
    zurich,
  );
  const merged = at(next, 0);
  assert.equal(merged.foodCount, 1);
  assert.equal(at(merged.food, 0).name, "Café");
  // Green did succeed, so its fresh (empty) answer stands.
  assert.equal(merged.greenScore, null);
  assert.deepEqual(merged.parking, { free: true });
});

test("scope parameters round-trip and reject nonsense", () => {
  assert.deepEqual(scopeFromParams(scopeToParams(zurich)), zurich);
  const trip: RefreshScope = {
    mode: "trip",
    from: { lat: 47.37, lon: 8.54 },
    to: { lat: 46.0, lon: 8.95 },
    maxDetourKm: 25,
    stopAt: 0.4,
    windowKm: 30,
    basis: "straight",
  };
  assert.deepEqual(scopeFromParams(scopeToParams(trip)), trip);
  assert.equal(scopeFromParams(new URLSearchParams("mode=region&lat=47&lon=8")), null);
  assert.equal(scopeFromParams(new URLSearchParams("mode=region&lat=47&lon=8&radiusKm=500")), null);
  assert.equal(scopeFromParams(new URLSearchParams("mode=region&lat=0&lon=0&radiusKm=5")), null);

  const tripParams = (overrides: Record<string, string>) => {
    const params = scopeToParams(trip);
    for (const [key, value] of Object.entries(overrides)) params.set(key, value);
    return params;
  };
  const withoutWindow = scopeToParams(trip);
  withoutWindow.delete("windowKm");
  assert.equal(scopeFromParams(withoutWindow), null);
  assert.equal(scopeFromParams(tripParams({ stopAt: "1.5" })), null);
  assert.equal(scopeFromParams(tripParams({ stopAt: "-0.1" })), null);
  assert.equal(scopeFromParams(tripParams({ windowKm: "0" })), null);
  assert.equal(scopeFromParams(tripParams({ windowKm: "61" })), null);
});

test("a trip refresh covers only the break window along the corridor", () => {
  // Geneva → St. Gallen, about 280 km on the direct line; the break is set near Bern.
  const trip: RefreshScope = {
    mode: "trip",
    from: { lat: 46.2044, lon: 6.1432 },
    to: { lat: 47.4245, lon: 9.3767 },
    maxDetourKm: 15,
    stopAt: 0.45,
    windowKm: 25,
    basis: "straight",
  };
  // Bern: on the corridor and within a couple of km of the break.
  assert.equal(inScope(trip, { lat: 46.95, lon: 7.45 }), true);
  // Zürich: on the corridor, but over 90 km past the break.
  assert.equal(inScope(trip, { lat: 47.38, lon: 8.54 }), false);
  // Biel: level with the break along the route, but 16 km off the line — the detour cap still applies.
  assert.equal(inScope(trip, { lat: 47.14, lon: 7.25 }), false);
});

/**
 * An L-shaped road: 0.5° north, then 0.66° east. The chord between its ends
 * cuts the corner, so the chord's middle is far from the road and the corner
 * is far from the chord.
 */
const L_START = { lat: 46.5, lon: 7 };
const L_CORNER = { lat: 47, lon: 7 };
const L_END = { lat: 47, lon: 7.66 };
const L_ROAD = indexRoute({
  distanceKm: distanceKm(L_START, L_CORNER) + distanceKm(L_CORNER, L_END),
  line: [L_START, L_CORNER, L_END],
});
const lTrip = (basis: "road" | "straight"): RefreshScope => ({
  mode: "trip",
  from: L_START,
  to: L_END,
  maxDetourKm: 25,
  stopAt: 0.5,
  windowKm: 20,
  basis,
});
/** The middle of the chord: some 25 km from the road. */
const ON_CHORD = { lat: 46.75, lon: 7.33 };
/** Just inside the corner: on the road, but nearly 30 km of detour off the chord. */
const AT_CORNER = { lat: 46.99, lon: 7.01 };

/** The basis a trip query parses to, or null for anything else. */
function basisOf(params: URLSearchParams) {
  const scope = scopeFromParams(params);
  return scope?.mode === "trip" ? scope.basis : null;
}

test("a trip scope carries its basis, and a request without one means the straight line", () => {
  assert.deepEqual(scopeFromParams(scopeToParams(lTrip("road"))), lTrip("road"));
  const fromOldClient = scopeToParams(lTrip("road"));
  fromOldClient.delete("basis");
  assert.equal(basisOf(fromOldClient), "straight");
  const odd = scopeToParams(lTrip("road"));
  odd.set("basis", "sideways");
  assert.equal(basisOf(odd), "straight");
});

test("with the road, a trip's scope is the road corridor, not the chord's", () => {
  assert.equal(inScope(lTrip("road"), ON_CHORD, L_ROAD), false);
  assert.equal(inScope(lTrip("road"), AT_CORNER, L_ROAD), true);
  // The straight line has it the other way round.
  assert.equal(inScope(lTrip("straight"), ON_CHORD), true);
  assert.equal(inScope(lTrip("straight"), AT_CORNER), false);
});

/** Off the road but on the chord; on the road near the corner, refreshed; on the road, gone from the feed. */
const offRoad = station("off-road", ON_CHORD.lat, ON_CHORD.lon);
const onRoad = station("on-road", AT_CORNER.lat, AT_CORNER.lon, { stalls: 2 });
const vanished = station("vanished", 46.98, 7);
const refreshed = station("on-road", AT_CORNER.lat, AT_CORNER.lon, { stalls: 6 });

test("a road refresh replaces the road corridor and keeps what lies off it", () => {
  const response: RefreshResponse = { ...ok, refreshedAt: "t", stations: [refreshed], routeBasis: "road" };
  const next = applyRefresh([offRoad, onRoad, vanished], response, lTrip("road"), L_ROAD);
  assert.deepEqual(next.map((s) => s.id).sort(), ["off-road", "on-road"]);
  assert.equal(next.find((s) => s.id === "on-road")?.stalls, 6);
});

test("unless the server followed the road too, the client's road is ignored", () => {
  const current = [offRoad, onRoad, vanished];
  for (const routeBasis of [undefined, "straight"] as const) {
    const response: RefreshResponse = {
      ...ok,
      refreshedAt: "t",
      stations: [refreshed],
      ...(routeBasis && { routeBasis }),
    };
    const next = applyRefresh(current, response, lTrip("road"), L_ROAD);
    assert.deepEqual(next, applyRefresh(current, response, lTrip("road")), `routeBasis ${routeBasis}`);
    // The straight corridor was rebuilt: the chord's station went with it, the corner's stayed.
    assert.deepEqual(next.map((s) => s.id).sort(), ["on-road", "vanished"], `routeBasis ${routeBasis}`);
  }
});
