import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { StationFeed } from "./stations.ts";

/**
 * The committed data file is an input like any other, and a bad build of it
 * (a failed feed pull writing 40 stations, a coordinate parser regression)
 * would ship silently: the app renders whatever is there. These are the
 * invariants a good build always meets.
 */
const feed = JSON.parse(
  readFileSync(new URL("../../public/stations.json", import.meta.url), "utf8"),
) as StationFeed;

test("the station file holds the whole country, not a partial pull", () => {
  assert.ok(feed.stations.length > 7_500, `only ${feed.stations.length} stations`);
  assert.ok(Number.isFinite(Date.parse(feed.generatedAt)), "generatedAt is not a date");
});

test("every station has a Swiss coordinate and a unique id", () => {
  const ids = new Set<string>();
  for (const station of feed.stations) {
    assert.ok(
      station.lat > 45.5 && station.lat < 48 && station.lon > 5.5 && station.lon < 11,
      `${station.id} sits at ${station.lat},${station.lon}`,
    );
    assert.ok(!ids.has(station.id), `duplicate id ${station.id}`);
    ids.add(station.id);
  }
});

test("the enrichment passes actually ran", () => {
  const withFood = feed.stations.filter((s) => (s.foodCount ?? 0) > 0).length;
  const withGreen = feed.stations.filter((s) => (s.greenScore ?? 0) > 0).length;
  assert.ok(withFood / feed.stations.length > 0.5, `food on ${withFood} stations only`);
  assert.ok(withGreen / feed.stations.length > 0.5, `green on ${withGreen} stations only`);
});
