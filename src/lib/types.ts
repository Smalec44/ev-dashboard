export type ConnectorType = "AC" | "DC";

export type PriceLevel = 1 | 2 | 3;

export interface FoodSpot {
  name: string;
  /** OpenStreetMap frequently omits cuisine; the amenity category stands in. */
  cuisine: string | null;
  /** OSM amenity/shop value: restaurant, cafe, bakery, … */
  category?: string;
  /** Absent for OSM-sourced spots — that data set carries no ratings. */
  rating?: number;
  walkingMinutes: number;
  distanceMetres?: number;
  /** Absent for OSM-sourced spots. */
  priceLevel?: PriceLevel;
  /**
   * Raw OSM `opening_hours` value, e.g. "Mo-Fr 09:00-22:00; Sa 10:00-23:00".
   * Kept unparsed: the syntax has holidays, month ranges and week selectors,
   * so interpreting it is the reader's job and "unknown" is a valid answer.
   */
  openingHours?: string;
  outdoorSeating?: boolean;
  takeaway?: boolean;
  /** OSM `wheelchair`, which distinguishes partial access from none. */
  wheelchair?: "yes" | "limited" | "no";
}

export interface GreenSpace {
  /** Most green areas in OSM are unnamed; the category carries the meaning. */
  name: string | null;
  /** OSM leisure/landuse/natural value: park, forest, water, meadow, … */
  category: string;
  /** To the nearest edge of the area, so 0 means the station sits inside it. */
  distanceMetres: number;
}

export interface LatLon {
  lat: number;
  lon: number;
}

/** A driving route between two places, as the road router measured it. */
export interface RoadRoute {
  /** Along the road, as the router measures it — not the length of `line`. */
  distanceKm: number;
  durationMin: number;
  /** The road itself, thinned to a point every ~150 m. */
  line: LatLon[];
}

/**
 * What OpenStreetMap records about parking at the charger. Sparse by nature:
 * the federal feed carries nothing on parking, and only mappers who bothered
 * tagged it. Each field is present only when the tag was.
 */
export interface ParkingTerms {
  /** False means parking is charged on top of the electricity. */
  free?: boolean;
  /** Longest permitted stay; null when the tag says explicitly "unlimited". */
  maxStayMinutes?: number | null;
}

/**
 * Stall status from the federal status feed at the moment of a live refresh.
 * Counts per site; "busy" folds occupied and reserved together.
 */
export interface LiveStatus {
  available: number;
  busy: number;
  outOfService: number;
  /** Reported without a usable status, or not reported at all. */
  unknown: number;
  /** When the status feed was read. */
  at: string;
}

export interface ChargingStation extends LatLon {
  id: string;
  name: string;
  operator: string;
  city: string;
  canton: string;
  address: string;
  connectorType: ConnectorType;
  /** Peak kW of the fastest connector; null when the feed reports 0 or nothing. */
  maxPowerKw: number | null;
  stalls: number;
  pricePerKwh: number;
  /** True when no published tariff was found for the operator and the default applies. */
  priceIsEstimate?: boolean;
  /** Absent for feed-sourced stations: the federal feed carries no uptime. */
  reliabilityPct?: number;
  food: FoodSpot[];
  /** Total spots within the search radius, of which `food` holds the nearest few. */
  foodCount?: number | null;
  /** The nearest few green spaces; empty when none are within the radius. */
  green?: GreenSpace[];
  /**
   * 0–100 for how green the surroundings are, weighted by the kind of space and
   * how close it is. Null means the lookup never ran, as opposed to 0 for
   * "nothing green nearby" — the same distinction `foodCount` draws.
   */
  greenScore?: number | null;
  /** Absent when no tagged OSM charger sits at this site. */
  parking?: ParkingTerms;
  /** Unrestricted access, per the feed. Says nothing about cost. */
  publiclyAccessible?: boolean;
  /** Only present after a live refresh; the static build carries none. */
  live?: LiveStatus;
}

export interface Region extends LatLon {
  slug: string;
  city: string;
  canton: string;
  aliases: string[];
}

export interface TrendPoint {
  label: string;
  value: number;
  /** Not yet complete (a running year or month), so it reads low by design. */
  partial?: boolean;
}

/** New passenger-car registrations in one year, from the Federal Statistical Office. */
export interface RegistrationYear {
  year: number;
  /** Battery-electric only. */
  bev: number;
  /** All fuel types. */
  total: number;
}

export interface NewsItem {
  title: string;
  url: string;
  /** ISO timestamp. */
  publishedAt: string;
  source: string;
}

/** The three news scopes, each fed by its own source. */
export type NewsRegion = "switzerland" | "europe" | "world";

export const NEWS_REGIONS: { id: NewsRegion; label: string }[] = [
  { id: "switzerland", label: "Switzerland" },
  { id: "europe", label: "Europe" },
  { id: "world", label: "World" },
];

/** What /api/market returns: each part null when its source failed. */
export interface MarketData {
  fetchedAt: string;
  registrations: RegistrationYear[] | null;
  /** Per region; null when that feed failed. */
  news: Record<NewsRegion, NewsItem[] | null>;
  /** "registrations: reason" or "news/<region>: reason" per source that failed. */
  errors: string[];
}
