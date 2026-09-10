/**
 * The share of the WLTP figure a car manages on a Swiss motorway trip. WLTP
 * is a lab cycle with a lot of town driving; at 120 km/h, with heating or air
 * conditioning on, most cars get about four fifths of it.
 */
export const REAL_WORLD_SHARE = 0.8;

/**
 * Km the car covers on its current charge: its WLTP range, scaled by the
 * battery level and by real-world motorway driving. Nonsense in, 0 out.
 */
export function rangeKm(wltpKm: number, batteryPct: number): number {
  const wltp = Number.isFinite(wltpKm) ? Math.max(wltpKm, 0) : 0;
  const battery = Number.isFinite(batteryPct) ? Math.min(Math.max(batteryPct, 0), 100) : 0;
  return wltp * (battery / 100) * REAL_WORLD_SHARE;
}
