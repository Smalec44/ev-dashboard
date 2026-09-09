import assert from "node:assert/strict";
import { test } from "node:test";
import { applyRefresh, scopeFromParams, scopeToParams, type RefreshScope } from "./refresh.ts";
import type { ChargingStation } from "./types.ts";

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
  assert.equal(next[0].foodCount, 1);
  assert.equal(next[0].food[0].name, "Café");
  // Green did succeed, so its fresh (empty) answer stands.
  assert.equal(next[0].greenScore, null);
  assert.deepEqual(next[0].parking, { free: true });
});

test("scope parameters round-trip and reject nonsense", () => {
  assert.deepEqual(scopeFromParams(scopeToParams(zurich)), zurich);
  const trip: RefreshScope = { mode: "trip", from: { lat: 47.37, lon: 8.54 }, to: { lat: 46.0, lon: 8.95 }, maxDetourKm: 25 };
  assert.deepEqual(scopeFromParams(scopeToParams(trip)), trip);
  assert.equal(scopeFromParams(new URLSearchParams("mode=region&lat=47&lon=8")), null);
  assert.equal(scopeFromParams(new URLSearchParams("mode=region&lat=47&lon=8&radiusKm=500")), null);
  assert.equal(scopeFromParams(new URLSearchParams("mode=region&lat=0&lon=0&radiusKm=5")), null);
});
