import * as maplibregl from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

import type { Theme } from "../theme";

export type SourceData = Parameters<maplibregl.GeoJSONSource["setData"]>[0];
export type FeatureProperties = Record<string, string | number | boolean | null>;
export type TransitFeature = Record<string, unknown>;

maplibregl.setWorkerUrl(maplibreWorkerUrl);

export interface TransitMapPalette {
  background: string;
  rasterOpacity: number;
  rasterSaturation: number;
  rasterContrast: number;
  rasterBrightnessMin: number;
  rasterBrightnessMax: number;
  ink: string;
  brand: string;
  bus: string;
  track: string;
  casing: string;
  point: string;
  pointBorder: string;
  label: string;
  labelHalo: string;
}

const MAP_PALETTES = {
  light: {
    background: "#e9ebe6",
    rasterOpacity: 1,
    rasterSaturation: -0.9,
    rasterContrast: -0.25,
    rasterBrightnessMin: 0.3,
    rasterBrightnessMax: 0.98,
    ink: "#121814",
    brand: "#0b6b4d",
    bus: "#d88a05",
    track: "#8fa197",
    casing: "#ffffff",
    point: "#ffffff",
    pointBorder: "#56615b",
    label: "#3d4540",
    labelHalo: "#ffffff",
  },
  dark: {
    background: "#111713",
    rasterOpacity: 0.78,
    rasterSaturation: -1,
    rasterContrast: 0.08,
    rasterBrightnessMin: 0.03,
    rasterBrightnessMax: 0.34,
    ink: "#f2f0e9",
    brand: "#58c99b",
    bus: "#f0aa2a",
    track: "#71867a",
    casing: "#101512",
    point: "#e8ede9",
    pointBorder: "#718078",
    label: "#e5e9e5",
    labelHalo: "#101512",
  },
} as const satisfies Record<Theme, TransitMapPalette>;

export function transitMapPalette(theme: Theme): TransitMapPalette {
  return MAP_PALETTES[theme];
}

export function applyIrelandMapTheme(map: maplibregl.Map, theme: Theme) {
  const palette = transitMapPalette(theme);
  if (map.getLayer("paper-background")) {
    map.setPaintProperty("paper-background", "background-color", palette.background);
  }
  if (map.getLayer("osm")) {
    map.setPaintProperty("osm", "raster-opacity", palette.rasterOpacity);
    map.setPaintProperty("osm", "raster-saturation", palette.rasterSaturation);
    map.setPaintProperty("osm", "raster-contrast", palette.rasterContrast);
    map.setPaintProperty("osm", "raster-brightness-min", palette.rasterBrightnessMin);
    map.setPaintProperty("osm", "raster-brightness-max", palette.rasterBrightnessMax);
  }
}

export function createIrelandMap(container: HTMLElement, theme: Theme) {
  const palette = transitMapPalette(theme);
  return new maplibregl.Map({
    container,
    attributionControl: { compact: true },
    style: {
      version: 8,
      glyphs: "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf",
      sources: {
        osm: {
          type: "raster",
          tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
          tileSize: 256,
          attribution: "&copy; OpenStreetMap contributors",
        },
      },
      layers: [
        {
          id: "paper-background",
          type: "background",
          paint: { "background-color": palette.background },
        },
        {
          id: "osm",
          type: "raster",
          source: "osm",
          paint: {
            "raster-opacity": palette.rasterOpacity,
            "raster-saturation": palette.rasterSaturation,
            "raster-contrast": palette.rasterContrast,
            "raster-brightness-min": palette.rasterBrightnessMin,
            "raster-brightness-max": palette.rasterBrightnessMax,
          },
        },
      ],
    },
    center: [-7.5, 53.4],
    zoom: 7,
    maxBounds: [
      [-12, 50.5],
      [-4, 56],
    ],
  });
}

export function emptyCollection(): SourceData {
  return { type: "FeatureCollection", features: [] } as unknown as SourceData;
}

export function pointFeature(
  coordinates: [number, number],
  properties: FeatureProperties,
): TransitFeature {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates },
    properties,
  };
}

export function featureCollection(features: TransitFeature[]): SourceData {
  return { type: "FeatureCollection", features } as unknown as SourceData;
}

export function setSourceData(map: maplibregl.Map, id: string, data: SourceData) {
  const source = map.getSource(id) as maplibregl.GeoJSONSource | undefined;
  source?.setData(data);
}
