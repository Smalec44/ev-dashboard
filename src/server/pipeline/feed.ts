/**
 * The federal charging feed (BFE / ich-tanke-strom), in its OICP form: one
 * record per charge point, grouped here into sites; and its companion status
 * feed, one live status per charge point.
 */
import { gunzipSync } from "node:zlib";
import { REGIONS } from "../../data/regions.ts";
import { haversineMetres } from "./geo.ts";
import type { ChargingStation, ConnectorType, LatLon, LiveStatus } from "../../lib/types.ts";

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
  operator?: string;
}

interface FeedJson {
  EVSEData: { OperatorName?: string; EVSEDataRecord?: FeedRecord[] }[];
}

interface StatusJson {
  EVSEStatuses: { EVSEStatusRecord?: { EvseID: string; EVSEStatus: string }[] }[];
}

/** Both files are served gzipped despite the .json extension — sometimes. */
export function decodeJson<T>(buffer: Uint8Array): T {
  const bytes =
    buffer[0] === 0x1f && buffer[1] === 0x8b ? gunzipSync(buffer) : buffer;
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

export function parseFeed(buffer: Uint8Array): FeedRecord[] {
  const json = decodeJson<FeedJson>(buffer);
  return json.EVSEData.flatMap((block) =>
    (block.EVSEDataRecord ?? []).map((r) => ({
      ...r,
      operator: block.OperatorName,
    })),
  );
}

/** Live status per charge point id. */
export function parseStatus(buffer: Uint8Array): Map<string, string> {
  const json = decodeJson<StatusJson>(buffer);
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
function nearestRegion(point: LatLon) {
  let best = REGIONS[0];
  let bestKm = Infinity;
  for (const region of REGIONS) {
    const km = distanceKmApprox(point, region);
    if (km < bestKm) {
      bestKm = km;
      best = region;
    }
  }
  return best;
}

// The federal feed carries no tariffs, so prices are per-operator estimates.
const TARIFFS: Record<string, Record<ConnectorType, number>> = {
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
const DEFAULT_TARIFF: Record<ConnectorType, number> = { AC: 0.45, DC: 0.65 };

/**
 * Switzerland with a margin wide enough for border sites. The feed carries
 * sentinel coordinates on a small number of records — 45 sit at (50, -15) in
 * the Atlantic and 7 in Malta, all with real Swiss addresses — and a station
 * that claims to be 1,367 km from its own city ruins any distance ranking it
 * lands in, besides drawing its food and greenery from the wrong continent.
 */
const CH_BOUNDS = { minLat: 45.5, maxLat: 48.0, minLon: 5.5, maxLon: 11.0 };

function parseCoords(record: FeedRecord): LatLon | null {
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

function stationName(record: FeedRecord): string {
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

interface Accumulator {
  id: string;
  name: string;
  operator: string;
  city: string;
  canton: string;
  address: string;
  publiclyAccessible: boolean;
  stalls: number;
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
    // Some records carry a placeholder ("-") or a stray address fragment
    // ("/ West") where the city should be; anything not starting with a letter
    // is not a place name, so let the coordinates answer instead.
    const named = rawCity && /^\p{L}/u.test(rawCity) ? rawCity : null;
    const fallback = match ? null : nearestRegion(coords);
    const city = match?.city ?? named ?? fallback!.city;
    const canton = match?.canton ?? fallback!.canton;

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
      evseIds: site.evseIds,
    };
  });
}

/** Same operator, same name, this close together: one site, not two. */
const TWIN_METRES = 50;

/**
 * Parking-bay suffixes some operators put in the name — "… PP202", "… P 14",
 * "… Platz 3" — so that the bays of one car park compare equal. Anything
 * else in the name is kept, so "Nord" and "Süd" stay two sites.
 */
const BAY_SUFFIX = /[\s,\-–]*(?:pp|p|platz|nr\.?|#)\s?\d+[a-z]?$/i;

function twinKey(site: Accumulator): string {
  const name = site.name.trim().toLowerCase().replace(BAY_SUFFIX, "").trim();
  return `${site.operator}\u0000${name}`;
}

/**
 * Some operators give every stall its own ChargingStationId, so a four-stall
 * site arrives as four identical records — "Tamoil Herrlisberg Nord" listed
 * four times in a row, each with one stall. Name plus proximity is the only
 * signal the feed leaves to put them back together.
 */
function mergeTwins(sites: Accumulator[]): Accumulator[] {
  const groups = new Map<string, Accumulator[]>();
  const kept: Accumulator[] = [];
  for (const site of sites) {
    const key = twinKey(site);
    const group = groups.get(key) ?? [];
    const point = { lat: site.latSum / site.stalls, lon: site.lonSum / site.stalls };
    const twin = group.find(
      (other) =>
        haversineMetres(point, {
          lat: other.latSum / other.stalls,
          lon: other.lonSum / other.stalls,
        }) <= TWIN_METRES,
    );
    if (twin) {
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
      // A merged site is the car park, not one of its bays.
      twin.name = twin.name.replace(BAY_SUFFIX, "").trim() || twin.name;
      continue;
    }
    group.push(site);
    groups.set(key, group);
    kept.push(site);
  }
  return kept;
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
  void _evseIds;
  return { ...rest, lat, lon };
}
