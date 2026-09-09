/**
 * Fetches real Swiss charging infrastructure (BFE / ich-tanke-strom) and nearby
 * food POIs (OpenStreetMap), and writes a static cache the app imports.
 *
 * Run: npm run build:data
 */
import { gunzipSync } from "node:zlib";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../public/stations.json");

const EVSE_URL =
  "https://data.geo.admin.ch/ch.bfe.ladestellen-elektromobilitaet/data/oicp/ch.bfe.ladestellen-elektromobilitaet.json";

// Override with a comma-separated list to use your own instance — the public
// ones are heavily rate-limited and will block a host that keeps retrying.
const OVERPASS_ENDPOINTS = (
  process.env.OVERPASS_ENDPOINTS ??
  [
    // Swiss OSM instance first: closest to this data set and reliably up when
    // the big generic mirrors are saturated (they answer 504 under load).
    "https://overpass.osm.ch/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
  ].join(",")
)
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);

// Derived from REGIONS in src/data/regions.ts rather than duplicated, so the
// set of cities we pull stations for cannot drift from the set the UI can search.
const REGIONS_TS = resolve(HERE, "../src/data/regions.ts");
const CITY_LOOKUP = new Map();
{
  // Operators write whatever city name they like into the feed — often the
  // German exonym ("Sitten" for Sion). Aliases are accepted as feed keys and
  // normalised to the region's canonical name, so both spellings land together.
  const norm = (v) => v.toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g, "");
  const line =
    /\{ slug: "[^"]+", city: "([^"]+)", canton: "([A-Z]{2})", aliases: \[([^\]]*)\]/g;
  for (const m of readFileSync(REGIONS_TS, "utf8").matchAll(line)) {
    const [, city, canton, rawAliases] = m;
    const keys = [city, ...(rawAliases.match(/"((?:[^"\\]|\\.)*)"/g) ?? []).map((a) => JSON.parse(a))];
    for (const key of keys) {
      // First writer wins: REGIONS is population-ordered, so shared names
      // (Wohlen AG/BE, Buchs SG/AG) resolve to the larger city.
      if (!CITY_LOOKUP.has(norm(key))) CITY_LOOKUP.set(norm(key), { city, canton });
    }
  }
  if (CITY_LOOKUP.size === 0) {
    throw new Error(`No cities parsed from ${REGIONS_TS} — has its format changed?`);
  }
}

const lookupCity = (name) =>
  CITY_LOOKUP.get(name.toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g, ""));

/**
 * On-disk response cache.
 *
 * Both upstreams are shared public infrastructure: the federal feed is ~20 MB
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
const CACHE_TTL_MS =
  Number(process.env.CACHE_TTL_HOURS ?? 24) * 60 * 60 * 1000;
const NO_CACHE =
  process.env.NO_CACHE === "1" || process.argv.includes("--no-cache");

const cacheFile = (key) =>
  resolve(CACHE_DIR, createHash("sha1").update(key).digest("hex"));

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

/** Seconds to wait per a 429/503 Retry-After header, capped so we never hang. */
function retryAfterMs(res) {
  const raw = res.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.min(seconds, 120) * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.min(Math.max(at - Date.now(), 0), 120_000) : null;
}

// The federal feed carries no tariffs, so prices are per-operator estimates.
const TARIFFS = {
  Move: { AC: 0.45, DC: 0.65 },
  eCarUp: { AC: 0.4, DC: 0.6 },
  Fastned: { AC: 0.49, DC: 0.65 },
  "PLUG N ROLL": { AC: 0.45, DC: 0.65 },
  evpass: { AC: 0.45, DC: 0.68 },
  "M-Charge": { AC: 0.42, DC: 0.6 },
  Tesla: { AC: 0.4, DC: 0.55 },
  Chargepoint: { AC: 0.42, DC: 0.62 },
  "Shell Recharge": { AC: 0.49, DC: 0.71 },
  GoFast: { AC: 0.45, DC: 0.64 },
  Electra: { AC: 0.45, DC: 0.59 },
  Autosense: { AC: 0.45, DC: 0.66 },
  Agrola: { AC: 0.44, DC: 0.63 },
  "Lidl Schweiz AG": { AC: 0.35, DC: 0.55 },
  "Energie 360 Grad AG": { AC: 0.39, DC: 0.62 },
  "swisscharge.ch AG": { AC: 0.44, DC: 0.66 },
  "IWB Industrielle Werke Basel": { AC: 0.38, DC: 0.6 },
  "Elektrizitätswerk der Stadt Zürich": { AC: 0.4, DC: 0.62 },
};
const DEFAULT_TARIFF = { AC: 0.45, DC: 0.65 };

const SKIP_FOOD = process.env.SKIP_FOOD === "1" || process.argv.includes("--no-food");

const OVERPASS_ROUNDS = 4;
const OVERPASS_BACKOFF_MS = 20_000;

const SKIP_GREEN = process.env.SKIP_GREEN === "1" || process.argv.includes("--no-green");

/**
 * How much each kind of green space is worth to someone waiting at a charger.
 * A park you can sit in is not a road verge, and OSM tags both as "green" —
 * landuse=grass alone outnumbers parks nine to one in Zürich, so weighting is
 * what keeps the score from saying every motorway junction is leafy.
 */
const GREEN_WEIGHTS = {
  "leisure=park": 1,
  "leisure=nature_reserve": 1,
  "leisure=common": 0.8,
  "leisure=garden": 0.7,
  "landuse=forest": 1,
  "natural=wood": 1,
  "natural=beach": 1,
  "landuse=village_green": 0.9,
  "natural=water": 0.9,
  "landuse=meadow": 0.7,
  "natural=grassland": 0.7,
  "natural=heath": 0.6,
  "landuse=orchard": 0.6,
  "landuse=vineyard": 0.5,
  "landuse=allotments": 0.5,
  "natural=scrub": 0.4,
  "landuse=grass": 0.3,
};

const GREEN_RADIUS_M = 400;
/**
 * Green areas are ways, so Overpass returns a bounding box rather than a shape
 * and distance is measured to the box edge. That is accurate because the boxes
 * are small — 90% have a diagonal under 230 m, well inside the search radius.
 * The handful above this cap are sprawling multi-valley relations (and one way
 * with a corrupt -91 latitude), where the box says nothing useful about where
 * the trees actually are, so they are dropped rather than trusted.
 */
const GREEN_MAX_DIAGONAL_KM = 2;
const MAX_GREEN_PER_STATION = 3;
/** Denser than food by an order of magnitude, so fewer boxes per request. */
const GREEN_BBOX_BATCH = 10;

const FOOD_RADIUS_M = 400;
const MAX_FOOD_PER_STATION = 6;
const WALK_METRES_PER_MINUTE = 80;
const BBOX_PAD_DEG = 0.012;

function haversineMetres(a, b) {
  const R = 6_371_000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Switzerland with a margin wide enough for border sites. The feed carries
 * sentinel coordinates on a small number of records — 45 sit at (50, -15) in
 * the Atlantic and 7 in Malta, all with real Swiss addresses — and a station
 * that claims to be 1,367 km from its own city ruins any distance ranking it
 * lands in, besides drawing its food and greenery from the wrong continent.
 */
const CH_BOUNDS = { minLat: 45.5, maxLat: 48.0, minLon: 5.5, maxLon: 11.0 };

function parseCoords(record) {
  const raw = record.GeoCoordinates?.Google;
  if (!raw) return null;
  const [lat, lon] = raw.trim().split(/\s+/).map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (
    lat < CH_BOUNDS.minLat || lat > CH_BOUNDS.maxLat ||
    lon < CH_BOUNDS.minLon || lon > CH_BOUNDS.maxLon
  ) {
    return null;
  }
  return { lat, lon };
}

function stationName(record) {
  // The feed returns either an array of localised names or a single object.
  const raw = record.ChargingStationNames;
  const names = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const preferred =
    names.find((n) => n.lang === "de") ??
    names.find((n) => n.lang === "en") ??
    names[0];
  const value = preferred?.value?.trim();
  return value || record.Address?.Street?.trim() || "Charging station";
}

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
  // Served gzipped despite the .json extension.
  const text =
    buf[0] === 0x1f && buf[1] === 0x8b
      ? gunzipSync(buf).toString("utf8")
      : buf.toString("utf8");
  const json = JSON.parse(text);
  const records = json.EVSEData.flatMap((block) =>
    (block.EVSEDataRecord ?? []).map((r) => ({
      ...r,
      operator: block.OperatorName,
    })),
  );
  console.log(`${records.length} charging points`);
  return records;
}

function buildSites(records) {
  const sites = new Map();

  for (const record of records) {
    const rawCity = record.Address?.City;
    const match = rawCity ? lookupCity(rawCity) : undefined;
    if (!match) continue;
    const city = match.city;
    if (record.Accessibility === "Restricted access") continue;

    const coords = parseCoords(record);
    if (!coords) continue;

    const key = record.ChargingStationId || record.EvseID;
    const facilities = record.ChargingFacilities ?? [];
    const power = Math.max(
      0,
      ...facilities.map((f) => Number(f.power)).filter(Number.isFinite),
    );
    const isDc = facilities.some((f) => f.powertype === "DC");

    const existing = sites.get(key);
    if (existing) {
      existing.stalls += 1;
      existing.maxPowerKw = Math.max(existing.maxPowerKw, power);
      existing.isDc ||= isDc;
      existing.latSum += coords.lat;
      existing.lonSum += coords.lon;
      continue;
    }

    sites.set(key, {
      id: key,
      name: stationName(record),
      operator: record.operator ?? "Unknown",
      city,
      canton: match.canton,
      address: [record.Address.Street, record.Address.PostalCode, city]
        .filter(Boolean)
        .join(", "),
      // NB: Accessibility describes access, not cost. "Free publicly accessible"
      // means unrestricted, not free of charge — the feed carries no prices at all.
      publiclyAccessible: record.Accessibility === "Free publicly accessible",
      stalls: 1,
      maxPowerKw: power,
      isDc,
      latSum: coords.lat,
      lonSum: coords.lon,
    });
  }

  return [...sites.values()].map((site) => {
    const connectorType = site.isDc ? "DC" : "AC";
    const tariff = TARIFFS[site.operator] ?? DEFAULT_TARIFF;
    return {
      id: site.id,
      name: site.name,
      operator: site.operator,
      city: site.city,
      canton: site.canton,
      address: site.address,
      connectorType,
      maxPowerKw: Math.round(site.maxPowerKw * 10) / 10,
      stalls: site.stalls,
      pricePerKwh: tariff[connectorType],
      priceIsEstimate: true,
      publiclyAccessible: site.publiclyAccessible,
      lat: Math.round((site.latSum / site.stalls) * 1e5) / 1e5,
      lon: Math.round((site.lonSum / site.stalls) * 1e5) / 1e5,
      food: [],
    };
  });
}

function bboxFor(sites) {
  const lats = sites.map((s) => s.lat);
  const lons = sites.map((s) => s.lon);
  return [
    Math.min(...lats) - BBOX_PAD_DEG,
    Math.min(...lons) - BBOX_PAD_DEG,
    Math.max(...lats) + BBOX_PAD_DEG,
    Math.max(...lons) + BBOX_PAD_DEG,
  ];
}

/**
 * Overpass rejects a union spanning hundreds of bounding boxes, so the cities are
 * fetched in batches and the results concatenated. Batched rather than one request
 * per city: still far politer, but small enough that a single query completes.
 */
const BBOX_BATCH = 40;

async function fetchFood(bboxes) {
  // Neighbouring cities produce overlapping bounding boxes, so the same OSM node
  // is returned by several batches (and by a single union query). Keyed by
  // element id, or every station near a boundary lists its cafes twice.
  const seen = new Map();
  for (let i = 0; i < bboxes.length; i += BBOX_BATCH) {
    const batch = bboxes.slice(i, i + BBOX_BATCH);
    process.stdout.write(`\n  batch ${i / BBOX_BATCH + 1}/${Math.ceil(bboxes.length / BBOX_BATCH)}… `);
    const { spots, cached } = await fetchFoodBatch(batch);
    for (const spot of spots) if (!seen.has(spot.id)) seen.set(spot.id, spot);
    // Only pace ourselves against the real server; cached batches cost nothing.
    if (!cached && i + BBOX_BATCH < bboxes.length) await sleep(1000);
  }
  return [...seen.values()];
}

async function fetchFoodBatch(bboxes) {
  const clauses = bboxes
    .map((bbox) => {
      const [s, w, n, e] = bbox.map((v) => v.toFixed(5));
      const box = `(${s},${w},${n},${e})`;
      return `node["amenity"~"^(restaurant|cafe|fast_food|bar|pub)$"]${box};node["shop"="bakery"]${box};`;
    })
    .join("");
  const query = `[out:json][timeout:180];(${clauses});out body;`;
  const { json, cached } = await overpass(query, `${bboxes.length} bboxes`);
  return { spots: parseOverpass(json), cached };
}

/**
 * One Overpass round trip: cache, endpoint rotation and backoff. Shared by the
 * food and greenery passes so a change to the retry policy applies to both.
 */
async function overpass(query, label) {
  // Keyed by the query itself, so a partially failed run replays the batches
  // that already succeeded instead of asking Overpass for them a second time.
  const cached = cacheRead(query);
  if (cached) {
    process.stdout.write("(cached) ");
    return { json: JSON.parse(cached.toString("utf8")), cached: true };
  }

  // Free Overpass instances routinely answer 429/504 under load, so rotate
  // endpoints and back off rather than giving up on the first refusal.
  let lastError;
  for (let round = 0; round < OVERPASS_ROUNDS; round += 1) {
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ data: query }),
        });
        // Being told to slow down is not a failure to retry immediately
        // against the next host — wait exactly as long as we were asked to.
        if (res.status === 429 || res.status === 503) {
          const wait = retryAfterMs(res) ?? OVERPASS_BACKOFF_MS;
          lastError = new Error(`${endpoint} returned ${res.status}`);
          process.stdout.write(`(${res.status}, waiting ${Math.round(wait / 1000)}s) `);
          await sleep(wait);
          continue;
        }
        if (!res.ok) throw new Error(`${endpoint} returned ${res.status}`);
        const text = await res.text();
        cacheWrite(query, Buffer.from(text), `overpass: ${label}`);
        return { json: JSON.parse(text), cached: false };
      } catch (error) {
        lastError = error;
        await sleep(2000);
      }
    }
    await sleep(OVERPASS_BACKOFF_MS * (round + 1));
  }
  throw lastError;
}

// yes/no (and takeaway's "only") -> boolean; anything else means untagged.
const toBool = (v) => (v === "yes" || v === "only" ? true : v === "no" ? false : undefined);

function parseOverpass(json) {
  return json.elements
    .filter((el) => el.tags?.name && Number.isFinite(el.lat))
    .map((el) => {
      const tags = el.tags;
      const spot = {
        id: el.id,
        name: tags.name,
        category: tags.amenity ?? tags.shop,
        cuisine: tags.cuisine?.split(";")[0] ?? null,
        lat: el.lat,
        lon: el.lon,
      };
      if (tags.opening_hours) spot.openingHours = tags.opening_hours;
      const outdoorSeating = toBool(tags.outdoor_seating);
      if (outdoorSeating !== undefined) spot.outdoorSeating = outdoorSeating;
      const takeaway = toBool(tags.takeaway);
      if (takeaway !== undefined) spot.takeaway = takeaway;
      if (tags.wheelchair === "yes" || tags.wheelchair === "limited" || tags.wheelchair === "no") {
        spot.wheelchair = tags.wheelchair;
      }
      return spot;
    });
}

async function fetchGreen(bboxes) {
  const seen = new Map();
  for (let i = 0; i < bboxes.length; i += GREEN_BBOX_BATCH) {
    const batch = bboxes.slice(i, i + GREEN_BBOX_BATCH);
    process.stdout.write(
      `\n  batch ${i / GREEN_BBOX_BATCH + 1}/${Math.ceil(bboxes.length / GREEN_BBOX_BATCH)}… `,
    );
    const clauses = batch
      .map((bbox) => {
        const [s, w, n, e] = bbox.map((v) => v.toFixed(5));
        const box = `(${s},${w},${n},${e})`;
        return (
          `way["leisure"~"^(park|garden|nature_reserve|common)$"]${box};` +
          `way["landuse"~"^(forest|meadow|grass|village_green|orchard|vineyard|allotments)$"]${box};` +
          `way["natural"~"^(wood|water|scrub|heath|grassland|beach)$"]${box};`
        );
      })
      .join("");
    // "tags bb" rather than "geom": the bounding box is a tenth of the bytes
    // and, at these feature sizes, close enough to the real outline.
    const query = `[out:json][timeout:180];(${clauses});out tags bb;`;
    const { json, cached } = await overpass(query, `green, ${batch.length} bboxes`);
    for (const area of parseGreen(json)) if (!seen.has(area.id)) seen.set(area.id, area);
    if (!cached && i + GREEN_BBOX_BATCH < bboxes.length) await sleep(1000);
  }
  return [...seen.values()];
}

function parseGreen(json) {
  const areas = [];
  for (const el of json.elements) {
    const b = el.bounds;
    if (!b || !el.tags) continue;
    // Guards against corrupt geometry seen in the live data (a forest way
    // reporting minlat -91), which would otherwise sit 0 m from everything.
    if (b.minlat < 45 || b.maxlat > 48.5 || b.minlon < 5 || b.maxlon > 11) continue;
    const key = ["leisure", "landuse", "natural"]
      .map((k) => (el.tags[k] ? `${k}=${el.tags[k]}` : null))
      .find((k) => k && GREEN_WEIGHTS[k] !== undefined);
    if (!key) continue;
    const diagonalKm = Math.hypot(
      (b.maxlat - b.minlat) * 111,
      (b.maxlon - b.minlon) * 75,
    );
    if (diagonalKm > GREEN_MAX_DIAGONAL_KM) continue;
    areas.push({
      id: el.id,
      name: el.tags.name ?? null,
      category: key.split("=")[1],
      weight: GREEN_WEIGHTS[key],
      bounds: b,
    });
  }
  return areas;
}

/** Metres from a point to the nearest edge of a bounding box; 0 when inside. */
function metresToBounds(point, b) {
  const dLat = Math.max(b.minlat - point.lat, 0, point.lat - b.maxlat);
  const dLon = Math.max(b.minlon - point.lon, 0, point.lon - b.maxlon);
  if (dLat === 0 && dLon === 0) return 0;
  return haversineMetres(point, {
    lat: point.lat + (b.minlat - point.lat > 0 ? dLat : -dLat),
    lon: point.lon + (b.minlon - point.lon > 0 ? dLon : -dLon),
  });
}

/**
 * 0–100 for how green the immediate surroundings are: the best nearby space
 * carries the score, with a small bonus for having several. Same shape as
 * foodScore, so the two read the same way on a card.
 */
// Matches foodScore's bonus. At 6 the cap flattened 43% of the country onto
// 90-100; the nearest space should carry the score, not the count.
const GREEN_VARIETY_BONUS = 4;
const MAX_GREEN_VARIETY = 3;

function attachGreen(sites, areas) {
  for (const site of sites) {
    const nearby = [];
    for (const area of areas) {
      const distance = metresToBounds(site, area.bounds);
      if (distance > GREEN_RADIUS_M) continue;
      // Full marks at the edge of the space, fading to nothing at the radius.
      const falloff = 1 - distance / GREEN_RADIUS_M;
      nearby.push({ area, distance, value: area.weight * falloff * 100 });
    }
    nearby.sort((a, b) => b.value - a.value);

    if (nearby.length === 0) {
      site.greenScore = 0;
      site.green = [];
      continue;
    }
    const variety = Math.min(nearby.length - 1, MAX_GREEN_VARIETY) * GREEN_VARIETY_BONUS;
    site.greenScore = Math.round(Math.min(nearby[0].value + variety, 100));
    site.green = nearby.slice(0, MAX_GREEN_PER_STATION).map(({ area, distance }) => ({
      name: area.name,
      category: area.category,
      distanceMetres: Math.round(distance),
    }));
  }
}

function attachFood(sites, food) {
  for (const site of sites) {
    const nearby = [];
    for (const spot of food) {
      const distance = haversineMetres(site, spot);
      if (distance <= FOOD_RADIUS_M) nearby.push({ spot, distance });
    }
    nearby.sort((a, b) => a.distance - b.distance);
    site.food = nearby.slice(0, MAX_FOOD_PER_STATION).map(({ spot, distance }) => {
      const entry = {
        name: spot.name,
        category: spot.category,
        cuisine: spot.cuisine,
        distanceMetres: Math.round(distance),
        walkingMinutes: Math.max(1, Math.round(distance / WALK_METRES_PER_MINUTE)),
      };
      if (spot.openingHours !== undefined) entry.openingHours = spot.openingHours;
      if (spot.outdoorSeating !== undefined) entry.outdoorSeating = spot.outdoorSeating;
      if (spot.takeaway !== undefined) entry.takeaway = spot.takeaway;
      if (spot.wheelchair !== undefined) entry.wheelchair = spot.wheelchair;
      return entry;
    });
    site.foodCount = nearby.length;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const records = await fetchEvseData();
  const sites = buildSites(records);
  console.log(`Grouped into ${sites.length} sites across ${CITY_LOOKUP.size} name keys`);

  const byCity = new Map();
  for (const site of sites) {
    if (!byCity.has(site.city)) byCity.set(site.city, []);
    byCity.get(site.city).push(site);
  }

  const bboxes = [...byCity.values()].map(bboxFor);
  let foodAvailable = true;
  if (SKIP_FOOD) {
    foodAvailable = false;
    for (const site of sites) {
      site.food = [];
      site.foodCount = null;
    }
    console.log("Skipping food POIs (SKIP_FOOD set).");
  } else try {
    process.stdout.write("Fetching food POIs from Overpass… ");
    const food = await fetchFood(bboxes);
    console.log(`${food.length} POIs`);
    attachFood(sites, food);
    for (const [city, citySites] of byCity) {
      const withFood = citySites.filter((s) => s.foodCount > 0).length;
      console.log(`  ${city}: ${withFood}/${citySites.length} sites with food nearby`);
    }
  } catch (error) {
    foodAvailable = false;
    for (const site of sites) {
      site.food = [];
      site.foodCount = null;
    }
    console.log(`\n  Overpass unavailable (${error.message}).`);
    console.log("  Stations written without food data — re-run to backfill.");
  }

  let greenAvailable = true;
  const clearGreen = () => {
    for (const site of sites) {
      site.green = [];
      site.greenScore = null;
    }
  };
  if (SKIP_GREEN) {
    greenAvailable = false;
    clearGreen();
    console.log("Skipping green spaces (SKIP_GREEN set).");
  } else try {
    process.stdout.write("Fetching green spaces from Overpass… ");
    const areas = await fetchGreen(bboxes);
    console.log(`${areas.length} areas`);
    attachGreen(sites, areas);
    const scored = sites.filter((s) => s.greenScore > 0);
    const mean = scored.reduce((sum, s) => sum + s.greenScore, 0) / (scored.length || 1);
    console.log(
      `  ${scored.length}/${sites.length} sites with green space within ` +
        `${GREEN_RADIUS_M} m (mean score ${Math.round(mean)})`,
    );
  } catch (error) {
    greenAvailable = false;
    clearGreen();
    console.log(`\n  Overpass unavailable for green spaces (${error.message}).`);
    console.log("  Stations written without greenery — re-run to backfill.");
  }

  const payload = {
    foodAvailable,
    greenAvailable,
    generatedAt: new Date().toISOString(),
    source: {
      stations: "Swiss Federal Office of Energy (BFE) / ich-tanke-strom, via data.geo.admin.ch",
      food: "OpenStreetMap contributors, via Overpass API (ODbL)",
      green: "OpenStreetMap contributors, via Overpass API (ODbL)",
      pricing: "Estimated per-operator tariffs — not from the federal feed",
    },
    foodRadiusMetres: FOOD_RADIUS_M,
    greenRadiusMetres: GREEN_RADIUS_M,
    stations: sites
      .map(({ lat, lon, ...rest }) => ({ ...rest, lat, lon }))
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
