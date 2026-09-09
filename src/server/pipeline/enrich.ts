/**
 * The OpenStreetMap passes over a set of sites — food, green, parking — with
 * each pass failing on its own, so a rate-limited Overpass costs one facet
 * and not the run.
 */
import {
  attachFood,
  attachGreen,
  attachParking,
  clearFood,
  clearGreen,
  FOOD_RADIUS_M,
  GREEN_RADIUS_M,
  PARKING_MATCH_M,
} from "./attach.ts";
import type { Site } from "./feed.ts";
import { cellBboxes } from "./geo.ts";
import { fetchFood, fetchGreen, fetchParking, type OverpassOptions } from "./overpass.ts";

export interface EnrichOptions {
  food?: boolean;
  green?: boolean;
  parking?: boolean;
  /** Where to look for parking tags: the sites' cells, or one national query. */
  parkingScope?: "cells" | "country";
  /** Run the three passes at once rather than one after the other. */
  parallel?: boolean;
  overpass?: OverpassOptions;
  log?: (message: string) => void;
}

export interface EnrichResult {
  foodAvailable: boolean;
  greenAvailable: boolean;
  parkingAvailable: boolean;
  /** One line per pass that failed, for the log or the response. */
  errors: string[];
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export async function enrich(sites: Site[], options: EnrichOptions = {}): Promise<EnrichResult> {
  const log = options.log ?? (() => {});
  const overpass = { ...options.overpass, log: options.overpass?.log ?? log };
  const bboxes = cellBboxes(sites);
  const result: EnrichResult = {
    foodAvailable: options.food !== false,
    greenAvailable: options.green !== false,
    parkingAvailable: options.parking !== false,
    errors: [],
  };

  const foodPass = async () => {
    if (options.food === false) {
      clearFood(sites);
      log("Skipping food POIs.\n");
      return;
    }
    try {
      log("Fetching food POIs from Overpass… ");
      const food = await fetchFood(bboxes, overpass);
      attachFood(sites, food);
      const withFood = sites.filter((s) => (s.foodCount ?? 0) > 0).length;
      log(`${food.length} POIs\n  ${withFood}/${sites.length} sites with food within ${FOOD_RADIUS_M} m\n`);
    } catch (error) {
      result.foodAvailable = false;
      clearFood(sites);
      result.errors.push(`food: ${message(error)}`);
      log(`\n  Overpass unavailable for food (${message(error)}).\n`);
    }
  };

  const greenPass = async () => {
    if (options.green === false) {
      clearGreen(sites);
      log("Skipping green spaces.\n");
      return;
    }
    try {
      log("Fetching green spaces from Overpass… ");
      const areas = await fetchGreen(bboxes, overpass);
      attachGreen(sites, areas);
      const scored = sites.filter((s) => (s.greenScore ?? 0) > 0);
      const mean = scored.reduce((sum, s) => sum + (s.greenScore ?? 0), 0) / (scored.length || 1);
      log(
        `${areas.length} areas\n  ${scored.length}/${sites.length} sites with green space within ` +
          `${GREEN_RADIUS_M} m (mean score ${Math.round(mean)})\n`,
      );
    } catch (error) {
      result.greenAvailable = false;
      clearGreen(sites);
      result.errors.push(`green: ${message(error)}`);
      log(`\n  Overpass unavailable for green spaces (${message(error)}).\n`);
    }
  };

  const parkingPass = async () => {
    if (options.parking === false) {
      log("Skipping parking terms.\n");
      return;
    }
    try {
      log("Fetching parking terms from Overpass… ");
      const scope = options.parkingScope === "country" ? "country" : bboxes;
      const points = await fetchParking(scope, overpass);
      const matched = attachParking(sites, points);
      log(
        `${points.length} tagged chargers, ${matched}/${sites.length} sites matched within ${PARKING_MATCH_M} m\n`,
      );
    } catch (error) {
      result.parkingAvailable = false;
      result.errors.push(`parking: ${message(error)}`);
      log(`\n  Overpass unavailable for parking terms (${message(error)}).\n`);
    }
  };

  if (options.parallel) {
    await Promise.all([foodPass(), greenPass(), parkingPass()]);
  } else {
    await foodPass();
    await greenPass();
    await parkingPass();
  }
  return result;
}
