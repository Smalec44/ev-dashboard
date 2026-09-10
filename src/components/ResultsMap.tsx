"use client";

import "leaflet/dist/leaflet.css";
import type * as LeafletModule from "leaflet";
import type { LayerGroup, Map as LeafletMap } from "leaflet";
import { useEffect, useRef, useState } from "react";
import type { RankedStation } from "@/lib/ranking";
import type { LatLon } from "@/lib/types";

type Leaflet = typeof LeafletModule;

interface Engine {
  L: Leaflet;
  map: LeafletMap;
  marks: LayerGroup;
}

export interface MapRoute {
  from: LatLon & { city: string };
  to: LatLon & { city: string };
  /** 0–1 along the direct line: where the driver wants the break. */
  stopAt: number;
}

export interface MapArea {
  centre: LatLon & { city: string };
  radiusKm: number;
}

/** The first few stops get bigger dots, so the top of the list reads on the map. */
const HIGHLIGHTED_STOPS = 3;

/**
 * The results on a map: the direct line with its ends and the planned break,
 * or the searched town with its radius, plus one dot per ranked stop.
 *
 * Leaflet reads `window` on import, so it is loaded inside an effect rather
 * than at module level, and the page renders the same on the server with an
 * empty box where the map will be.
 */
export function ResultsMap({
  route,
  area,
  stops,
}: {
  route?: MapRoute;
  area?: MapArea;
  stops: RankedStation[];
}) {
  const container = useRef<HTMLDivElement>(null);
  // State rather than refs: the drawing effects key on the instance, so a
  // remount (which creates a new map) redraws and refits on its own.
  const [engine, setEngine] = useState<Engine | null>(null);

  useEffect(() => {
    let cancelled = false;
    let instance: LeafletMap | null = null;
    void import("leaflet").then((L) => {
      if (cancelled || !container.current) return;
      instance = L.map(container.current, {
        // The page scrolls past the map; hijacking the wheel would trap it.
        scrollWheelZoom: false,
        // Whole-number zooms are too coarse for a fit: a 150 km route lands
        // on the level that shows Munich to Lyon. Quarter steps fit it snugly.
        zoomSnap: 0.25,
      });
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(instance);
      setEngine({ L, map: instance, marks: L.layerGroup().addTo(instance) });
    });
    return () => {
      cancelled = true;
      instance?.remove();
      setEngine(null);
    };
  }, []);

  // Frame the search, not the stops: the view should stay put while the
  // ranking criteria shuffle the dots around inside it.
  useEffect(() => {
    if (!engine) return;
    const { L, map: instance } = engine;
    // The box may have been resized since the map measured it.
    instance.invalidateSize();
    if (route) {
      instance.fitBounds(
        L.latLngBounds(
          [route.from.lat, route.from.lon],
          [route.to.lat, route.to.lon],
        ),
        { padding: [32, 32] },
      );
    } else if (area) {
      instance.fitBounds(
        L.latLng(area.centre.lat, area.centre.lon).toBounds(area.radiusKm * 2000),
        { padding: [16, 16] },
      );
    }
  }, [engine, route, area]);

  useEffect(() => {
    if (!engine || !container.current) return;
    const { L, marks: layer } = engine;
    layer.clearLayers();

    const styles = getComputedStyle(container.current);
    const accent = styles.getPropertyValue("--accent").trim() || "#0f7a5a";
    const foreground = styles.getPropertyValue("--foreground").trim() || "#12161c";

    const endpoint = (point: LatLon & { city: string }) =>
      L.circleMarker([point.lat, point.lon], {
        radius: 7,
        color: "#fff",
        weight: 2,
        fillColor: foreground,
        fillOpacity: 1,
      })
        .bindTooltip(point.city, { permanent: true, direction: "top", offset: [0, -8] })
        .addTo(layer);

    if (route) {
      const a: [number, number] = [route.from.lat, route.from.lon];
      const b: [number, number] = [route.to.lat, route.to.lon];
      // Straight, like every distance in the app — this is the line the
      // detours are measured from, not a suggestion of the road.
      L.polyline([a, b], { color: foreground, weight: 3, dashArray: "8 8", opacity: 0.8 }).addTo(layer);
      L.circleMarker(
        [
          a[0] + (b[0] - a[0]) * route.stopAt,
          a[1] + (b[1] - a[1]) * route.stopAt,
        ],
        { radius: 9, color: accent, weight: 2, dashArray: "3 3", fillOpacity: 0 },
      )
        .bindTooltip("Planned break", { direction: "bottom", offset: [0, 8] })
        .addTo(layer);
      endpoint(route.from);
      endpoint(route.to);
    }

    if (area) {
      L.circle([area.centre.lat, area.centre.lon], {
        radius: area.radiusKm * 1000,
        color: accent,
        weight: 1,
        fillColor: accent,
        fillOpacity: 0.06,
      }).addTo(layer);
      endpoint(area.centre);
    }

    // Reverse order so the best stop is drawn last, on top of the crowd.
    [...stops].reverse().forEach((stop, reverseIndex) => {
      const rank = stops.length - reverseIndex;
      const top = rank <= HIGHLIGHTED_STOPS;
      L.circleMarker([stop.station.lat, stop.station.lon], {
        radius: top ? 8 : 5,
        color: top ? "#fff" : accent,
        weight: top ? 2 : 1,
        fillColor: accent,
        fillOpacity: top ? 1 : 0.55,
      })
        .bindTooltip(`#${rank} ${stop.station.name} · ${stop.score}`, {
          direction: "top",
          offset: [0, -6],
        })
        .addTo(layer);
    });
  }, [engine, route, area, stops]);

  return (
    <div
      ref={container}
      // Leaflet stacks its panes at z-index 400; an isolated stacking context
      // keeps them under the combobox dropdown and any future overlays.
      className="relative z-0 h-80 w-full overflow-hidden rounded-xl border border-border bg-surface-muted sm:h-[30rem]"
      role="img"
      aria-label={
        route
          ? `Map of the route from ${route.from.city} to ${route.to.city} with the ranked charging stops`
          : area
            ? `Map of charging stations around ${area.centre.city}`
            : "Map of charging stations"
      }
    />
  );
}
