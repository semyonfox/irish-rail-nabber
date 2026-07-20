import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import { LIVE_TRAINS, STATIONS, TRAIN_JOURNEY } from "../graphql/queries";
import { usePollingQuery } from "../utils/usePollingQuery";
import { loadRailLines, trackPathThrough, type RailCoordinate } from "../utils/railGeometry";

interface Train {
  trainCode: string;
  latitude: number | null;
  longitude: number | null;
  trainStatus: string | null;
  direction: string | null;
  trainType: string | null;
  fetchedAt: string | null;
}

interface Station {
  stationCode: string;
  stationDesc: string;
  stationType: string | null;
  isDart: boolean | null;
  latitude: number | null;
  longitude: number | null;
}

interface Movement {
  locationCode: string | null;
  locationFullName: string | null;
  locationOrder: number;
}

interface TrainsData {
  liveTrains: Train[];
}

interface StationsData {
  stations: Station[];
}

interface TrainJourneyData {
  trainJourney: Movement[];
}

export interface MapStationSelection {
  stationCode: string;
  stationDesc: string;
  stationType: string | null;
  isDart: boolean | null;
  latitude: number;
  longitude: number;
}

export interface MapRouteSelection {
  fromStationCode: string;
  fromStationName: string;
  toStationCode: string;
  toStationName: string;
  trainCount: number;
  lastSeen: string | null;
}

interface Props {
  selectedTrainCode?: string | null;
  selectedStationCode?: string | null;
  onTrainClick?: (trainCode: string) => void;
  onStationClick?: (station: MapStationSelection) => void;
  onRouteClick?: (route: MapRouteSelection) => void;
}

type SourceData = Parameters<maplibregl.GeoJSONSource["setData"]>[0];
type FeatureProperties = Record<string, string | number | boolean | null>;

const IRELAND_CENTER: [number, number] = [-7.5, 53.4];
const POLL_MS = 5000;
const ROUTE_SOURCE_ID = "route-segments";
const SELECTED_ROUTE_SOURCE_ID = "selected-train-route";
const SELECTED_STOP_SOURCE_ID = "selected-train-stops";
const STATION_SOURCE_ID = "stations";
const TRAIN_SOURCE_ID = "live-trains";
const ROUTE_LAYER_ID = "route-segments-line";
const ROUTE_HIT_LAYER_ID = "route-segments-hit";
const SELECTED_ROUTE_LAYER_ID = "selected-train-route-line";
const SELECTED_STOP_LAYER_ID = "selected-train-stops-circle";
const STATION_LAYER_ID = "stations-circle";
const STATION_LABEL_LAYER_ID = "stations-label";
const TRAIN_HALO_LAYER_ID = "live-trains-halo";
const TRAIN_LAYER_ID = "live-trains-circle";
const TRAIN_LABEL_LAYER_ID = "live-trains-label";
const STATION_RADIUS = [
  "case",
  ["get", "selected"],
  7,
  4,
] as unknown as maplibregl.ExpressionSpecification;

function emptyCollection(): SourceData {
  return { type: "FeatureCollection", features: [] } as unknown as SourceData;
}

function pointFeature(
  coordinates: [number, number],
  properties: FeatureProperties,
): Record<string, unknown> {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates },
    properties,
  };
}

function lineFeature(
  coordinates: [number, number][],
  properties: FeatureProperties,
): Record<string, unknown> {
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates },
    properties,
  };
}

function featureCollection(features: Record<string, unknown>[]): SourceData {
  return { type: "FeatureCollection", features } as unknown as SourceData;
}

function getSource(map: maplibregl.Map, id: string): maplibregl.GeoJSONSource | undefined {
  return map.getSource(id) as maplibregl.GeoJSONSource | undefined;
}

function setSourceData(map: maplibregl.Map, id: string, data: SourceData) {
  getSource(map, id)?.setData(data);
}

function formatType(type: string | null) {
  if (type === "D") return "DART";
  if (type === "M") return "Mainline";
  if (type === "S") return "Suburban";
  return type || "Rail";
}

export default function TrainMap({
  selectedTrainCode,
  selectedStationCode,
  onTrainClick,
  onStationClick,
  onRouteClick,
}: Props) {
  const mapRef = useRef<maplibregl.Map | null>(null);
  const onTrainClickRef = useRef(onTrainClick);
  const onStationClickRef = useRef(onStationClick);
  const onRouteClickRef = useRef(onRouteClick);
  const fittedTrainRef = useRef<string | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [railLines, setRailLines] = useState<RailCoordinate[][]>([]);

  useEffect(() => {
    let active = true;
    loadRailLines()
      .then((lines) => {
        if (active) setRailLines(lines);
      })
      .catch((error: unknown) => {
        console.warn("Detailed rail geometry unavailable; using station links", error);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    onTrainClickRef.current = onTrainClick;
  }, [onTrainClick]);

  useEffect(() => {
    onStationClickRef.current = onStationClick;
  }, [onStationClick]);

  useEffect(() => {
    onRouteClickRef.current = onRouteClick;
  }, [onRouteClick]);

  const [{ data: trainsData }] = usePollingQuery<TrainsData>({
    query: LIVE_TRAINS,
    pollInterval: POLL_MS,
  });

  const [{ data: stationsData }] = usePollingQuery<StationsData>({
    query: STATIONS,
  });

  const [{ data: journeyData }] = usePollingQuery<TrainJourneyData>({
    query: TRAIN_JOURNEY,
    variables: { trainCode: selectedTrainCode ?? "" },
    pause: !selectedTrainCode,
    pollInterval: 15000,
  });

  const stationsByCode = useMemo(() => {
    const stations = new Map<string, Station>();
    for (const station of stationsData?.stations ?? []) {
      if (station.latitude == null || station.longitude == null) continue;
      stations.set(station.stationCode, station);
    }
    return stations;
  }, [stationsData]);

  const containerRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    if (mapRef.current) return;

    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container: node,
        style: {
          version: 8,
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
              id: "control-background",
              type: "background",
              paint: { "background-color": "#0a0c0b" },
            },
            {
              id: "osm",
              type: "raster",
              source: "osm",
              paint: {
                "raster-opacity": 0.6,
                "raster-saturation": -0.75,
                "raster-contrast": 0.08,
                "raster-brightness-min": 0.08,
                "raster-brightness-max": 0.72,
              },
            },
          ],
        },
        center: IRELAND_CENTER,
        zoom: 7,
        maxBounds: [
          [-12, 50.5],
          [-4, 56],
        ],
      });
    } catch (error) {
      setMapError(error instanceof Error ? error.message : "Map unavailable");
      return;
    }

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    map.on("load", () => {
      try {
        map.addSource(ROUTE_SOURCE_ID, { type: "geojson", data: emptyCollection() });
        map.addSource(SELECTED_ROUTE_SOURCE_ID, { type: "geojson", data: emptyCollection() });
        map.addSource(SELECTED_STOP_SOURCE_ID, { type: "geojson", data: emptyCollection() });
        map.addSource(STATION_SOURCE_ID, { type: "geojson", data: emptyCollection() });
        map.addSource(TRAIN_SOURCE_ID, { type: "geojson", data: emptyCollection() });

        map.addLayer({
          id: ROUTE_LAYER_ID,
          type: "line",
          source: ROUTE_SOURCE_ID,
          paint: {
            "line-color": "#28785b",
            "line-opacity": 0,
            "line-width": 0,
          },
        });

        map.addLayer({
          id: ROUTE_HIT_LAYER_ID,
          type: "line",
          source: ROUTE_SOURCE_ID,
          paint: {
            "line-color": "#ffffff",
            "line-opacity": 0,
            "line-width": 16,
          },
        });

        map.addLayer({
          id: SELECTED_ROUTE_LAYER_ID,
          type: "line",
          source: SELECTED_ROUTE_SOURCE_ID,
          paint: {
            "line-color": "#fab219",
            "line-opacity": 0.9,
            "line-width": 4,
          },
        });

        map.addLayer({
          id: STATION_LAYER_ID,
          type: "circle",
          source: STATION_SOURCE_ID,
          paint: {
            "circle-radius": STATION_RADIUS,
            "circle-color": ["case", ["get", "selected"], "#fab219", "#8b958e"],
            "circle-opacity": 0.85,
            "circle-stroke-color": "#0a0c0b",
            "circle-stroke-width": ["case", ["get", "selected"], 2.5, 1.25],
          },
        });

        map.addLayer({
          id: STATION_LABEL_LAYER_ID,
          type: "symbol",
          source: STATION_SOURCE_ID,
          minzoom: 8.5,
          layout: {
            "text-field": ["get", "name"],
            "text-size": 11,
            "text-offset": [0, 1.25],
            "text-anchor": "top",
          },
          paint: {
            "text-color": "#d8ded9",
            "text-halo-color": "#0a0c0b",
            "text-halo-width": 1.25,
          },
        });

        map.addLayer({
          id: SELECTED_STOP_LAYER_ID,
          type: "circle",
          source: SELECTED_STOP_SOURCE_ID,
          paint: {
            "circle-radius": 5,
            "circle-color": "#fab219",
            "circle-stroke-color": "#0a0c0b",
            "circle-stroke-width": 2,
          },
        });

        map.addLayer({
          id: TRAIN_HALO_LAYER_ID,
          type: "circle",
          source: TRAIN_SOURCE_ID,
          paint: {
            "circle-radius": ["case", ["get", "selected"], 12, 8],
            "circle-color": ["case", ["get", "selected"], "#fab219", "#d8ded9"],
            "circle-opacity": ["case", ["get", "selected"], 0.3, 0.18],
          },
        });

        map.addLayer({
          id: TRAIN_LAYER_ID,
          type: "circle",
          source: TRAIN_SOURCE_ID,
          paint: {
            "circle-radius": ["case", ["get", "selected"], 8, 5],
            "circle-color": ["case", ["get", "selected"], "#fab219", "#e6ece8"],
            "circle-stroke-color": "#0a0c0b",
            "circle-stroke-width": ["case", ["get", "selected"], 2.5, 1.5],
          },
        });

        map.addLayer({
          id: TRAIN_LABEL_LAYER_ID,
          type: "symbol",
          source: TRAIN_SOURCE_ID,
          minzoom: 7.5,
          layout: {
            "text-field": ["get", "trainCode"],
            "text-size": 11,
            "text-offset": [0, 1.1],
            "text-anchor": "top",
          },
          paint: {
            "text-color": "#d8ded9",
            "text-halo-color": "#0a0c0b",
            "text-halo-width": 1.5,
          },
        });

        setMapReady(true);
      } catch (error) {
        setMapReady(false);
        setMapError(error instanceof Error ? error.message : "Map unavailable");
        map.remove();
        mapRef.current = null;
      }
    });

    mapRef.current = map;
  }, []);

  useEffect(() => {
    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
        setMapReady(false);
      }
    };
  }, []);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    const map = mapRef.current;

    const handleTrainClick = (event: maplibregl.MapLayerMouseEvent) => {
      const feature = event.features?.[0];
      const code = feature?.properties?.trainCode;
      if (typeof code === "string") {
        onTrainClickRef.current?.(code);
      }
    };

    const handleStationClick = (event: maplibregl.MapLayerMouseEvent) => {
      const feature = event.features?.[0];
      const props = feature?.properties;
      if (!props || typeof props.stationCode !== "string" || typeof props.name !== "string") {
        return;
      }
      const latitude = Number(props.latitude);
      const longitude = Number(props.longitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;

      onStationClickRef.current?.({
        stationCode: props.stationCode,
        stationDesc: props.name,
        stationType: typeof props.stationType === "string" ? props.stationType : null,
        isDart: props.isDart === true,
        latitude,
        longitude,
      });
    };

    const handleRouteClick = (event: maplibregl.MapLayerMouseEvent) => {
      const feature = event.features?.[0];
      const props = feature?.properties;
      if (
        !props ||
        typeof props.fromStationCode !== "string" ||
        typeof props.toStationCode !== "string" ||
        typeof props.fromStationName !== "string" ||
        typeof props.toStationName !== "string"
      ) {
        return;
      }

      onRouteClickRef.current?.({
        fromStationCode: props.fromStationCode,
        fromStationName: props.fromStationName,
        toStationCode: props.toStationCode,
        toStationName: props.toStationName,
        trainCount: Number(props.trainCount) || 0,
        lastSeen: typeof props.lastSeen === "string" ? props.lastSeen : null,
      });
    };

    const enter = () => {
      map.getCanvas().style.cursor = "pointer";
    };
    const leave = () => {
      map.getCanvas().style.cursor = "";
    };

    map.on("click", TRAIN_LAYER_ID, handleTrainClick);
    map.on("click", STATION_LAYER_ID, handleStationClick);
    map.on("click", ROUTE_HIT_LAYER_ID, handleRouteClick);
    map.on("mouseenter", TRAIN_LAYER_ID, enter);
    map.on("mouseenter", STATION_LAYER_ID, enter);
    map.on("mouseenter", ROUTE_HIT_LAYER_ID, enter);
    map.on("mouseleave", TRAIN_LAYER_ID, leave);
    map.on("mouseleave", STATION_LAYER_ID, leave);
    map.on("mouseleave", ROUTE_HIT_LAYER_ID, leave);

    return () => {
      map.off("click", TRAIN_LAYER_ID, handleTrainClick);
      map.off("click", STATION_LAYER_ID, handleStationClick);
      map.off("click", ROUTE_HIT_LAYER_ID, handleRouteClick);
      map.off("mouseenter", TRAIN_LAYER_ID, enter);
      map.off("mouseenter", STATION_LAYER_ID, enter);
      map.off("mouseenter", ROUTE_HIT_LAYER_ID, enter);
      map.off("mouseleave", TRAIN_LAYER_ID, leave);
      map.off("mouseleave", STATION_LAYER_ID, leave);
      map.off("mouseleave", ROUTE_HIT_LAYER_ID, leave);
    };
  }, [mapReady]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    setSourceData(mapRef.current, ROUTE_SOURCE_ID, emptyCollection());
  }, [mapReady]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;

    const features = (stationsData?.stations ?? [])
      .filter((station) => station.latitude != null && station.longitude != null)
      .map((station) =>
        pointFeature([station.longitude!, station.latitude!], {
          stationCode: station.stationCode,
          name: station.stationDesc,
          stationType: station.stationType,
          stationTypeLabel: formatType(station.stationType),
          isDart: station.isDart === true,
          latitude: station.latitude,
          longitude: station.longitude,
          selected: station.stationCode === selectedStationCode,
        }),
      );

    setSourceData(mapRef.current, STATION_SOURCE_ID, featureCollection(features));
  }, [mapReady, selectedStationCode, stationsData]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;

    const features = (trainsData?.liveTrains ?? [])
      .filter((train) => train.latitude != null && train.longitude != null)
      .map((train) =>
        pointFeature([train.longitude!, train.latitude!], {
          trainCode: train.trainCode,
          direction: train.direction,
          trainStatus: train.trainStatus,
          trainType: train.trainType,
          fetchedAt: train.fetchedAt,
          selected: train.trainCode === selectedTrainCode,
        }),
      );

    setSourceData(mapRef.current, TRAIN_SOURCE_ID, featureCollection(features));
  }, [mapReady, selectedTrainCode, trainsData]);

  const selectedRouteCoordinates = useMemo(() => {
    const coordinates: [number, number][] = [];
    const stops = [...(journeyData?.trainJourney ?? [])].sort(
      (a, b) => a.locationOrder - b.locationOrder,
    );

    for (const stop of stops) {
      if (!stop.locationCode) continue;
      const station = stationsByCode.get(stop.locationCode);
      if (!station || station.latitude == null || station.longitude == null) continue;
      coordinates.push([station.longitude, station.latitude]);
    }

    return trackPathThrough(railLines, coordinates);
  }, [journeyData, railLines, stationsByCode]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;

    const routeFeatures =
      selectedRouteCoordinates.length >= 2 && selectedTrainCode
        ? [
            lineFeature(selectedRouteCoordinates, {
              trainCode: selectedTrainCode,
            }),
          ]
        : [];

    const stopFeatures =
      selectedTrainCode && journeyData?.trainJourney
        ? [...journeyData.trainJourney]
            .sort((a, b) => a.locationOrder - b.locationOrder)
            .map((stop) => {
              if (!stop.locationCode) return null;
              const station = stationsByCode.get(stop.locationCode);
              if (!station || station.latitude == null || station.longitude == null) return null;
              return pointFeature([station.longitude, station.latitude], {
                trainCode: selectedTrainCode,
                stationCode: stop.locationCode,
                name: stop.locationFullName || station.stationDesc,
                order: stop.locationOrder,
              });
            })
            .filter((feature): feature is Record<string, unknown> => feature != null)
        : [];

    setSourceData(mapRef.current, SELECTED_ROUTE_SOURCE_ID, featureCollection(routeFeatures));
    setSourceData(mapRef.current, SELECTED_STOP_SOURCE_ID, featureCollection(stopFeatures));
  }, [journeyData, mapReady, selectedRouteCoordinates, selectedTrainCode, stationsByCode]);

  useEffect(() => {
    if (!mapReady || !mapRef.current || !selectedTrainCode) {
      fittedTrainRef.current = null;
      return;
    }
    if (selectedRouteCoordinates.length < 2 || fittedTrainRef.current === selectedTrainCode) {
      return;
    }

    const bounds = new maplibregl.LngLatBounds(
      selectedRouteCoordinates[0],
      selectedRouteCoordinates[0],
    );
    for (const coordinate of selectedRouteCoordinates.slice(1)) {
      bounds.extend(coordinate);
    }

    fittedTrainRef.current = selectedTrainCode;
    mapRef.current.fitBounds(bounds, {
      duration: 700,
      maxZoom: 10,
      padding: { top: 88, right: 440, bottom: 72, left: 72 },
    });
  }, [mapReady, selectedRouteCoordinates, selectedTrainCode]);

  const liveTrainCount = trainsData?.liveTrains?.length ?? 0;
  const mappedTrainCount =
    trainsData?.liveTrains?.filter((train) => train.latitude != null && train.longitude != null)
      .length ?? 0;
  const stationCount = stationsData?.stations?.length ?? 0;

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      {mapError ? (
        <div className="absolute inset-0 flex items-center justify-center bg-[var(--rail-bg)]">
          <div className="border border-[var(--rail-border)] bg-[var(--rail-surface)] px-4 py-3 text-sm text-[var(--rail-muted)]">
            Map unavailable
          </div>
        </div>
      ) : null}
      <div className="map-status-bar">
        <span className="map-status-title">
          <i /> Track feed
        </span>
        <span>
          {mappedTrainCount}/{liveTrainCount} trains plotted
        </span>
        <span className="hidden sm:inline">{stationCount} control points</span>
      </div>
    </div>
  );
}
