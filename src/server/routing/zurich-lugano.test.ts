import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { distanceKm } from "../../lib/geo.ts";
import { indexRoute, projectOntoRoute } from "../../lib/route.ts";
import type { LatLon } from "../../lib/types.ts";
import { parseOsrmRoute } from "./osrm.ts";

/** The real road over the Gotthard, recorded by scripts/record-route-fixture.mjs. */
const route = parseOsrmRoute(
  JSON.parse(readFileSync(new URL("./fixtures/zurich-lugano.osrm.json", import.meta.url), "utf8")),
);
const index = indexRoute(route);

const progress = (place: LatLon) => projectOntoRoute(index, place).alongKm / index.totalKm;

test("the recorded route is the 206 km the router measures", () => {
  assert.ok(Math.abs(route.distanceKm - 205.6) <= 1, `${route.distanceKm} km`);
});

test("the thinned line is still nearly as long as the road", () => {
  let length = 0;
  route.line.forEach((point, i) => {
    const previous = route.line[i - 1];
    if (previous) length += distanceKm(previous, point);
  });
  const shortfall = Math.abs(length - route.distanceKm) / route.distanceKm;
  assert.ok(shortfall < 0.03, `line ${length.toFixed(1)} km, road ${route.distanceKm} km`);
});

test("Göschenen, at the tunnel portal, is on the road and near halfway", () => {
  const goeschenen = { lat: 46.667, lon: 8.586 };
  const { offKm } = projectOntoRoute(index, goeschenen);
  assert.ok(offKm < 2, `${offKm.toFixed(2)} km off`);
  const along = progress(goeschenen);
  assert.ok(along > 0.35 && along < 0.65, `progress ${along.toFixed(3)}`);
});

test("Bellinzona comes late on the way and Zürich HB right at the start", () => {
  const bellinzona = progress({ lat: 46.193, lon: 9.017 });
  assert.ok(bellinzona > 0.8, `Bellinzona at ${bellinzona.toFixed(3)}`);
  const zurichHb = progress({ lat: 47.378, lon: 8.54 });
  assert.ok(zurichHb < 0.05, `Zürich HB at ${zurichHb.toFixed(3)}`);
});
