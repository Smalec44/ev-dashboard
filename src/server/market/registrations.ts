import type { RegistrationYear } from "../../lib/types.ts";

/**
 * New passenger-car registrations by fuel type and year, from the Federal
 * Statistical Office's PXWeb API (cube px-x-1103020200_121). Annual, and a
 * year behind: the cube is updated each February with the previous year.
 * No monthly cube with a fuel split exists in the API, so this is as fresh
 * as the official figure gets.
 */
const CUBE_URL =
  "https://www.pxweb.bfs.admin.ch/api/v1/de/px-x-1103020200_121/px-x-1103020200_121.px";
const PASSENGER_CARS = "100";
const BATTERY_ELECTRIC = "500";
const YEARS = 6;

interface PxRow {
  key: string[];
  values: string[];
}

interface PxResponse {
  columns: { code: string; type: string }[];
  data: PxRow[];
}

const QUERY = {
  query: [
    { code: "Fahrzeuggruppe", selection: { filter: "item", values: [PASSENGER_CARS] } },
    { code: "Treibstoff", selection: { filter: "all", values: ["*"] } },
    { code: "Jahr", selection: { filter: "top", values: [String(YEARS)] } },
  ],
  response: { format: "json" },
};

/** Folds the per-fuel rows into one total and one BEV count per year. */
export function summariseRegistrations(response: PxResponse): RegistrationYear[] {
  const fuelIndex = response.columns.findIndex((c) => c.code === "Treibstoff");
  const yearIndex = response.columns.findIndex((c) => c.code === "Jahr");
  if (fuelIndex < 0 || yearIndex < 0) throw new Error("unexpected column layout");
  const byYear = new Map<number, RegistrationYear>();
  for (const row of response.data) {
    const year = Number(row.key[yearIndex]);
    const count = Number(row.values[0]);
    if (!Number.isFinite(year) || !Number.isFinite(count)) continue;
    const entry = byYear.get(year) ?? { year, bev: 0, total: 0 };
    entry.total += count;
    if (row.key[fuelIndex] === BATTERY_ELECTRIC) entry.bev += count;
    byYear.set(year, entry);
  }
  return [...byYear.values()].sort((a, b) => a.year - b.year);
}

export async function fetchRegistrations(): Promise<RegistrationYear[]> {
  const res = await fetch(CUBE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(QUERY),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`BFS returned ${res.status}`);
  // The API prefixes its JSON with a byte-order mark.
  const text = (await res.text()).replace(/^﻿/, "");
  return summariseRegistrations(JSON.parse(text) as PxResponse);
}
