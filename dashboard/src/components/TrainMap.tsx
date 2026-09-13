import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import { TRAIN_JOURNEY } from "../graphql/queries";
import { usePollingQuery } from "../utils/usePollingQuery";
import { loadRailLines, trackPathThrough, type RailCoordinate } from "../utils/railGeometry";
import {
  createIrelandMap,
  emptyCollection,
  featureCollection,
  pointFeature,
  setSourceData,
  type FeatureProperties,
  type TransitFeature,
} from "./transitMap";

export interface LiveTrain {
  trainCode: string;
  latitude: number | null;
  longitude: number | null;
  trainStatus: string | null;
  direction: string | null;
  trainType: string | null;
  fetchedAt: string | null;
}

export interface RailStation {
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
  trains: LiveTrain[];
  stations: RailStation[];
  selectedTrainCode?: string | null;
  selectedStationCode?: string | null;
  onTrainClick?: (trainCode: string) => void;
  onStationClick?: (station: MapStationSelection) => void;
  onRouteClick?: (route: MapRouteSelection) => void;
}

const NETWORK_SOURCE_ID = "rail-network";
const ROUTE_SOURCE_ID = "route-segments";
const SELECTED_ROUTE_SOURCE_ID = "selected-train-route";
const SELECTED_STOP_SOURCE_ID = "selected-train-stops";
const STATION_SOURCE_ID = "stations";
const TRAIN_SOURCE_ID = "live-trains";
const NETWORK_LAYER_ID = "rail-network-line";
const ROUTE_LAYER_ID = "route-segments-line";
const ROUTE_HIT_LAYER_ID = "route-segments-hit";
const SELECTED_ROUTE_CASING_LAYER_ID = "selected-train-route-casing";
const SELECTED_ROUTE_LAYER_ID = "selected-train-route-line";
const SELECTED_STOP_LAYER_ID = "selected-train-stops-circle";
const STATION_LAYER_ID = "stations-circle";
const STATION_LABEL_LAYER_ID = "stations-label";
const TRAIN_HALO_LAYER_ID = "live-trains-halo";
const TRAIN_LAYER_ID = "live-trains-circle";
const TRAIN_LABEL_LAYER_ID = "live-trains-label";

// map inks mirror the css tokens; maplibre can't read css vars
const INK = "#121814";
const BRAND = "#0b6b4d";
const LABEL_FONT = ["Noto Sans Medium"];

const STATION_RADIUS = [
  "interpolate",
  ["linear"],
  ["zoom"],
  6,
  ["case", ["get", "selected"], 6, 2.5],
  10,
  ["case", ["get", "selected"], 8, 4.5],
] as unknown as maplibregl.ExpressionSpecification;
const NETWORK_WIDTH = [
  "interpolate",
  ["linear"],
  ["zoom"],
  6,
  1,
  10,
  2.2,
  13,
  3.5,
] as unknown as maplibregl.ExpressionSpecification;

function lineFeature(
  coordinates: [number, number][],
  properties: FeatureProperties,
): TransitFeature {
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates },
    properties,
  };
}

function formatType(type: string | null) {
  if (type === "D") return "DART";
  if (type === "M") return "Mainline";
  if (type === "S") return "Suburban";
  return type || "Rail";
}

export default function TrainMap({
  trains,
  stations,
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

  const [{ data: journeyData }] = usePollingQuery<TrainJourneyData>({
    query: TRAIN_JOURNEY,
    variables: { trainCode: selectedTrainCode ?? "" },
    pause: !selectedTrainCode,
    pollInterval: 15000,
  });

  const stationsByCode = useMemo(() => {
    const byCode = new Map<string, RailStation>();
    for (const station of stations) {
      if (station.latitude == null || station.longitude == null) continue;
      byCode.set(station.stationCode, station);
    }
    return byCode;
  }, [stations]);

  const containerRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    if (mapRef.current) return;

    let map: maplibregl.Map;
    try {
      map = createIrelandMap(node);
    } catch (error) {
      setMapError(error instanceof Error ? error.message : "Map unavailable");
      return;
    }

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    map.on("load", () => {
      try {
        for (const id of [
          NETWORK_SOURCE_ID,
          ROUTE_SOURCE_ID,
          SELECTED_ROUTE_SOURCE_ID,
          SELECTED_STOP_SOURCE_ID,
          STATION_SOURCE_ID,
          TRAIN_SOURCE_ID,
        ]) {
          map.addSource(id, { type: "geojson", data: emptyCollection() });
        }

        map.addLayer({
          id: NETWORK_LAYER_ID,
          type: "line",
          source: NETWORK_SOURCE_ID,
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-color": "#8fa197",
            "line-opacity": 0.85,
            "line-width": NETWORK_WIDTH,
          },
        });

        map.addLayer({
          id: ROUTE_LAYER_ID,
          type: "line",
          source: ROUTE_SOURCE_ID,
          paint: {
            "line-color": BRAND,
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
          id: SELECTED_ROUTE_CASING_LAYER_ID,
          type: "line",
          source: SELECTED_ROUTE_SOURCE_ID,
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-color": "#ffffff",
            "line-opacity": 0.95,
            "line-width": 9,
          },
        });

        map.addLayer({
          id: SELECTED_ROUTE_LAYER_ID,
          type: "line",
          source: SELECTED_ROUTE_SOURCE_ID,
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-color": INK,
            "line-width": 4,
          },
        });

        map.addLayer({
          id: STATION_LAYER_ID,
          type: "circle",
          source: STATION_SOURCE_ID,
          paint: {
            "circle-radius": STATION_RADIUS,
            "circle-color": ["case", ["get", "selected"], INK, "#ffffff"],
            "circle-stroke-color": ["case", ["get", "selected"], "#ffffff", "#56615b"],
            "circle-stroke-width": ["case", ["get", "selected"], 3, 1.25],
          },
        });

        map.addLayer({
          id: STATION_LABEL_LAYER_ID,
          type: "symbol",
          source: STATION_SOURCE_ID,
          minzoom: 8.5,
          layout: {
            "text-field": ["get", "name"],
            "text-font": LABEL_FONT,
            "text-size": 11.5,
            "text-offset": [0, 1.2],
            "text-anchor": "top",
          },
          paint: {
            "text-color": "#3d4540",
            "text-halo-color": "#ffffff",
            "text-halo-width": 1.5,
          },
        });

        map.addLayer({
          id: SELECTED_STOP_LAYER_ID,
          type: "circle",
          source: SELECTED_STOP_SOURCE_ID,
          paint: {
            "circle-radius": 4.5,
            "circle-color": "#ffffff",
            "circle-stroke-color": INK,
            "circle-stroke-width": 2,
          },
        });

        map.addLayer({
          id: TRAIN_HALO_LAYER_ID,
          type: "circle",
          source: TRAIN_SOURCE_ID,
          paint: {
            "circle-radius": ["case", ["get", "selected"], 16, 11],
            "circle-color": ["case", ["get", "selected"], INK, BRAND],
            "circle-opacity": 0.16,
          },
        });

        map.addLayer({
          id: TRAIN_LAYER_ID,
          type: "circle",
          source: TRAIN_SOURCE_ID,
          paint: {
            "circle-radius": ["case", ["get", "selected"], 8, 5.5],
            "circle-color": ["case", ["get", "selected"], INK, BRAND],
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": 2,
          },
        });

        map.addLayer({
          id: TRAIN_LABEL_LAYER_ID,
          type: "symbol",
          source: TRAIN_SOURCE_ID,
          minzoom: 8,
          layout: {
            "text-field": ["get", "trainCode"],
            "text-font": LABEL_FONT,
            "text-size": 11,
            "text-offset": [0, 1.2],
            "text-anchor": "top",
          },
          paint: {
            "text-color": INK,
            "text-halo-color": "#ffffff",
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
    if (!mapReady || !mapRef.current || railLines.length === 0) return;
    setSourceData(
      mapRef.current,
      NETWORK_SOURCE_ID,
      featureCollection([
        {
          type: "Feature",
          geometry: { type: "MultiLineString", coordinates: railLines },
          properties: {},
        },
      ]),
    );
  }, [mapReady, railLines]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;

    const features = stations
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
  }, [mapReady, selectedStationCode, stations]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;

    const features = trains
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
  }, [mapReady, selectedTrainCode, trains]);

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

    // keep the route clear of the stats card (left) and detail sheet (right)
    const wide = mapRef.current.getContainer().clientWidth > 900;
    fittedTrainRef.current = selectedTrainCode;
    mapRef.current.fitBounds(bounds, {
      duration: 700,
      maxZoom: 10,
      padding: wide
        ? { top: 72, right: 460, bottom: 56, left: 340 }
        : { top: 48, right: 32, bottom: 48, left: 32 },
    });
  }, [mapReady, selectedRouteCoordinates, selectedTrainCode]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      {mapError ? (
        <div className="absolute inset-0 grid place-items-center bg-paper">
          <div className="card px-5 py-4 text-[14px] text-muted">
            The map couldn’t load in this browser.
          </div>
        </div>
      ) : null}
    </div>
  );
}
