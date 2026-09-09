import type { ChargingStation, NationalMetrics } from "@/lib/types";

const MONTHLY_REGISTRATIONS_2026: NationalMetrics["monthlyRegistrations"] = [
  { month: "Jan", value: 3_740 },
  { month: "Feb", value: 3_990 },
  { month: "Mar", value: 5_120 },
  { month: "Apr", value: 4_560 },
  { month: "May", value: 4_830 },
  { month: "Jun", value: 5_390 },
  { month: "Jul", value: 4_510 },
  { month: "Aug", value: 4_240 },
  { month: "Sep", value: 1_180, partial: true },
];

export const NATIONAL_METRICS: NationalMetrics = {
  year: 2026,
  asOf: "2026-09-09",
  periodLabel: "Jan–Sep 2026, year to date",
  newEvsSold: MONTHLY_REGISTRATIONS_2026.reduce((sum, m) => sum + m.value, 0),
  newEvsSoldChangePct: 7.4,
  evShareOfNewCarsPct: 21.8,
  averageEvPriceChf: 56_900,
  averageEvPriceChangePct: -2.6,
  averageAcPricePerKwh: 0.44,
  averageAcPriceChangePct: 2.3,
  averageDcPricePerKwh: 0.66,
  averageDcPriceChangePct: 3.1,
  monthlyRegistrations: MONTHLY_REGISTRATIONS_2026,
};

export interface ConnectorPriceSummary {
  ac: number | null;
  dc: number | null;
}

function averagePrice(
  stations: ChargingStation[],
  connector: "AC" | "DC",
): number | null {
  const matching = stations.filter((s) => s.connectorType === connector);
  if (matching.length === 0) return null;
  const total = matching.reduce((sum, s) => sum + s.pricePerKwh, 0);
  return total / matching.length;
}

export function connectorPrices(
  stations: ChargingStation[],
): ConnectorPriceSummary {
  return {
    ac: averagePrice(stations, "AC"),
    dc: averagePrice(stations, "DC"),
  };
}
