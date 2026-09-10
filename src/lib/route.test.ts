import assert from "node:assert/strict";
import { test } from "node:test";
import { distanceKm } from "./geo.ts";
import { indexRoute, lineUpTo, parseRouteQuery, pointAlong, projectOntoRoute, routeQuery } from "./route.ts";
import type { LatLon } from "./types.ts";

const zurich = { lat: 47.3769, lon: 8.5417 };
const lugano = { lat: 46.0037, lon: 8.9511 };

/** The Zürich → Lugano query with one parameter changed, or removed when `value` is null. */
function tweaked(key: string, value: string | null): URLSearchParams {
  const params = routeQuery(zurich, lugano);
  if (value === null) params.delete(key);
  else params.set(key, value);
  return params;
}

function near(actual: number, expected: number, tolerance: number, what: string) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${what}: ${actual.toFixed(4)}, expected ${expected.toFixed(4)} ± ${tolerance}`,
  );
}

test("route endpoints round-trip through the query string", () => {
  assert.deepEqual(parseRouteQuery(routeQuery(zurich, lugano)), { from: zurich, to: lugano });
});

test("route endpoints refuse anything missing, malformed, abroad or degenerate", () => {
  assert.equal(parseRouteQuery(tweaked("toLon", null)), null);
  assert.equal(parseRouteQuery(tweaked("fromLat", "NaN")), null);
  assert.equal(parseRouteQuery(tweaked("fromLat", "")), null);
  // Latitude 0 is the Gulf of Guinea, not a Swiss town.
  assert.equal(parseRouteQuery(tweaked("fromLat", "0")), null);
  assert.equal(parseRouteQuery(routeQuery(zurich, zurich)), null);
});

/** Two legs: 0.1° north (about 11.1 km), then 0.15° east (about 11.3 km). */
const START = { lat: 47, lon: 8 };
const CORNER = { lat: 47.1, lon: 8 };
const END = { lat: 47.1, lon: 8.15 };
const LINE: LatLon[] = [START, CORNER, END];
const FIRST_LEG = distanceKm(START, CORNER);
const SECOND_LEG = distanceKm(CORNER, END);
const LENGTH = FIRST_LEG + SECOND_LEG;

test("a point beside a leg is measured from where it meets the road", () => {
  const index = indexRoute({ distanceKm: LENGTH, line: LINE });

  const besideFirst = { lat: 47.05, lon: 8.01 };
  const first = projectOntoRoute(index, besideFirst);
  near(first.alongKm, FIRST_LEG / 2, 0.05, "along the first leg");
  near(first.offKm, distanceKm(besideFirst, { lat: 47.05, lon: 8 }), 0.05, "off the first leg");

  const besideSecond = { lat: 47.11, lon: 8.075 };
  const second = projectOntoRoute(index, besideSecond);
  near(second.alongKm, FIRST_LEG + SECOND_LEG / 2, 0.05, "along the second leg");
  near(second.offKm, distanceKm(besideSecond, { lat: 47.1, lon: 8.075 }), 0.05, "off the second leg");
});

test("a point beyond either end of the road is measured from that end", () => {
  const index = indexRoute({ distanceKm: LENGTH, line: LINE });
  const before = projectOntoRoute(index, { lat: 46.95, lon: 8 });
  assert.equal(before.alongKm, 0);
  near(before.offKm, distanceKm({ lat: 46.95, lon: 8 }, START), 0.05, "off the start");
  assert.equal(projectOntoRoute(index, { lat: 47.1, lon: 8.3 }).alongKm, index.totalKm);
});

test("halfway along is half the road's km, wherever the corner falls", () => {
  const index = indexRoute({ distanceKm: LENGTH, line: LINE });
  const half = pointAlong(index, 0.5);
  // The first leg is the shorter, so halfway is just past the corner, heading east.
  near(half.lat, 47.1, 1e-9, "halfway latitude");
  near(distanceKm(CORNER, half), LENGTH / 2 - FIRST_LEG, 0.01, "halfway past the corner");
  near(projectOntoRoute(index, half).alongKm, LENGTH / 2, 0.01, "halfway projected back");
  assert.deepEqual(pointAlong(index, -1), START);
  assert.deepEqual(pointAlong(index, 2), END);
});

test("the road up to a fraction keeps its corners and ends where pointAlong does", () => {
  const index = indexRoute({ distanceKm: LENGTH, line: LINE });
  // Halfway is past the corner, so the corner stays and the cut is interpolated.
  assert.deepEqual(lineUpTo(index, 0.5), [START, CORNER, pointAlong(index, 0.5)]);
  assert.deepEqual(lineUpTo(index, 1), LINE);
  assert.deepEqual(lineUpTo(index, 0), [START]);
});

test("the km along the line are stretched to the router's distance, exactly", () => {
  const index = indexRoute({ distanceKm: 30, line: LINE });
  assert.equal(index.totalKm, 30);
  assert.equal(index.cumKm.at(-1), 30);
  near(index.cumKm[1] ?? NaN, (FIRST_LEG * 30) / LENGTH, 1e-9, "corner km");
  const { alongKm } = projectOntoRoute(index, { lat: 47.05, lon: 8.01 });
  near(alongKm, (FIRST_LEG / 2) * (30 / LENGTH), 0.05, "scaled along");
});
