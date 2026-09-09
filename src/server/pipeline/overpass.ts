/**
 * OpenStreetMap via the Overpass API: food, green spaces and parking terms
 * around the charging sites. Shared by the offline build and the live
 * refresh route, which differ only in patience — the build can wait out a
 * rate limit, a request cannot.
 */
import type { Bbox, Bounds } from "./geo.ts";
import type { ParkingTerms } from "../../lib/types.ts";

// Override with a comma-separated list to use your own instance — the public
// ones are heavily rate-limited and will block a host that keeps retrying.
export const DEFAULT_ENDPOINTS = [
  // Swiss OSM instance first: closest to this data set and reliably up when
  // the big generic mirrors are saturated (they answer 504 under load).
  "https://overpass.osm.ch/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

export interface OverpassCache {
  read(key: string): string | null;
  write(key: string, text: string, label: string): void;
}

export interface OverpassOptions {
  endpoints?: string[];
  /** Full passes over the endpoint list before giving up. */
  rounds?: number;
  /** Pause between rounds, growing linearly; also the wait for a 429 with no Retry-After. */
  backoffMs?: number;
  /** Longest a Retry-After header is honoured for. */
  maxRetryWaitMs?: number;
  /** Server-side query timeout, in seconds. */
  timeoutSeconds?: number;
  /** Batches in flight at once. One is politest; the live route uses more. */
  concurrency?: number;
  cache?: OverpassCache;
  log?: (message: string) => void;
}

const DEFAULTS = {
  rounds: 4,
  backoffMs: 20_000,
  maxRetryWaitMs: 120_000,
  timeoutSeconds: 180,
  concurrency: 1,
};

interface OverpassElement {
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  bounds?: Bounds;
  tags?: Record<string, string>;
}

export interface OverpassJson {
  elements: OverpassElement[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Seconds to wait per a 429/503 Retry-After header, capped so we never hang. */
function retryAfterMs(res: Response, cap: number): number | null {
  const raw = res.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.min(seconds * 1000, cap);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.min(Math.max(at - Date.now(), 0), cap) : null;
}

/**
 * One Overpass round trip: cache, endpoint rotation and backoff. Shared by
 * every pass so a change to the retry policy applies to all of them.
 */
export async function overpass(
  query: string,
  label: string,
  options: OverpassOptions = {},
): Promise<{ json: OverpassJson; cached: boolean }> {
  const { rounds, backoffMs, maxRetryWaitMs } = { ...DEFAULTS, ...options };
  const endpoints = options.endpoints ?? DEFAULT_ENDPOINTS;
  const log = options.log ?? (() => {});

  // Keyed by the query itself, so a partially failed run replays the batches
  // that already succeeded instead of asking Overpass for them a second time.
  const cached = options.cache?.read(query);
  if (cached) {
    log("(cached) ");
    return { json: JSON.parse(cached) as OverpassJson, cached: true };
  }

  // Free Overpass instances routinely answer 429/504 under load, so rotate
  // endpoints and back off rather than giving up on the first refusal.
  let lastError: unknown;
  for (let round = 0; round < rounds; round += 1) {
    for (const endpoint of endpoints) {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ data: query }),
        });
        // Being told to slow down is not a failure to retry immediately
        // against the next host — wait as long as we were asked to, within reason.
        if (res.status === 429 || res.status === 503) {
          const wait = retryAfterMs(res, maxRetryWaitMs) ?? backoffMs;
          lastError = new Error(`${endpoint} returned ${res.status}`);
          log(`(${res.status}, waiting ${Math.round(wait / 1000)}s) `);
          await sleep(wait);
          continue;
        }
        if (!res.ok) throw new Error(`${endpoint} returned ${res.status}`);
        const text = await res.text();
        options.cache?.write(query, text, `overpass: ${label}`);
        return { json: JSON.parse(text) as OverpassJson, cached: false };
      } catch (error) {
        lastError = error;
        await sleep(Math.min(2000, backoffMs));
      }
    }
    if (round + 1 < rounds) await sleep(backoffMs * (round + 1));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Runs `worker` over `items`, at most `limit` at a time, preserving order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(lanes);
  return results;
}

/**
 * Overpass rejects a union spanning hundreds of bounding boxes, so the cells
 * are fetched in batches and the results concatenated. Batched rather than
 * one request per cell: still far politer, but small enough that a single
 * query completes.
 */
async function batched<T extends { id: number }>(
  bboxes: Bbox[],
  batchSize: number,
  label: string,
  buildQuery: (batch: Bbox[]) => string,
  parse: (json: OverpassJson) => T[],
  options: OverpassOptions,
): Promise<T[]> {
  const { concurrency } = { ...DEFAULTS, ...options };
  const log = options.log ?? (() => {});
  const batches: Bbox[][] = [];
  for (let i = 0; i < bboxes.length; i += batchSize) {
    batches.push(bboxes.slice(i, i + batchSize));
  }

  const results = await mapLimit(batches, concurrency, async (batch, index) => {
    log(`\n  batch ${index + 1}/${batches.length}… `);
    const { json, cached } = await overpass(
      buildQuery(batch),
      `${label}, ${batch.length} bboxes`,
      options,
    );
    // Only pace ourselves against the real server; cached batches cost nothing,
    // and a concurrent run has already decided to be less polite.
    if (!cached && concurrency === 1 && index + 1 < batches.length) await sleep(1000);
    return parse(json);
  });

  // Neighbouring cells produce overlapping boxes, so the same OSM element is
  // returned by several batches (and by a single union query). Keyed by
  // element id, or every station near a boundary lists its cafes twice.
  const seen = new Map<number, T>();
  for (const batch of results) {
    for (const item of batch) if (!seen.has(item.id)) seen.set(item.id, item);
  }
  return [...seen.values()];
}

const box = (bbox: Bbox) => `(${bbox.map((v) => v.toFixed(5)).join(",")})`;

const header = (options: OverpassOptions) =>
  `[out:json][timeout:${options.timeoutSeconds ?? DEFAULTS.timeoutSeconds}];`;

// ---- food ------------------------------------------------------------------

export interface FoodPoi {
  id: number;
  name: string;
  category: string;
  cuisine: string | null;
  lat: number;
  lon: number;
  openingHours?: string;
  outdoorSeating?: boolean;
  takeaway?: boolean;
  wheelchair?: "yes" | "limited" | "no";
}

// yes/no (and takeaway's "only") -> boolean; anything else means untagged.
export const toBool = (v: string | undefined): boolean | undefined =>
  v === "yes" || v === "only" ? true : v === "no" ? false : undefined;

export function parseFood(json: OverpassJson): FoodPoi[] {
  const spots: FoodPoi[] = [];
  for (const el of json.elements) {
    const tags = el.tags;
    if (!tags?.name || !Number.isFinite(el.lat) || !Number.isFinite(el.lon)) continue;
    const spot: FoodPoi = {
      id: el.id,
      name: tags.name,
      category: tags.amenity ?? tags.shop,
      cuisine: tags.cuisine?.split(";")[0] ?? null,
      lat: el.lat!,
      lon: el.lon!,
    };
    if (tags.opening_hours) spot.openingHours = tags.opening_hours;
    const outdoorSeating = toBool(tags.outdoor_seating);
    if (outdoorSeating !== undefined) spot.outdoorSeating = outdoorSeating;
    const takeaway = toBool(tags.takeaway);
    if (takeaway !== undefined) spot.takeaway = takeaway;
    if (tags.wheelchair === "yes" || tags.wheelchair === "limited" || tags.wheelchair === "no") {
      spot.wheelchair = tags.wheelchair;
    }
    spots.push(spot);
  }
  return spots;
}

const FOOD_BBOX_BATCH = 40;

export function fetchFood(bboxes: Bbox[], options: OverpassOptions = {}): Promise<FoodPoi[]> {
  return batched(
    bboxes,
    FOOD_BBOX_BATCH,
    "food",
    (batch) =>
      header(options) +
      "(" +
      batch
        .map(
          (bbox) =>
            `node["amenity"~"^(restaurant|cafe|fast_food|bar|pub)$"]${box(bbox)};` +
            `node["shop"="bakery"]${box(bbox)};`,
        )
        .join("") +
      ");out body;",
    parseFood,
    options,
  );
}

// ---- green -----------------------------------------------------------------

/**
 * How much each kind of green space is worth to someone waiting at a charger.
 * A park you can sit in is not a road verge, and OSM tags both as "green" —
 * landuse=grass alone outnumbers parks nine to one in Zürich, so weighting is
 * what keeps the score from saying every motorway junction is leafy.
 */
const GREEN_WEIGHTS: Record<string, number> = {
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

/**
 * Green areas are ways, so Overpass returns a bounding box rather than a shape
 * and distance is measured to the box edge. That is accurate because the boxes
 * are small — 90% have a diagonal under 230 m, well inside the search radius.
 * The handful above this cap are sprawling multi-valley relations (and one way
 * with a corrupt -91 latitude), where the box says nothing useful about where
 * the trees actually are, so they are dropped rather than trusted.
 */
const GREEN_MAX_DIAGONAL_KM = 2;
/** Denser than food by an order of magnitude, so fewer boxes per request. */
const GREEN_BBOX_BATCH = 10;

export interface GreenArea {
  id: number;
  name: string | null;
  category: string;
  weight: number;
  bounds: Bounds;
}

export function parseGreen(json: OverpassJson): GreenArea[] {
  const areas: GreenArea[] = [];
  for (const el of json.elements) {
    const b = el.bounds;
    const tags = el.tags;
    if (!b || !tags) continue;
    // Guards against corrupt geometry seen in the live data (a forest way
    // reporting minlat -91), which would otherwise sit 0 m from everything.
    if (b.minlat < 45 || b.maxlat > 48.5 || b.minlon < 5 || b.maxlon > 11) continue;
    const key = ["leisure", "landuse", "natural"]
      .map((k) => (tags[k] ? `${k}=${tags[k]}` : null))
      .find((k) => k && GREEN_WEIGHTS[k] !== undefined);
    if (!key) continue;
    const diagonalKm = Math.hypot(
      (b.maxlat - b.minlat) * 111,
      (b.maxlon - b.minlon) * 75,
    );
    if (diagonalKm > GREEN_MAX_DIAGONAL_KM) continue;
    areas.push({
      id: el.id,
      name: tags.name ?? null,
      category: key.split("=")[1],
      weight: GREEN_WEIGHTS[key],
      bounds: b,
    });
  }
  return areas;
}

export function fetchGreen(bboxes: Bbox[], options: OverpassOptions = {}): Promise<GreenArea[]> {
  return batched(
    bboxes,
    GREEN_BBOX_BATCH,
    "green",
    (batch) =>
      header(options) +
      "(" +
      batch
        .map(
          (bbox) =>
            `way["leisure"~"^(park|garden|nature_reserve|common)$"]${box(bbox)};` +
            `way["landuse"~"^(forest|meadow|grass|village_green|orchard|vineyard|allotments)$"]${box(bbox)};` +
            `way["natural"~"^(wood|water|scrub|heath|grassland|beach)$"]${box(bbox)};`,
        )
        .join("") +
      // "tags bb" rather than "geom": the bounding box is a tenth of the bytes
      // and, at these feature sizes, close enough to the real outline.
      ");out tags bb;",
    parseGreen,
    options,
  );
}

// ---- parking ---------------------------------------------------------------

/**
 * Parking terms come from OpenStreetMap's own charging_station nodes, matched
 * to the feed's sites by position.
 *
 * The federal feed has nothing to say about parking: ParkingRestrictions,
 * IsFreeOfCharge and AdditionalInfo are empty on all 19,000 records. OSM
 * mappers tag about 1,500 Swiss chargers with parking:fee and a few dozen with
 * maxstay, and that is all the data there is. A tariff after the free period
 * appears on nobody's node, so it is not offered.
 */
export interface ParkingPoint {
  id: number;
  lat: number;
  lon: number;
  parking: ParkingTerms;
}

/**
 * maxstay is free text: "4 hours", "90 minutes", "4h", "unlimited". Minutes,
 * or null for an explicit "no limit"; undefined when the tag says nothing
 * usable, which is different from saying there is no limit.
 */
export function parseMaxStay(value: string | undefined): number | null | undefined {
  if (!value) return undefined;
  const text = value.trim().toLowerCase();
  if (text === "unlimited" || text === "no") return null;
  const m = text.match(/^(\d+(?:\.\d+)?)\s*(h|hours?|hrs?|std|min|minutes?|mins?)$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Math.round(/^(h|std)/.test(m[2]) ? n * 60 : n);
}

export function parseParking(json: OverpassJson): ParkingPoint[] {
  const points: ParkingPoint[] = [];
  for (const el of json.elements) {
    const tags = el.tags ?? {};
    const point = el.center ?? el;
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) continue;
    const fee = toBool(tags["parking:fee"]);
    const maxStayMinutes = parseMaxStay(tags.maxstay);
    const parking: ParkingTerms = {};
    if (fee !== undefined) parking.free = !fee;
    if (maxStayMinutes !== undefined) parking.maxStayMinutes = maxStayMinutes;
    if (Object.keys(parking).length === 0) continue;
    points.push({ id: el.id, lat: point.lat!, lon: point.lon!, parking });
  }
  return points;
}

const PARKING_CLAUSES = (where: string) =>
  `nwr["amenity"="charging_station"]["parking:fee"]${where};` +
  `nwr["amenity"="charging_station"]["maxstay"]${where};`;

/** Same batch size as food: the tags are rare, so each box returns little. */
const PARKING_BBOX_BATCH = 40;

/**
 * For the whole country, one query: those tags are rare, so the answer is
 * small, and asking per cell would be 300 round trips for the same rows.
 * For a live refresh the cells are few, and a box query answers in seconds
 * where the country-wide area query can take a minute.
 */
export async function fetchParking(
  bboxes: Bbox[] | "country",
  options: OverpassOptions = {},
): Promise<ParkingPoint[]> {
  if (bboxes === "country") {
    const query =
      header(options) +
      `area["ISO3166-1"="CH"]->.ch;(${PARKING_CLAUSES("(area.ch)")});out center tags;`;
    const { json } = await overpass(query, "parking terms, whole country", options);
    return parseParking(json);
  }
  return batched(
    bboxes,
    PARKING_BBOX_BATCH,
    "parking",
    (batch) =>
      header(options) +
      "(" +
      batch.map((bbox) => PARKING_CLAUSES(box(bbox))).join("") +
      ");out center tags;",
    parseParking,
    options,
  );
}
