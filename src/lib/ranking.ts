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
    label: "Near the middle",
    hint: "Closer to halfway between the two places ranks first",
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
  /** Position along the route, 0–1; required when "middle" is a criterion. */
  routeProgress?: Map<string, number>;
  /** Km from the searched centre; required when "nearby" is among the criteria. */
  distanceKm?: Map<string, number>;
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

function normalize(values: number[], higherIsBetter: boolean): number[] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 100);
  return values.map((value) => {
    const t = (value - min) / (max - min);
    return Math.round((higherIsBetter ? t : 1 - t) * 100);
  });
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
    columns.speed = normalize(
      stations.map((s) => s.maxPowerKw),
      true,
    );
  }
  if (options.criteria.includes("price")) {
    columns.price = normalize(
      stations.map((s) => s.pricePerKwh),
      false,
    );
  }
  if (options.criteria.includes("green")) {
    // Stations from a run where the greenery lookup failed score null; they sit
    // at the bottom rather than being dropped, since the site may well be leafy.
    columns.green = normalize(
      stations.map((s) => s.greenScore ?? 0),
      true,
    );
  }
  if (options.criteria.includes("availability")) {
    columns.availability = normalize(stations.map(availabilityValue), true);
  }
  if (options.criteria.includes("detour") && options.detourKm) {
    const { detourKm } = options;
    columns.detour = normalize(
      stations.map((s) => detourKm.get(s.id) ?? 0),
      false,
    );
  }
  if (options.criteria.includes("nearby") && options.distanceKm) {
    const { distanceKm } = options;
    columns.nearby = normalize(
      stations.map((s) => distanceKm.get(s.id) ?? 0),
      false,
    );
  }
  if (options.criteria.includes("middle") && options.routeProgress) {
    const { routeProgress } = options;
    // Distance from the halfway point: 0 is dead centre, 0.5 is an endpoint.
    columns.middle = normalize(
      stations.map((s) => Math.abs((routeProgress.get(s.id) ?? 0.5) - 0.5)),
      false,
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
