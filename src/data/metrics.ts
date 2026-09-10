import type { ChargingStation } from "@/lib/types";

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
