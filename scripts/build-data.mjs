/**
 * Fetches real Swiss charging infrastructure (BFE / ich-tanke-strom) and the
 * OpenStreetMap surroundings (food, green space, parking terms), and writes
 * the static file the app loads first. The same pipeline serves the live
 * refresh route; this script adds a disk cache and the patience to wait out
 * Overpass rate limits.
 *
 * Run: npm run build:data
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FOOD_RADIUS_M, GREEN_RADIUS_M } from "../src/server/pipeline/attach.ts";
import { enrich } from "../src/server/pipeline/enrich.ts";
import { EVSE_URL, buildSites, parseFeed, publishSite } from "../src/server/pipeline/feed.ts";
import { cellBboxes } from "../src/server/pipeline/geo.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../public/stations.json");

/**
 * On-disk response cache.
 *
 * Both upstreams are shared public infrastructure: the federal feed is ~25 MB
 * per pull and the free Overpass instances rate-limit aggressively (429) and
 * ban repeat offenders. Every response is cached so re-runs, partial failures
 * and iteration cost nothing upstream — a run that dies on batch 12 of 19
 * replays the first 11 from disk instead of asking again.
 *
 *   npm run build:data                 use cache when fresh (default, 24h)
 *   CACHE_TTL_HOURS=0 npm run …        treat cache as always stale
 *   NO_CACHE=1 npm run …               bypass reads, still writes
 */
const CACHE_DIR = resolve(HERE, "../.cache/build-data");
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_HOURS ?? 24) * 60 * 60 * 1000;
const NO_CACHE = process.env.NO_CACHE === "1" || process.argv.includes("--no-cache");

const cacheFile = (key) => resolve(CACHE_DIR, createHash("sha1").update(key).digest("hex"));

function cacheRead(key) {
  if (NO_CACHE) return null;
  const base = cacheFile(key);
  try {
    if (!existsSync(`${base}.meta.json`)) return null;
    const meta = JSON.parse(readFileSync(`${base}.meta.json`, "utf8"));
    if (CACHE_TTL_MS <= 0) return null;
    if (Date.now() - meta.storedAt > CACHE_TTL_MS) return null;
    return readFileSync(`${base}.bin`);
  } catch {
    return null; // A corrupt or half-written entry is simply a miss.
  }
}

function cacheWrite(key, buffer, label) {
  const base = cacheFile(key);
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(`${base}.bin`, buffer);
    writeFileSync(
      `${base}.meta.json`,
      JSON.stringify({ label, storedAt: Date.now(), bytes: buffer.length }, null, 1),
    );
  } catch (error) {
    console.warn(`  (cache write failed: ${error.message})`);
  }
}

const overpassCache = {
  read: (key) => cacheRead(key)?.toString("utf8") ?? null,
  write: (key, text, label) => cacheWrite(key, Buffer.from(text), label),
};

const flag = (env, arg) => process.env[env] === "1" || process.argv.includes(arg);
const SKIP_FOOD = flag("SKIP_FOOD", "--no-food");
const SKIP_GREEN = flag("SKIP_GREEN", "--no-green");
const SKIP_PARKING = flag("SKIP_PARKING", "--no-parking");
const OVERPASS_ENDPOINTS = process.env.OVERPASS_ENDPOINTS?.split(",")
  .map((url) => url.trim())
  .filter(Boolean);

async function fetchEvseData() {
  process.stdout.write("Fetching federal EVSE feed… ");
  let buf = cacheRead(EVSE_URL);
  if (buf) {
    process.stdout.write("(cached) ");
  } else {
    const res = await fetch(EVSE_URL);
    if (!res.ok) throw new Error(`EVSE feed returned ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
    cacheWrite(EVSE_URL, buf, "BFE EVSE feed");
  }
  const records = parseFeed(buf);
  console.log(`${records.length} charging points`);
  return records;
}

async function main() {
  const records = await fetchEvseData();
  const sites = buildSites(records);

  const places = new Set(sites.map((site) => site.city)).size;
  console.log(
    `Grouped into ${sites.length} sites across ${places} places, ${cellBboxes(sites).length} map cells`,
  );

  const result = await enrich(sites, {
    food: !SKIP_FOOD,
    green: !SKIP_GREEN,
    parking: !SKIP_PARKING,
    parkingScope: "country",
    overpass: { endpoints: OVERPASS_ENDPOINTS, cache: overpassCache },
    log: (message) => process.stdout.write(message),
  });
  for (const error of result.errors) {
    console.log(`  Stations written without ${error.split(":")[0]} data — re-run to backfill.`);
  }

  const payload = {
    foodAvailable: result.foodAvailable,
    greenAvailable: result.greenAvailable,
    generatedAt: new Date().toISOString(),
    source: {
      stations: "Swiss Federal Office of Energy (BFE) / ich-tanke-strom, via data.geo.admin.ch",
      food: "OpenStreetMap contributors, via Overpass API (ODbL)",
      green: "OpenStreetMap contributors, via Overpass API (ODbL)",
      parking: "OpenStreetMap contributors, via Overpass API (ODbL)",
      pricing: "Operators' published ad-hoc tariffs (src/data/tariffs.ts); national default where none is published",
    },
    foodRadiusMetres: FOOD_RADIUS_M,
    greenRadiusMetres: GREEN_RADIUS_M,
    stations: sites
      .map(publishSite)
      .sort((a, b) => a.city.localeCompare(b.city) || a.name.localeCompare(b.name)),
  };

  mkdirSync(dirname(OUT), { recursive: true });
  // Written minified: this is machine-read, and the indentation alone cost
  // 79 KB gzipped over the wire.
  const json = JSON.stringify(payload);
  writeFileSync(OUT, json);
  const kb = Math.round(json.length / 1024);
  console.log(`\nWrote ${payload.stations.length} stations to ${OUT} (${kb} KB)`);
}

main().catch((error) => {
  console.error("\nBuild failed:", error.message);
  process.exit(1);
});
