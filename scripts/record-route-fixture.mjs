/**
 * Records one real road route for the routing tests: Zürich → Lugano, over
 * the Gotthard, as the FOSSGIS router answers it. The tests project Swiss
 * towns onto it without touching the network, which the pre-commit gate
 * forbids; this script is the only thing that calls out, and only when run.
 *
 * Run once, and commit the result:
 *   node --import ./scripts/resolve-alias.mjs scripts/record-route-fixture.mjs
 *
 * Only what parseOsrmRoute reads is kept, with coordinates rounded to five
 * decimals (about a metre), so the file stays small and diffs stay quiet.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { USER_AGENT } from "../src/server/http.ts";
import { DEFAULT_ROUTING_URL } from "../src/server/routing/osrm.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../src/server/routing/fixtures/zurich-lugano.osrm.json");

const ZURICH = { lat: 47.3769, lon: 8.5417 };
const LUGANO = { lat: 46.0037, lon: 8.9511 };

const round = (value) => Math.round(value * 1e5) / 1e5;

async function main() {
  const coordinates = `${ZURICH.lon},${ZURICH.lat};${LUGANO.lon},${LUGANO.lat}`;
  const url = `${DEFAULT_ROUTING_URL}/route/v1/driving/${coordinates}?overview=full&geometries=geojson`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`router returned ${res.status}`);
  const body = await res.json();
  const route = body.routes?.[0];
  if (body.code !== "Ok" || !route) throw new Error(`router answered ${body.code ?? "no code"}`);

  const fixture = {
    code: body.code,
    routes: [
      {
        distance: route.distance,
        duration: route.duration,
        geometry: {
          type: route.geometry.type,
          coordinates: route.geometry.coordinates.map(([lon, lat]) => [round(lon), round(lat)]),
        },
      },
    ],
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(fixture)}\n`);
  console.log(
    `Wrote ${fixture.routes[0].geometry.coordinates.length} points, ` +
      `${(route.distance / 1000).toFixed(1)} km, ${Math.round(route.duration / 60)} min to ${OUT}`,
  );
}

main().catch((error) => {
  console.error("Recording failed:", error.message);
  process.exit(1);
});
