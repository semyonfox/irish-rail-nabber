import { useCallback, useEffect, useMemo, useState } from "react";
import * as maplibregl from "maplibre-gl";

import type { DelayStretch } from "../graphql/insights";
import { useTheme } from "../theme";
import {
  applyIrelandMapTheme,
  createIrelandMap,
  emptyCollection,
  setSourceData,
  transitMapPalette,
} from "./transitMap";
import { ChartLegend, Empty } from "./ui";

const SOURCE = "delay-stretches";
const CASING = "delay-stretch-casing";
const LINE = "delay-stretch-line";
const bands = [
  { label: "Under 60 min", light: "#08746d", dark: "#4ad4c2" },
  { label: "60 to under 300 min", light: "#ad6200", dark: "#f9ae48" },
  { label: "300 min or more", light: "#bd294b", dark: "#ff6f90" },
];

function endpoint(lat: number | null, lon: number | null): [number, number] | null {
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return [lon, lat];
}

function plotLines(stretches: DelayStretch[]) {
  return stretches.flatMap((stretch) => {
    const from = endpoint(stretch.fromLat, stretch.fromLon);
    const to = endpoint(stretch.toLat, stretch.toLon);
    if (!from || !to || (from[0] === to[0] && from[1] === to[1])) return [];
    return [{ from, to, minutes: stretch.addedMinutes }];
  });
}

export default function DelayStretchMap({ stretches }: { stretches: DelayStretch[] }) {
  const { theme } = useTheme();
  const [initialTheme] = useState(theme);
  const [readyMap, setReadyMap] = useState<maplibregl.Map | null>(null);
  const [mapError, setMapError] = useState(false);
  const lines = useMemo(() => plotLines(stretches), [stretches]);

  const attachMap = useCallback(
    (container: HTMLDivElement | null) => {
      if (!container) return;
      let map: maplibregl.Map;
      try {
        map = createIrelandMap(container, initialTheme);
      } catch {
        setMapError(true);
        return;
      }
      map.addControl(new maplibregl.NavigationControl(), "top-right");
      map.scrollZoom.disable();
      map.once("style.load", () => {
        map.addSource(SOURCE, { type: "geojson", data: emptyCollection() });
        map.addLayer({
          id: CASING,
          source: SOURCE,
          type: "line",
          layout: { "line-cap": "round" },
          paint: { "line-width": 7, "line-offset": 3 },
        });
        map.addLayer({
          id: LINE,
          source: SOURCE,
          type: "line",
          layout: { "line-cap": "round" },
          paint: { "line-width": 4, "line-offset": 3 },
        });
        setReadyMap(map);
      });
      return () => map.remove();
    },
    [initialTheme],
  );

  useEffect(() => {
    if (!readyMap) return;
    applyIrelandMapTheme(readyMap, theme);
    readyMap.setPaintProperty(CASING, "line-color", transitMapPalette(theme).casing);
    readyMap.setPaintProperty(LINE, "line-color", [
      "step",
      ["get", "minutes"],
      bands[0][theme],
      60,
      bands[1][theme],
      300,
      bands[2][theme],
    ]);
  }, [readyMap, theme]);

  useEffect(() => {
    if (!readyMap) return;
    const bounds = new maplibregl.LngLatBounds();
    const features = lines
      .map(({ from, to, minutes }) => {
        bounds.extend(from).extend(to);
        return {
          type: "Feature" as const,
          geometry: { type: "LineString" as const, coordinates: [from, to] },
          properties: { minutes },
        };
      })
      .reverse();
    setSourceData(readyMap, SOURCE, { type: "FeatureCollection", features });
    if (!bounds.isEmpty()) readyMap.fitBounds(bounds, { padding: 38, maxZoom: 14, duration: 0 });
  }, [readyMap, lines]);

  return (
    <section className="card min-w-0 overflow-hidden" aria-labelledby="insights-map-heading">
      <div className="card-head">
        <div>
          <h2 id="insights-map-heading" className="card-title">
            Where delay is added
          </h2>
          <p className="card-desc">Straight lines connect the stops in each ranked stretch.</p>
        </div>
      </div>
      <div className="px-4">
        <ChartLegend items={bands.map((band) => ({ label: band.label, color: band[theme] }))} />
      </div>
      {mapError ? (
        <Empty>Map unavailable. All stretches are listed below.</Empty>
      ) : (
        <div ref={attachMap} className="h-75 w-full bg-(--map-bg) sm:h-105" />
      )}
      {lines.length < stretches.length ? (
        <p className="border-t border-line px-4 py-3 text-sm text-ink-2">
          Showing {lines.length} of {stretches.length} stretches with distinct, known endpoints.
        </p>
      ) : null}
    </section>
  );
}
