/**
 * Joins the OpenStreetMap results onto the sites by distance. Pure functions:
 * everything network-related lives in overpass.ts.
 */
import { haversineMetres, metresToBounds } from "./geo.ts";
import type { Site } from "./feed.ts";
import type { FoodPoi, GreenArea, ParkingPoint } from "./overpass.ts";
import type { FoodSpot } from "../../lib/types.ts";

export const FOOD_RADIUS_M = 400;
const MAX_FOOD_PER_STATION = 6;
const WALK_METRES_PER_MINUTE = 80;

export function attachFood(sites: Site[], food: FoodPoi[]): void {
  for (const site of sites) {
    const nearby: { spot: FoodPoi; distance: number }[] = [];
    for (const spot of food) {
      const distance = haversineMetres(site, spot);
      if (distance <= FOOD_RADIUS_M) nearby.push({ spot, distance });
    }
    nearby.sort((a, b) => a.distance - b.distance);
    site.food = nearby.slice(0, MAX_FOOD_PER_STATION).map(({ spot, distance }) => {
      const entry: FoodSpot = {
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

/** The lookup never ran, or failed: distinct from "nothing nearby". */
export function clearFood(sites: Site[]): void {
  for (const site of sites) {
    site.food = [];
    site.foodCount = null;
  }
}

export const GREEN_RADIUS_M = 400;
const MAX_GREEN_PER_STATION = 3;
// Matches foodScore's bonus. At 6 the cap flattened 43% of the country onto
// 90-100; the nearest space should carry the score, not the count.
const GREEN_VARIETY_BONUS = 4;
const MAX_GREEN_VARIETY = 3;

/**
 * 0–100 for how green the immediate surroundings are: the best nearby space
 * carries the score, with a small bonus for having several. Same shape as
 * foodScore, so the two read the same way on a card.
 */
export function attachGreen(sites: Site[], areas: GreenArea[]): void {
  for (const site of sites) {
    const nearby: { area: GreenArea; distance: number; value: number }[] = [];
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
    const best = nearby[0];
    if (best === undefined) continue;
    const variety = Math.min(nearby.length - 1, MAX_GREEN_VARIETY) * GREEN_VARIETY_BONUS;
    site.greenScore = Math.round(Math.min(best.value + variety, 100));
    site.green = nearby.slice(0, MAX_GREEN_PER_STATION).map(({ area, distance }) => ({
      name: area.name,
      category: area.category,
      distanceMetres: Math.round(distance),
    }));
  }
}

export function clearGreen(sites: Site[]): void {
  for (const site of sites) {
    site.green = [];
    site.greenScore = null;
  }
}

export const PARKING_MATCH_M = 75;

/** Nearest tagged OSM charger within reach; returns how many sites matched. */
export function attachParking(sites: Site[], points: ParkingPoint[]): number {
  let matched = 0;
  for (const site of sites) {
    let best: ParkingPoint | null = null;
    let bestDistance = PARKING_MATCH_M;
    for (const point of points) {
      const distance = haversineMetres(site, point);
      if (distance <= bestDistance) {
        best = point;
        bestDistance = distance;
      }
    }
    if (best) {
      site.parking = best.parking;
      matched += 1;
    } else {
      delete site.parking;
    }
  }
  return matched;
}
