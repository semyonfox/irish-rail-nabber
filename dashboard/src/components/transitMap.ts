import * as maplibregl from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

export type SourceData = Parameters<maplibregl.GeoJSONSource["setData"]>[0];
export type FeatureProperties = Record<string, string | number | boolean | null>;
export type TransitFeature = Record<string, unknown>;

maplibregl.setWorkerUrl(maplibreWorkerUrl);

export function createIrelandMap(container: HTMLElement) {
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
          paint: { "background-color": "#e9ebe6" },
        },
        {
          id: "osm",
          type: "raster",
          source: "osm",
          paint: {
            "raster-opacity": 1,
            "raster-saturation": -0.9,
            "raster-contrast": -0.25,
            "raster-brightness-min": 0.3,
            "raster-brightness-max": 0.98,
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
