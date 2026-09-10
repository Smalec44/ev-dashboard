/**
 * The federal charging feed (BFE / ich-tanke-strom), in its OICP form: one
 * record per charge point, grouped here into sites; and its companion status
 * feed, one live status per charge point.
 */
import { gunzipSync } from "node:zlib";
import { REGIONS } from "../../data/regions.ts";
import { DEFAULT_TARIFF, tariffFor } from "../../data/tariffs.ts";
import { haversineMetres } from "./geo.ts";
import type { ChargingStation, ConnectorType, LatLon, LiveStatus, Region } from "../../lib/types.ts";

export const EVSE_URL =
  "https://data.geo.admin.ch/ch.bfe.ladestellen-elektromobilitaet/data/oicp/ch.bfe.ladestellen-elektromobilitaet.json";
export const STATUS_URL =
  "https://data.geo.admin.ch/ch.bfe.ladestellen-elektromobilitaet/status/oicp/ch.bfe.ladestellen-elektromobilitaet.json";

/** A site as the pipeline works on it; `evseIds` is stripped before publishing. */
export interface Site extends ChargingStation {
  publiclyAccessible: boolean;
  evseIds: string[];
}

interface LocalisedName {
  lang?: string;
  value?: string;
}

/** The fields of an OICP EVSEDataRecord this pipeline reads. */
export interface FeedRecord {
  EvseID: string;
  ChargingStationId?: string;
  Accessibility?: string;
  GeoCoordinates?: { Google?: string };
  Address?: { Street?: string; PostalCode?: string; City?: string };
  ChargingStationNames?: LocalisedName[] | LocalisedName;
  ChargingFacilities?: { power?: number | string; powertype?: string }[];
  /** Added while flattening: the OperatorName of the enclosing block. */
  operator?: string | undefined;
}

interface FeedJson {
  EVSEData: { OperatorName?: string; EVSEDataRecord?: FeedRecord[] }[];
}

interface StatusJson {
  EVSEStatuses: { EVSEStatusRecord?: { EvseID: string; EVSEStatus: string }[] }[];
}

/** Both files are served gzipped despite the .json extension — sometimes. */
export function decodeJson(buffer: Uint8Array): unknown {
  const bytes =
    buffer[0] === 0x1f && buffer[1] === 0x8b ? gunzipSync(buffer) : buffer;
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function parseFeed(buffer: Uint8Array): FeedRecord[] {
  const json = decodeJson(buffer) as FeedJson;
  return json.EVSEData.flatMap((block) =>
    (block.EVSEDataRecord ?? []).map((r) => ({
      ...r,
      operator: block.OperatorName,
    })),
  );
}

/** Live status per charge point id. */
export function parseStatus(buffer: Uint8Array): Map<string, string> {
  const json = decodeJson(buffer) as StatusJson;
  const statuses = new Map<string, string>();
  for (const block of json.EVSEStatuses) {
    for (const record of block.EVSEStatusRecord ?? []) {
      statuses.set(record.EvseID, record.EVSEStatus);
    }
  }
  return statuses;
}

// Derived from REGIONS rather than duplicated, so the city names we
// canonicalise to cannot drift from the ones the UI can search.
const norm = (v: string) =>
  v.toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g, "");

const CITY_LOOKUP = new Map<string, { city: string; canton: string }>();
{
  // Operators write whatever city name they like into the feed — often the
  // German exonym ("Sitten" for Sion). Aliases are accepted as feed keys and
  // normalised to the region's canonical name, so both spellings land together.
  for (const region of REGIONS) {
    for (const key of [region.city, ...region.aliases]) {
      // First writer wins: REGIONS is population-ordered, so shared names
      // (Wohlen AG/BE, Buchs SG/AG) resolve to the larger city.
      if (!CITY_LOOKUP.has(norm(key))) {
        CITY_LOOKUP.set(norm(key), { city: region.city, canton: region.canton });
      }
    }
  }
}

const lookupCity = (name: string) => CITY_LOOKUP.get(norm(name));

/** Equirectangular, at 47°N. Only ever used to rank candidates against each other. */
function distanceKmApprox(a: LatLon, b: LatLon): number {
  return Math.hypot((a.lat - b.lat) * 111, (a.lon - b.lon) * 76);
}

/**
 * Nearest town centre from REGIONS, for a station whose city the list does not
 * know. REGIONS stops at ~1200 inhabitants, so the feed is full of perfectly
 * real places it has never heard of — merged municipalities the feed names by
 * their new name ("Val de Bagnes", where the list still says "Bagnes"), city
 * quarters ("Le Lignon" in Vernier), resorts ("Verbier" is in the list but the
 * chargers there are filed under the municipality) and plain hamlets.
 *
 * Only the canton is taken from the match: it is required by the schema but
 * shown nowhere, and over the charge points whose city IS in the list the
 * nearest centre names the right canton 96% of the time — the rest are
 * cross-border neighbours (Basel/Birsfelden) or cases where the name lookup
 * itself picked the wrong twin (Muri BE vs AG) and the coordinates are righter.
 */
function nearestRegion(point: LatLon): Region {
  let best: Region | undefined;
  let bestKm = Infinity;
  for (const region of REGIONS) {
    const km = distanceKmApprox(point, region);
    if (km < bestKm) {
      bestKm = km;
      best = region;
    }
  }
  if (!best) throw new Error("REGIONS is empty");
  return best;
}

// The federal feed carries no tariffs; prices come from the dated table in
// src/data/tariffs.ts, and the national default where an operator is missing.
function priceFor(operator: string, connectorType: ConnectorType): { price: number; published: boolean } {
  const tariff = tariffFor(operator);
  const key = connectorType === "DC" ? "dc" : "ac";
  const value = tariff?.[key];
  if (value !== undefined && value !== null) return { price: value, published: true };
  return { price: DEFAULT_TARIFF[key], published: false };
}

/**
 * Switzerland with a margin wide enough for border sites. The feed carries
 * sentinel coordinates on a small number of records — 45 sit at (50, -15) in
 * the Atlantic and 7 in Malta, all with real Swiss addresses — and a station
 * that claims to be 1,367 km from its own city ruins any distance ranking it
 * lands in, besides drawing its food and greenery from the wrong continent.
 */
const CH_BOUNDS = { minLat: 45.5, maxLat: 48.0, minLon: 5.5, maxLon: 11.0 };

/** The most a three-phase AC connector delivers; above it, the current is DC. */
const MAX_AC_KW = 43;

function parseCoords(record: FeedRecord): LatLon | null {
  const raw = record.GeoCoordinates?.Google;
  if (!raw) return null;
  const [lat, lon] = raw.trim().split(/\s+/).map(Number);
  if (lat === undefined || lon === undefined) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (
    lat < CH_BOUNDS.minLat || lat > CH_BOUNDS.maxLat ||
    lon < CH_BOUNDS.minLon || lon > CH_BOUNDS.maxLon
  ) {
    return null;
  }
  return { lat, lon };
}

/** The feed's four spellings of the country, filed as a city by some operators. */
const COUNTRY_NAMES = new Set(["schweiz", "suisse", "svizzera", "switzerland"]);

/**
 * Some records carry a placeholder ("-"), a stray address fragment ("/ West",
 * "Süd 5a") or the country itself ("Schweiz") where the city should be. None
 * of those is a place name: anything not starting with a letter, carrying a
 * digit, or naming the country is rejected so the coordinates answer instead.
 */
function looksLikePlaceName(city: string): boolean {
  if (!/^\p{L}/u.test(city)) return false;
  if (/\d/.test(city)) return false;
  return !COUNTRY_NAMES.has(city.toLowerCase());
}

function stationName(record: FeedRecord): string {
  // The feed returns either an array of localised names or a single object.
  const raw = record.ChargingStationNames;
  const names = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const preferred =
    names.find((n) => n.lang === "de") ??
    names.find((n) => n.lang === "en") ??
    names[0];
  // Empty strings count as missing here, which is why this is not `??`.
  const value = preferred?.value?.trim();
  if (value) return value;
  const street = record.Address?.Street?.trim();
  if (street) return street;
  return "Charging station";
}

interface Accumulator {
  id: string;
  name: string;
  operator: string;
  city: string;
  canton: string;
  address: string;
  publiclyAccessible: boolean;
  stalls: number;
  /** Highest known power; 0 while no record has reported one. Published as null. */
  maxPowerKw: number;
  isDc: boolean;
  latSum: number;
  lonSum: number;
  evseIds: string[];
}

export function buildSites(records: FeedRecord[]): Site[] {
  const sites = new Map<string, Accumulator>();

  for (const record of records) {
    if (record.Accessibility === "Restricted access") continue;

    const coords = parseCoords(record);
    if (!coords) continue;

    /*
     * The city is a label, not a filter. Requiring it to be a REGIONS name
     * dropped 3019 of 11702 sites — a quarter of the country's public chargers,
     * Verbier's included — because the feed spells places in ways a list of the
     * 1000 largest municipalities cannot cover. The UI finds stations by radius
     * around a town centre anyway, so an unrecognised name costs nothing:
     * canonicalise it when we can, keep the operator's own spelling when we
     * cannot, and let geography do the rest.
     */
    const rawCity = record.Address?.City?.trim();
    const match = rawCity ? lookupCity(rawCity) : undefined;
    const named = rawCity && looksLikePlaceName(rawCity) ? rawCity : null;
    let city: string;
    let canton: string;
    if (match) {
      city = match.city;
      canton = match.canton;
    } else {
      const nearest = nearestRegion(coords);
      city = named ?? nearest.city;
      canton = nearest.canton;
    }

    const stationId = record.ChargingStationId?.trim();
    const key = stationId !== undefined && stationId !== "" ? stationId : record.EvseID;
    const facilities = record.ChargingFacilities ?? [];
    // Some operators file 0 (or nothing) as the power — that is "unknown",
    // not a 0 kW charger. Kept as 0 in the accumulator so that max() over
    // sibling records lets any known value win, and published as null.
    const power = Math.max(
      0,
      ...facilities.map((f) => Number(f.power)).filter(Number.isFinite),
    );
    // Operators file some DC chargers under an AC power type — Tesla's
    // 250 kW Superchargers among them. Three-phase AC tops out at 43 kW,
    // so anything above that is DC whatever the label says.
    const isDc =
      facilities.some((f) => f.powertype === "DC") || power > MAX_AC_KW;

    const existing = sites.get(key);
    if (existing) {
      existing.stalls += 1;
      existing.maxPowerKw = Math.max(existing.maxPowerKw, power);
      existing.isDc ||= isDc;
      existing.latSum += coords.lat;
      existing.lonSum += coords.lon;
      existing.evseIds.push(record.EvseID);
      continue;
    }

    sites.set(key, {
      id: key,
      name: stationName(record),
      operator: record.operator ?? "Unknown",
      city,
      canton,
      address: [record.Address?.Street, record.Address?.PostalCode, city]
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
      evseIds: [record.EvseID],
    });
  }

  return mergeTwins([...sites.values()]).map((site) => {
    const connectorType: ConnectorType = site.isDc ? "DC" : "AC";
    const { price, published } = priceFor(site.operator, connectorType);
    return {
      id: site.id,
      name: site.name,
      operator: site.operator,
      city: site.city,
      canton: site.canton,
      address: site.address,
      connectorType,
      maxPowerKw: site.maxPowerKw > 0 ? Math.round(site.maxPowerKw * 10) / 10 : null,
      stalls: site.stalls,
      pricePerKwh: price,
      // "Estimate" now means "no published tariff found for this operator".
      priceIsEstimate: !published,
      publiclyAccessible: site.publiclyAccessible,
      lat: Math.round((site.latSum / site.stalls) * 1e5) / 1e5,
      lon: Math.round((site.lonSum / site.stalls) * 1e5) / 1e5,
      food: [],
      evseIds: site.evseIds,
    };
  });
}

/** Same operator, same name, this close together: one site, not two. */
const TWIN_METRES = 50;

/**
 * Same operator, whatever the names, this close together: one site. Tight
 * enough that "Nord" and "Süd" across a car park stay apart, wide enough to
 * absorb operators who round the coordinates of every bay to the same spot.
 */
const SAME_SPOT_METRES = 5;

/**
 * Parking-bay suffixes some operators put in the name — "… PP202", "… P 14",
 * "… Platz 3" — so that the bays of one car park compare equal. Anything
 * else in the name is kept, so "Nord" and "Süd" stay two sites.
 */
const BAY_SUFFIX = /[\s,\-–]*(?:pp|p|platz|nr\.?|#)\s?\d+[a-z]?$/i;

/** Stray punctuation some operators leave at the end: "Nordpark rechts ." */
const TRAILING_PUNCTUATION = /[\s.,;:\-–]+$/;

function twinKey(site: Accumulator): string {
  const name = site.name.trim().toLowerCase().replace(BAY_SUFFIX, "").trim();
  return `${site.operator}\u0000${name}`;
}

/** The car park's name rather than one bay's: suffix and trailing punctuation gone. */
function siteName(name: string): string {
  return name.replace(BAY_SUFFIX, "").replace(TRAILING_PUNCTUATION, "").trim() || name;
}

const centre = (site: Accumulator): LatLon => ({
  lat: site.latSum / site.stalls,
  lon: site.lonSum / site.stalls,
});

/** Folds `site` into `twin`, which then stands for both. */
function absorb(twin: Accumulator, site: Accumulator): void {
  twin.stalls += site.stalls;
  twin.maxPowerKw = Math.max(twin.maxPowerKw, site.maxPowerKw);
  twin.isDc ||= site.isDc;
  twin.publiclyAccessible ||= site.publiclyAccessible;
  twin.latSum += site.latSum;
  twin.lonSum += site.lonSum;
  twin.evseIds.push(...site.evseIds);
  // The lowest id names the merged site, so the outcome does not depend
  // on the order the feed happened to list the records in.
  if (site.id < twin.id) twin.id = site.id;
}

/**
 * Some operators give every stall its own ChargingStationId, so a four-stall
 * site arrives as four identical records — "Tamoil Herrlisberg Nord" listed
 * four times in a row, each with one stall. Name plus proximity is the only
 * signal the feed leaves to put them back together.
 */
function mergeByName(sites: Accumulator[]): Accumulator[] {
  const groups = new Map<string, Accumulator[]>();
  const kept: Accumulator[] = [];
  for (const site of sites) {
    const key = twinKey(site);
    const group = groups.get(key) ?? [];
    const point = centre(site);
    const twin = group.find(
      (other) => haversineMetres(point, centre(other)) <= TWIN_METRES,
    );
    if (twin) {
      absorb(twin, site);
      // A merged site is the car park, not one of its bays.
      twin.name = siteName(twin.name);
      continue;
    }
    group.push(site);
    groups.set(key, group);
    kept.push(site);
  }
  return kept;
}

/**
 * Other operators number the bays in ways the suffix pattern cannot know
 * ("Parkfeld 01" … "Parkfeld 05") or leave a stray dot on one twin ("Aarau
 * Nordpark rechts ."), while filing every bay at the same coordinates. Same
 * operator at the same spot is one site whatever the names say; the shortest
 * cleaned name is the least likely to carry a bay's own label.
 *
 * Candidates are bucketed on a ~10 m grid so that each site is compared with
 * its neighbours only, not with every other site of a large operator.
 */
function mergeByPlace(sites: Accumulator[]): Accumulator[] {
  const CELL = 1e-4; // degrees: ~11 m of latitude, ~7.5 m of longitude at 47°N
  const cells = new Map<string, Accumulator[]>();
  const kept: Accumulator[] = [];
  for (const site of sites) {
    const point = centre(site);
    const row = Math.floor(point.lat / CELL);
    const col = Math.floor(point.lon / CELL);
    let twin: Accumulator | undefined;
    for (let dr = -1; dr <= 1 && !twin; dr += 1) {
      for (let dc = -1; dc <= 1 && !twin; dc += 1) {
        const bucket = cells.get(`${site.operator}\u0000${row + dr}\u0000${col + dc}`);
        twin = bucket?.find(
          (other) => haversineMetres(point, centre(other)) <= SAME_SPOT_METRES,
        );
      }
    }
    if (twin) {
      absorb(twin, site);
      const [name] = [siteName(twin.name), siteName(site.name)].sort(
        (a, b) => a.length - b.length || a.localeCompare(b),
      );
      twin.name = name ?? twin.name;
      continue;
    }
    const key = `${site.operator}\u0000${row}\u0000${col}`;
    const cell = cells.get(key) ?? [];
    cell.push(site);
    cells.set(key, cell);
    kept.push(site);
  }
  return kept;
}

function mergeTwins(sites: Accumulator[]): Accumulator[] {
  return mergeByPlace(mergeByName(sites));
}

/**
 * Folds the per-charge-point statuses into counts per site. A point the
 * status feed does not mention at all counts as unknown, the same as one it
 * reports as Unknown: either way nobody can say whether it is free.
 */
export function attachLiveStatus(
  sites: Site[],
  statuses: Map<string, string>,
  at: string,
): void {
  for (const site of sites) {
    const live: LiveStatus = { available: 0, busy: 0, outOfService: 0, unknown: 0, at };
    for (const id of site.evseIds) {
      switch (statuses.get(id)) {
        case "Available":
          live.available += 1;
          break;
        case "Occupied":
        case "Reserved":
          live.busy += 1;
          break;
        case "OutOfService":
          live.outOfService += 1;
          break;
        default:
          live.unknown += 1;
      }
    }
    site.live = live;
  }
}

/** The published shape: coordinates last for readability, internals gone. */
export function publishSite(site: Site): ChargingStation {
  const { evseIds: _evseIds, lat, lon, ...rest } = site;
  return { ...rest, lat, lon };
}
