import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";

import { useTheme } from "../theme";
import { busFeedState, type BusRealtimeStatus } from "../utils/busRealtime";
import {
  busShapeCoordinates,
  busShapeRouteLabel,
  gtfsRouteColor,
  type BusRouteShape,
} from "../utils/busShapes";
import {
  busVehicleKey,
  busVehicleRoute,
  humanizeGtfsValue,
  speedKmh,
  type BusVehicle,
} from "../utils/busVehicles";
import { Card, Icon } from "./ui";
import {
  applyIrelandMapTheme,
  createIrelandMap,
  emptyCollection,
  featureCollection,
  pointFeature,
  setSourceData,
  transitMapPalette,
  type FeatureProperties,
  type TransitFeature,
} from "./transitMap";

const ROUTE_SOURCE_ID = "live-bus-routes";
const ROUTE_CASING_LAYER_ID = "live-bus-routes-casing";
const ROUTE_LAYER_ID = "live-bus-routes-line";
const ROUTE_LABEL_LAYER_ID = "live-bus-routes-label";
const VEHICLE_SOURCE_ID = "live-buses";
const VEHICLE_HALO_LAYER_ID = "live-buses-halo";
const VEHICLE_LAYER_ID = "live-buses-circle";
const VEHICLE_LABEL_LAYER_ID = "live-buses-label";
const LABEL_FONT = ["Noto Sans Medium"];

const timeFormat = new Intl.DateTimeFormat("en-IE", {
  timeZone: "Europe/Dublin",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function updateTime(value: string | null) {
  if (!value) return "Time unavailable";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Time unavailable" : timeFormat.format(date);
}

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

export default function BusVehicleMap({
  vehicles,
  routeShapes,
  realtimeStatus,
  fetching,
  shapesFetching,
  shapeMode,
  shapeFocusKey,
}: {
  vehicles: BusVehicle[];
  routeShapes: BusRouteShape[];
  realtimeStatus: BusRealtimeStatus | null;
  fetching: boolean;
  shapesFetching: boolean;
  shapeMode: "live" | "scheduled";
  shapeFocusKey: string;
}) {
  const { theme } = useTheme();
  const palette = transitMapPalette(theme);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const lastFitKeyRef = useRef<string | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const selectedVehicle = useMemo(
    () => vehicles.find((vehicle) => busVehicleKey(vehicle) === selectedKey) ?? null,
    [selectedKey, vehicles],
  );

  const latestUpdate = useMemo(
    () =>
      vehicles.reduce<string | null>((latest, vehicle) => {
        const candidate = vehicle.sourceTimestamp || vehicle.fetchedAt;
        return !latest || new Date(candidate) > new Date(latest) ? candidate : latest;
      }, null),
    [vehicles],
  );
  const feedState = busFeedState(realtimeStatus, fetching && realtimeStatus == null);

  const containerRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node || mapRef.current) return;

      let map: maplibregl.Map;
      try {
        map = createIrelandMap(node, theme);
      } catch (error) {
        setMapError(error instanceof Error ? error.message : "Map unavailable");
        return;
      }

      map.addControl(new maplibregl.NavigationControl(), "top-right");
      map.on("load", () => {
        try {
          map.addSource(ROUTE_SOURCE_ID, { type: "geojson", data: emptyCollection() });
          map.addSource(VEHICLE_SOURCE_ID, { type: "geojson", data: emptyCollection() });
          map.addLayer({
            id: ROUTE_CASING_LAYER_ID,
            type: "line",
            source: ROUTE_SOURCE_ID,
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": palette.casing,
              "line-opacity": ["case", ["get", "selected"], 0.88, 0.5],
              "line-width": ["case", ["get", "selected"], 7, 4],
            },
          });
          map.addLayer({
            id: ROUTE_LAYER_ID,
            type: "line",
            source: ROUTE_SOURCE_ID,
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": ["case", ["get", "selected"], palette.ink, ["get", "routeColor"]],
              "line-opacity": ["case", ["get", "selected"], 0.95, 0.62],
              "line-width": ["case", ["get", "selected"], 4.5, 2.25],
            },
          });
          map.addLayer({
            id: ROUTE_LABEL_LAYER_ID,
            type: "symbol",
            source: ROUTE_SOURCE_ID,
            minzoom: 7.5,
            layout: {
              "symbol-placement": "line",
              "symbol-spacing": 360,
              "text-field": ["get", "routeLabel"],
              "text-font": LABEL_FONT,
              "text-size": 11,
            },
            paint: {
              "text-color": palette.label,
              "text-halo-color": palette.labelHalo,
              "text-halo-width": 1.5,
            },
          });
          map.addLayer({
            id: VEHICLE_HALO_LAYER_ID,
            type: "circle",
            source: VEHICLE_SOURCE_ID,
            paint: {
              "circle-radius": ["case", ["get", "selected"], 17, 11],
              "circle-color": ["case", ["get", "selected"], palette.ink, palette.bus],
              "circle-opacity": 0.2,
            },
          });
          map.addLayer({
            id: VEHICLE_LAYER_ID,
            type: "circle",
            source: VEHICLE_SOURCE_ID,
            paint: {
              "circle-radius": [
                "interpolate",
                ["linear"],
                ["zoom"],
                6,
                ["case", ["get", "selected"], 7, 4.5],
                11,
                ["case", ["get", "selected"], 10, 6.5],
              ],
              "circle-color": ["case", ["get", "selected"], palette.ink, palette.bus],
              "circle-stroke-color": palette.casing,
              "circle-stroke-width": 2,
            },
          });
          map.addLayer({
            id: VEHICLE_LABEL_LAYER_ID,
            type: "symbol",
            source: VEHICLE_SOURCE_ID,
            minzoom: 8.25,
            layout: {
              "text-field": ["get", "routeLabel"],
              "text-font": LABEL_FONT,
              "text-size": 11,
              "text-offset": [0, 1.25],
              "text-anchor": "top",
            },
            paint: {
              "text-color": palette.label,
              "text-halo-color": palette.labelHalo,
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
    },
    [palette, theme],
  );

  useEffect(() => {
    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
      setMapReady(false);
    };
  }, []);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    const map = mapRef.current;
    const next = transitMapPalette(theme);

    applyIrelandMapTheme(map, theme);
    map.setPaintProperty(ROUTE_CASING_LAYER_ID, "line-color", next.casing);
    map.setPaintProperty(ROUTE_LAYER_ID, "line-color", [
      "case",
      ["get", "selected"],
      next.ink,
      ["get", "routeColor"],
    ]);
    map.setPaintProperty(ROUTE_LABEL_LAYER_ID, "text-color", next.label);
    map.setPaintProperty(ROUTE_LABEL_LAYER_ID, "text-halo-color", next.labelHalo);
    map.setPaintProperty(VEHICLE_HALO_LAYER_ID, "circle-color", [
      "case",
      ["get", "selected"],
      next.ink,
      next.bus,
    ]);
    map.setPaintProperty(VEHICLE_LAYER_ID, "circle-color", [
      "case",
      ["get", "selected"],
      next.ink,
      next.bus,
    ]);
    map.setPaintProperty(VEHICLE_LAYER_ID, "circle-stroke-color", next.casing);
    map.setPaintProperty(VEHICLE_LABEL_LAYER_ID, "text-color", next.label);
    map.setPaintProperty(VEHICLE_LABEL_LAYER_ID, "text-halo-color", next.labelHalo);
  }, [mapReady, theme]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;

    const selectedRouteId = selectedVehicle?.routeId ?? null;
    const features = routeShapes.flatMap((shape) => {
      const coordinates = busShapeCoordinates(shape);
      if (coordinates.length < 2) return [];
      return [
        lineFeature(coordinates, {
          routeId: shape.routeId,
          routeLabel: busShapeRouteLabel(shape),
          shapeId: shape.shapeId,
          routeColor: gtfsRouteColor(shape.routeColor, palette.bus),
          selected: selectedRouteId != null && shape.routeId === selectedRouteId,
        }),
      ];
    });

    setSourceData(mapRef.current, ROUTE_SOURCE_ID, featureCollection(features));

    if (vehicles.length > 0 || features.length === 0) return;
    const shapeSignature = routeShapes.map((shape) => shape.shapeId).join(",");
    const fitKey = `${shapeMode}:${shapeFocusKey}:${shapeSignature}`;
    if (lastFitKeyRef.current === fitKey) return;

    const coordinates = routeShapes.flatMap(busShapeCoordinates);
    if (coordinates.length === 0) return;
    lastFitKeyRef.current = fitKey;
    const bounds = new maplibregl.LngLatBounds(coordinates[0], coordinates[0]);
    for (const coordinate of coordinates.slice(1)) bounds.extend(coordinate);
    mapRef.current.fitBounds(bounds, { padding: 48, maxZoom: 11, duration: 500 });
  }, [
    mapReady,
    palette.bus,
    routeShapes,
    selectedVehicle?.routeId,
    shapeFocusKey,
    shapeMode,
    vehicles.length,
  ]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    const map = mapRef.current;

    const selectVehicle = (event: maplibregl.MapLayerMouseEvent) => {
      const key = event.features?.[0]?.properties?.vehicleKey;
      if (typeof key === "string") setSelectedKey(key);
    };
    const enter = () => {
      map.getCanvas().style.cursor = "pointer";
    };
    const leave = () => {
      map.getCanvas().style.cursor = "";
    };

    map.on("click", VEHICLE_LAYER_ID, selectVehicle);
    map.on("mouseenter", VEHICLE_LAYER_ID, enter);
    map.on("mouseleave", VEHICLE_LAYER_ID, leave);
    return () => {
      map.off("click", VEHICLE_LAYER_ID, selectVehicle);
      map.off("mouseenter", VEHICLE_LAYER_ID, enter);
      map.off("mouseleave", VEHICLE_LAYER_ID, leave);
    };
  }, [mapReady]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;

    const features = vehicles.map((vehicle) =>
      pointFeature([vehicle.longitude, vehicle.latitude], {
        vehicleKey: busVehicleKey(vehicle),
        routeLabel: busVehicleRoute(vehicle),
        selected: busVehicleKey(vehicle) === selectedKey,
      }),
    );
    setSourceData(mapRef.current, VEHICLE_SOURCE_ID, featureCollection(features));

    if (vehicles.length === 0 || lastFitKeyRef.current === "vehicles") return;
    lastFitKeyRef.current = "vehicles";
    if (vehicles.length === 1) {
      mapRef.current.easeTo({
        center: [vehicles[0].longitude, vehicles[0].latitude],
        zoom: 10,
        duration: 500,
      });
      return;
    }

    const bounds = new maplibregl.LngLatBounds(
      [vehicles[0].longitude, vehicles[0].latitude],
      [vehicles[0].longitude, vehicles[0].latitude],
    );
    for (const vehicle of vehicles.slice(1)) {
      bounds.extend([vehicle.longitude, vehicle.latitude]);
    }
    mapRef.current.fitBounds(bounds, { padding: 48, maxZoom: 10, duration: 500 });
  }, [mapReady, selectedKey, vehicles]);

  const speed = selectedVehicle ? speedKmh(selectedVehicle.speedMetersPerSecond) : null;
  const status = selectedVehicle ? humanizeGtfsValue(selectedVehicle.currentStatus) : null;
  const occupancy = selectedVehicle ? humanizeGtfsValue(selectedVehicle.occupancyStatus) : null;

  return (
    <Card
      title="Bus routes and live positions"
      description={
        shapeMode === "live"
          ? "Live vehicles over the scheduled GTFS paths for their current trips."
          : "Representative scheduled GTFS paths, with realtime vehicles layered on when available."
      }
      index={2}
      className="bus-map-card"
      actions={
        <span className="bus-map-count">
          {feedState.isLive ? <span className="live-dot" /> : null}
          {!feedState.isLive
            ? routeShapes.length > 0
              ? `${routeShapes.length} scheduled paths`
              : feedState.badge
            : fetching && vehicles.length === 0
              ? "Loading positions"
              : `${vehicles.length.toLocaleString()} buses · ${updateTime(latestUpdate)}`}
        </span>
      }
    >
      <div className="bus-map-frame">
        <div
          ref={containerRef}
          className="bus-map-canvas"
          role="region"
          aria-label="Bus routes and live positions map"
        />

        {vehicles.length === 0 && routeShapes.length === 0 ? (
          <div className="bus-map-empty">
            <Icon name="bus" />
            <strong>
              {shapesFetching
                ? "Loading scheduled route paths"
                : feedState.isLive && fetching
                  ? "Loading live vehicle positions"
                  : "Scheduled route paths unavailable"}
            </strong>
            <span>
              {shapesFetching
                ? "The map will focus on the selected stop when its routes arrive."
                : "The active GTFS feed has no imported route geometry for this view."}
            </span>
          </div>
        ) : null}

        {selectedVehicle ? (
          <aside className="bus-vehicle-detail" aria-label="Selected bus">
            <button
              type="button"
              className="icon-btn"
              aria-label="Close bus details"
              onClick={() => setSelectedKey(null)}
            >
              <Icon name="x" />
            </button>
            <div className="flex min-w-0 items-start gap-3 pr-9">
              <span className="bus-route-chip">{busVehicleRoute(selectedVehicle)}</span>
              <div className="min-w-0">
                <strong>
                  {selectedVehicle.headsign ||
                    selectedVehicle.routeLongName ||
                    "Destination not reported"}
                </strong>
                <small>
                  {selectedVehicle.operatorName || "Operator unavailable"}
                  {selectedVehicle.vehicleLabel || selectedVehicle.vehicleId
                    ? ` · ${selectedVehicle.vehicleLabel || selectedVehicle.vehicleId}`
                    : ""}
                </small>
              </div>
            </div>
            <dl>
              <div>
                <dt>Status</dt>
                <dd>{status || "Position reported"}</dd>
              </div>
              <div>
                <dt>Speed</dt>
                <dd>{speed == null ? "Not reported" : `${speed} km/h`}</dd>
              </div>
              <div>
                <dt>Occupancy</dt>
                <dd>{occupancy || "Not reported"}</dd>
              </div>
              <div>
                <dt>Stop</dt>
                <dd>
                  {selectedVehicle.stopId ||
                    (selectedVehicle.currentStopSequence == null
                      ? "Not reported"
                      : `Sequence ${selectedVehicle.currentStopSequence}`)}
                </dd>
              </div>
              <div>
                <dt>Bearing</dt>
                <dd>
                  {selectedVehicle.bearing == null
                    ? "Not reported"
                    : `${Math.round(selectedVehicle.bearing)}°`}
                </dd>
              </div>
              <div>
                <dt>Updated</dt>
                <dd>{updateTime(selectedVehicle.sourceTimestamp || selectedVehicle.fetchedAt)}</dd>
              </div>
            </dl>
          </aside>
        ) : null}

        {mapError ? (
          <div className="bus-map-empty">
            <Icon name="alert" />
            <strong>Map unavailable</strong>
            <span>The position feed loaded, but this browser could not draw the map.</span>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
