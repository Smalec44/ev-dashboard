import { test } from "node:test";
import assert from "node:assert/strict";
import { CURATED_STATIONS, mergeStations } from "./stations.ts";
import type { ChargingStation } from "@/lib/types";

/** A feed-shaped record at a given point; only position and city matter here. */
function feedStation(
  lat: number,
  lon: number,
  city: string,
): ChargingStation {
  return {
    id: `feed-${lat}-${lon}`,
    lat,
    lon,
    name: "Feed site",
    operator: "Someone",
    city,
    canton: "ZH",
    address: "Somewhere",
    connectorType: "DC",
    maxPowerKw: 150,
    stalls: 4,
    pricePerKwh: 0.5,
    food: [],
  };
}

const anchor = CURATED_STATIONS[0];

test("a feed record on top of a curated one is dropped", () => {
  const merged = mergeStations([feedStation(anchor.lat, anchor.lon, anchor.city)]);
  assert.equal(merged.length, CURATED_STATIONS.length);
});

test("the duplicate is dropped even when the two spell the city differently", () => {
  // The regression this guards: dedupe used to require the city strings to
  // match, so an operator writing "Zurich" (or the municipality, or nothing
  // recognisable) put a second pin on a site already covered.
  const merged = mergeStations([
    feedStation(anchor.lat, anchor.lon, "Some Other Spelling"),
  ]);
  assert.equal(merged.length, CURATED_STATIONS.length);
});

test("a genuinely different site nearby is kept", () => {
  // ~1.1 km north: well outside the 200 m dedupe radius.
  const merged = mergeStations([
    feedStation(anchor.lat + 0.01, anchor.lon, anchor.city),
  ]);
  assert.equal(merged.length, CURATED_STATIONS.length + 1);
});
