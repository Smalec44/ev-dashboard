import type { ChargingStation, FoodSpot } from "./types";

export type Criterion =
  | "speed"
  | "price"
  | "availability"
  | "detour"
  | "middle"
  | "nearby"
  | "green";

export const CRITERIA: { id: Criterion; label: string; hint: string }[] = [
  { id: "speed", label: "Charging speed", hint: "Higher peak kW ranks first" },
  { id: "price", label: "Price per kWh", hint: "Cheaper sessions rank first" },
  {
    id: "availability",
    label: "Availability",
    hint: "More stalls and better uptime rank first",
  },
  {
    id: "green",
    label: "Green surroundings",
    hint: "Parks, woods and water near the station rank first",
  },
];

/** Only meaningful when searching around a single place, so offered separately. */
export const REGION_CRITERIA: { id: Criterion; label: string; hint: string }[] = [
  {
    id: "nearby",
    label: "Nearby",
    hint: "Closer to the centre of the searched town ranks first",
  },
];

export const DEFAULT_REGION_CRITERIA: Criterion[] = ["nearby"];

/** Only meaningful with an origin and destination, so offered separately. */
export const TRIP_CRITERIA: { id: Criterion; label: string; hint: string }[] = [
  {
    id: "middle",
    label: "Near the stop point",
    hint: "Closer to where you set the charging break ranks first",
  },
  {
    id: "detour",
    label: "Short detour",
    hint: "Less extra distance off the direct line ranks first",
  },
];

export const DEFAULT_TRIP_CRITERIA: Criterion[] = ["middle", "detour"];

export const DEFAULT_CRITERIA: Criterion[] = ["speed", "price"];
export const DEFAULT_FOOD_THRESHOLD = 60;

export interface RankingOptions {
  criteria: Criterion[];
  foodThreshold: number;
  /** Extra km per station id; required when "detour" is among the criteria. */
  detourKm?: Map<string, number>;
  /** The detour slider's value: the km at which the detour score reaches 0. */
  maxDetourKm?: number;
  /** Position along the route, 0–1; required when "middle" is a criterion. */
  routeProgress?: Map<string, number>;
  /** Where along the route (0–1) the driver wants to stop; halfway by default. */
  stopAt?: number;
  /** Km from the searched centre; required when "nearby" is among the criteria. */
  distanceKm?: Map<string, number>;
  /** The radius slider's value: the km at which the nearby score reaches 0. */
  radiusKm?: number;
}

export interface RankedStation {
  station: ChargingStation;
  score: number;
  foodScore: number;
  bestFood: FoodSpot | null;
  /** False when the source has no amenity data at all, as opposed to none nearby. */
  foodKnown: boolean;
  belowFoodThreshold: boolean;
  breakdown: Partial<Record<Criterion, number>>;
}

const WALK_TOLERANCE_MINUTES = 15;
const MAX_WALK_PENALTY = 35;
const VARIETY_BONUS_PER_SPOT = 4;
const MAX_VARIETY_SPOTS = 3;

/**
 * Baseline "present" score for spots without a rating — in practice almost
 * every spot, since OpenStreetMap (the bulk of this data) carries no ratings
 * at all. Treating them as present-but-unscored keeps proximity and variety
 * meaningful; scoring them zero would flag every station in the country as
 * below threshold.
 */
const UNRATED_BASE_SCORE = 80;

/** Uptime is absent from the federal feed, so stalls carry availability alone. */
const ASSUMED_RELIABILITY_PCT = 100;

function spotScore(spot: FoodSpot): number {
  const base =
    spot.rating === undefined ? UNRATED_BASE_SCORE : (spot.rating / 5) * 100;
  const walkPenalty =
    Math.min(spot.walkingMinutes / WALK_TOLERANCE_MINUTES, 1) * MAX_WALK_PENALTY;
  return Math.max(base - walkPenalty, 0);
}

/**
 * How much food is within walking distance, and how close it is — not
 * quality, since almost none of the underlying data carries a rating. This
 * is a gate, not a ranking term: a station scoring below the user's
 * threshold stays in the results but is flagged.
 */
export function foodScore(food: FoodSpot[]): number {
  if (food.length === 0) return 0;
  const scored = food.map(spotScore).sort((a, b) => b - a);
  const variety =
    Math.min(scored.length - 1, MAX_VARIETY_SPOTS) * VARIETY_BONUS_PER_SPOT;
  return Math.round(Math.min(scored[0] + variety, 100));
}

export function bestFoodSpot(food: FoodSpot[]): FoodSpot | null {
  if (food.length === 0) return null;
  return food.reduce((best, spot) =>
    spotScore(spot) > spotScore(best) ? spot : best,
  );
}

/**
 * Every criterion scores against a fixed scale, never against the other
 * stations in the list.
 *
 * Scores used to be min-max normalised over whatever the filters had left,
 * which made them move when the filters did: a DC site scoring 84 among DC
 * sites dropped to the 50s once AC sites joined the pool and pulled the price
 * floor down, and then fell out of the top 50 — so switching the connector
 * from "DC fast" to "All" made a station disappear rather than merely gain
 * company. A fixed scale means a station's score is a fact about the station,
 * and the same number appears whichever filter it is seen through.
 */

/** Anything at or above this is "as fast as it gets" for a car today. */
const TOP_SPEED_KW = 350;
/** Slowest useful wall charging; the floor of the log scale. */
const FLOOR_SPEED_KW = 3.7;

/**
 * Logarithmic, because that is how the difference feels from the driver's
 * seat: 11 → 22 kW halves the wait just as 150 → 300 kW does, and a linear
 * scale would give every AC site a single-digit score and no ordering at all.
 */
function speedScore(kw: number): number {
  if (kw < FLOOR_SPEED_KW) return 0;
  const t =
    Math.log(Math.min(kw, TOP_SPEED_KW) / FLOOR_SPEED_KW) /
    Math.log(TOP_SPEED_KW / FLOOR_SPEED_KW);
  return Math.round(t * 100);
}

/** CHF per kWh; the cheapest and dearest public tariffs in the feed's estimates. */
const CHEAP_PRICE = 0.3;
const DEAR_PRICE = 0.8;

function priceScore(chfPerKwh: number): number {
  return Math.round(
    clamp01(1 - (chfPerKwh - CHEAP_PRICE) / (DEAR_PRICE - CHEAP_PRICE)) * 100,
  );
}

/** Effective stalls (stalls × uptime) at which a site counts as always free. */
const PLENTY_OF_STALLS = 8;

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

/** 100 at the reference point, falling linearly to 0 at `worst`. */
function fallOff(value: number, worst: number): number {
  return Math.round(clamp01(1 - value / worst) * 100);
}

function availabilityValue(station: ChargingStation): number {
  return (
    station.stalls *
    ((station.reliabilityPct ?? ASSUMED_RELIABILITY_PCT) / 100)
  );
}

export function rankStations(
  stations: ChargingStation[],
  options: RankingOptions,
): RankedStation[] {
  if (stations.length === 0) return [];

  const columns: Partial<Record<Criterion, number[]>> = {};
  if (options.criteria.includes("speed")) {
    columns.speed = stations.map((s) => speedScore(s.maxPowerKw));
  }
  if (options.criteria.includes("price")) {
    columns.price = stations.map((s) => priceScore(s.pricePerKwh));
  }
  if (options.criteria.includes("green")) {
    // Stations from a run where the greenery lookup failed score null; they sit
    // at the bottom rather than being dropped, since the site may well be leafy.
    columns.green = stations.map((s) => s.greenScore ?? 0);
  }
  if (options.criteria.includes("availability")) {
    columns.availability = stations.map((s) =>
      Math.round(clamp01(availabilityValue(s) / PLENTY_OF_STALLS) * 100),
    );
  }
  if (options.criteria.includes("detour") && options.detourKm) {
    const { detourKm, maxDetourKm = 1 } = options;
    columns.detour = stations.map((s) =>
      fallOff(detourKm.get(s.id) ?? 0, maxDetourKm),
    );
  }
  if (options.criteria.includes("nearby") && options.distanceKm) {
    // A site the feed labels with the searched town is included however far
    // out it sits, so beyond the radius the score is simply 0.
    const { distanceKm, radiusKm = 1 } = options;
    columns.nearby = stations.map((s) =>
      fallOff(distanceKm.get(s.id) ?? 0, radiusKm),
    );
  }
  if (options.criteria.includes("middle") && options.routeProgress) {
    const { routeProgress, stopAt = 0.5 } = options;
    // Distance from the chosen stop point as a fraction of the route. The
    // slope is fixed at "half the route away scores 0" whatever the target,
    // so moving the slider shifts the peak without changing what a 10-km
    // miss costs.
    columns.middle = stations.map((s) =>
      fallOff(Math.abs((routeProgress.get(s.id) ?? stopAt) - stopAt), 0.5),
    );
  }

  const ranked = stations.map((station, index) => {
    const breakdown: Partial<Record<Criterion, number>> = {};
    for (const criterion of options.criteria) {
      const column = columns[criterion];
      if (column) breakdown[criterion] = column[index];
    }

    const parts = Object.values(breakdown);
    const score = parts.length
      ? Math.round(parts.reduce((sum, value) => sum + value, 0) / parts.length)
      : 0;
    const food = foodScore(station.food);
    // null means the amenity lookup never ran; undefined means the record simply
    // carries its spots inline. Only the former should suppress the food flag.
    const foodKnown = station.foodCount !== null;

    return {
      station,
      score,
      foodScore: food,
      bestFood: bestFoodSpot(station.food),
      foodKnown,
      belowFoodThreshold: foodKnown && food < options.foodThreshold,
      breakdown,
    };
  });

  return ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.foodScore - a.foodScore;
  });
}
