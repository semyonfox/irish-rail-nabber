import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";

import { busMotionPath, busMotionPosition } from "../utils/busMotion";
import { useTheme } from "../theme";
import { busFeedState, type BusRealtimeStatus } from "../utils/busRealtime";
import { busShapeCoordinates, busShapeRouteLabel, type BusRouteShape } from "../utils/busShapes";
import {
  busVehicleKey,
  busVehicleRoute,
  humanizeGtfsValue,
  speedKmh,
  type BusVehicle,
} from "../utils/busVehicles";
import {
  noticeCategoryLabel,
  noticesForRoute,
  type BusBunch,
  type BusServiceNotice,
} from "../utils/busConditions";
import { Icon, Sheet } from "./ui";
import {
  applyIrelandMapTheme,
  createIrelandMap,
  emptyCollection,
  featureCollection,
  pointFeature,
  setSourceData,
  transitMapPalette,
  type FeatureProperties,
  type TransitMapPalette,
  type TransitFeature,
} from "./transitMap";

const ROUTE_SOURCE_ID = "live-bus-routes";
const ROUTE_LAYER_ID = "live-bus-routes-line";
const SELECTED_CASING_LAYER_ID = "live-bus-route-selected-casing";
const SELECTED_LAYER_ID = "live-bus-route-selected-line";
const ROUTE_LABEL_LAYER_ID = "live-bus-routes-label";
const VEHICLE_SOURCE_ID = "live-buses";
const VEHICLE_LAYER_ID = "live-buses-circle";
// dots shrink to a couple of pixels at country zoom, so clicks hit this instead
const VEHICLE_HIT_LAYER_ID = "live-buses-hit";
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

const motionMs = () => (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 250);

const isSelected: maplibregl.ExpressionSpecification = ["==", ["get", "selected"], true];
const isDimmed: maplibregl.ExpressionSpecification = ["==", ["get", "dimmed"], true];
const isBunched: maplibregl.ExpressionSpecification = ["==", ["get", "bunched"], true];

// every live route at once is several hundred lines, so they stay a faint
// network sketch and only the selected route is drawn strongly
function routePaint(palette: TransitMapPalette): maplibregl.LineLayerSpecification["paint"] {
  return {
    "line-color": palette.track,
    "line-width": ["interpolate", ["linear"], ["zoom"], 7, 0.4, 11, 1, 14, 2.5],
    "line-opacity": [
      "interpolate",
      ["linear"],
      ["zoom"],
      7,
      ["case", isDimmed, 0.08, 0.18],
      12,
      ["case", isDimmed, 0.15, 0.45],
    ],
  };
}

const vehicleColor = (palette: TransitMapPalette): maplibregl.ExpressionSpecification => [
  "case",
  isSelected,
  palette.ink,
  palette.bus,
];
const vehicleStroke = (palette: TransitMapPalette): maplibregl.ExpressionSpecification => [
  "case",
  isBunched,
  palette.alert,
  palette.casing,
];

function vehiclePaint(palette: TransitMapPalette): maplibregl.CircleLayerSpecification["paint"] {
  return {
    "circle-radius": [
      "interpolate",
      ["linear"],
      ["zoom"],
      5,
      ["case", isSelected, 5, 1.6],
      8,
      ["case", isSelected, 6, 2.4],
      11,
      ["case", isSelected, 8, 4.5],
      14,
      ["case", isSelected, 10, 7],
    ],
    "circle-color": vehicleColor(palette),
    "circle-opacity": ["case", isDimmed, 0.25, 0.95],
    "circle-stroke-color": vehicleStroke(palette),
    "circle-stroke-opacity": ["case", isDimmed, 0.25, 1],
    "circle-stroke-width": [
      "interpolate",
      ["linear"],
      ["zoom"],
      8,
      ["case", isBunched, 1, 0],
      11,
      ["case", isBunched, 2.5, 1],
    ],
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
  selectedKey,
  onSelect,
  bunches,
  notices,
}: {
  vehicles: BusVehicle[];
  routeShapes: BusRouteShape[];
  realtimeStatus: BusRealtimeStatus | null;
  fetching: boolean;
  shapesFetching: boolean;
  shapeMode: "live" | "scheduled";
  shapeFocusKey: string;
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  bunches: BusBunch[];
  notices: BusServiceNotice[];
}) {
  const { theme } = useTheme();
  const palette = transitMapPalette(theme);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const previousVehiclesRef = useRef(new Map<string, BusVehicle>());
  const lastFitKeyRef = useRef<string | null>(null);
  const followedKeyRef = useRef<string | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);

  const selectedVehicle = useMemo(
    () => vehicles.find((vehicle) => busVehicleKey(vehicle) === selectedKey) ?? null,
    [selectedKey, vehicles],
  );

  const feedState = busFeedState(realtimeStatus, fetching && realtimeStatus == null);
  const shapeCoordinates = useMemo(
    () => new Map(routeShapes.map((shape) => [shape.shapeId, busShapeCoordinates(shape)])),
    [routeShapes],
  );
  const selectedRouteId = selectedVehicle?.routeId ?? null;
  const bunchedTripIds = useMemo(
    () => new Set(bunches.flatMap((bunch) => bunch.tripIds)),
    [bunches],
  );
  const selectedTripId = selectedVehicle?.tripId ?? null;
  const selectedBunch = useMemo(
    () =>
      selectedTripId
        ? (bunches.find((bunch) => bunch.tripIds.includes(selectedTripId)) ?? null)
        : null,
    [bunches, selectedTripId],
  );
  const selectedNotices = useMemo(
    () => noticesForRoute(notices, selectedRouteId),
    [notices, selectedRouteId],
  );

  const containerRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node || mapRef.current) return;

      let map: maplibregl.Map;
      try {
        map = createIrelandMap(
          node,
          theme,
          'Bus data: <a href="https://www.nationaltransport.ie/" target="_blank" rel="noreferrer">NTA</a> · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a>',
        );
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
            id: ROUTE_LAYER_ID,
            type: "line",
            source: ROUTE_SOURCE_ID,
            filter: ["!", isSelected],
            layout: { "line-cap": "round", "line-join": "round" },
            paint: routePaint(palette),
          });
          map.addLayer({
            id: SELECTED_CASING_LAYER_ID,
            type: "line",
            source: ROUTE_SOURCE_ID,
            filter: isSelected,
            layout: { "line-cap": "round", "line-join": "round" },
            paint: { "line-color": palette.casing, "line-opacity": 0.85, "line-width": 7 },
          });
          map.addLayer({
            id: SELECTED_LAYER_ID,
            type: "line",
            source: ROUTE_SOURCE_ID,
            filter: isSelected,
            layout: { "line-cap": "round", "line-join": "round" },
            paint: { "line-color": palette.ink, "line-opacity": 0.95, "line-width": 4 },
          });
          map.addLayer({
            id: ROUTE_LABEL_LAYER_ID,
            type: "symbol",
            source: ROUTE_SOURCE_ID,
            filter: isSelected,
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
            id: VEHICLE_LAYER_ID,
            type: "circle",
            source: VEHICLE_SOURCE_ID,
            paint: vehiclePaint(palette),
          });
          map.addLayer({
            id: VEHICLE_HIT_LAYER_ID,
            type: "circle",
            source: VEHICLE_SOURCE_ID,
            paint: { "circle-radius": 10, "circle-opacity": 0 },
          });
          map.addLayer({
            id: VEHICLE_LABEL_LAYER_ID,
            type: "symbol",
            source: VEHICLE_SOURCE_ID,
            minzoom: 12,
            filter: ["!", isDimmed],
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
    map.setPaintProperty(ROUTE_LAYER_ID, "line-color", next.track);
    map.setPaintProperty(SELECTED_CASING_LAYER_ID, "line-color", next.casing);
    map.setPaintProperty(SELECTED_LAYER_ID, "line-color", next.ink);
    map.setPaintProperty(ROUTE_LABEL_LAYER_ID, "text-color", next.label);
    map.setPaintProperty(ROUTE_LABEL_LAYER_ID, "text-halo-color", next.labelHalo);
    map.setPaintProperty(VEHICLE_LAYER_ID, "circle-color", vehicleColor(next));
    map.setPaintProperty(VEHICLE_LAYER_ID, "circle-stroke-color", vehicleStroke(next));
    map.setPaintProperty(VEHICLE_LABEL_LAYER_ID, "text-color", next.label);
    map.setPaintProperty(VEHICLE_LABEL_LAYER_ID, "text-halo-color", next.labelHalo);
  }, [mapReady, theme]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;

    const features = routeShapes.flatMap((shape) => {
      const coordinates = shapeCoordinates.get(shape.shapeId) ?? [];
      if (coordinates.length < 2) return [];
      const selected = selectedRouteId != null && shape.routeId === selectedRouteId;
      return [
        lineFeature(coordinates, {
          routeId: shape.routeId,
          routeLabel: busShapeRouteLabel(shape),
          shapeId: shape.shapeId,
          selected,
          dimmed: selectedRouteId != null && !selected,
        }),
      ];
    });

    setSourceData(mapRef.current, ROUTE_SOURCE_ID, featureCollection(features));

    // a selected bus owns the camera, so feed dropouts don't refit around it
    if (vehicles.length > 0 || features.length === 0 || selectedKey) return;
    const shapeSignature = routeShapes.map((shape) => shape.shapeId).join(",");
    const fitKey = `${shapeMode}:${shapeFocusKey}:${shapeSignature}`;
    if (lastFitKeyRef.current === fitKey) return;

    const coordinates = [...shapeCoordinates.values()].flat();
    if (coordinates.length === 0) return;
    lastFitKeyRef.current = fitKey;
    const bounds = new maplibregl.LngLatBounds(coordinates[0], coordinates[0]);
    for (const coordinate of coordinates.slice(1)) bounds.extend(coordinate);
    mapRef.current.fitBounds(bounds, { padding: 48, maxZoom: 11, duration: motionMs() });
  }, [
    mapReady,
    routeShapes,
    selectedKey,
    selectedRouteId,
    shapeCoordinates,
    shapeFocusKey,
    shapeMode,
    vehicles.length,
  ]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    const map = mapRef.current;

    const selectVehicle = (event: maplibregl.MapLayerMouseEvent) => {
      const key = event.features?.[0]?.properties?.vehicleKey;
      if (typeof key === "string") onSelect(key);
    };
    const enter = () => {
      map.getCanvas().style.cursor = "pointer";
    };
    const leave = () => {
      map.getCanvas().style.cursor = "";
    };

    map.on("click", VEHICLE_HIT_LAYER_ID, selectVehicle);
    map.on("mouseenter", VEHICLE_HIT_LAYER_ID, enter);
    map.on("mouseleave", VEHICLE_HIT_LAYER_ID, leave);
    return () => {
      map.off("click", VEHICLE_HIT_LAYER_ID, selectVehicle);
      map.off("mouseenter", VEHICLE_HIT_LAYER_ID, enter);
      map.off("mouseleave", VEHICLE_HIT_LAYER_ID, leave);
    };
  }, [mapReady, onSelect]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const paths = vehicles.map((vehicle) =>
      reducedMotion.matches
        ? null
        : busMotionPath(
            previousVehiclesRef.current.get(busVehicleKey(vehicle)),
            vehicle,
            vehicle.shapeId ? shapeCoordinates.get(vehicle.shapeId) : undefined,
          ),
    );
    previousVehiclesRef.current = new Map(
      vehicles.map((vehicle) => [busVehicleKey(vehicle), vehicle]),
    );
    let frame = 0;
    const started = performance.now();
    const animated = paths.some((path) => path != null);
    const draw = (time: number) => {
      if (!mapRef.current) return;
      const fraction = reducedMotion.matches ? 1 : Math.min(1, (time - started) / 1_200);
      const features = vehicles.map((vehicle, index) => {
        const path = paths[index];
        const coordinate: [number, number] = path
          ? busMotionPosition(path, fraction)
          : [vehicle.longitude, vehicle.latitude];
        return pointFeature(coordinate, {
          vehicleKey: busVehicleKey(vehicle),
          routeLabel: busVehicleRoute(vehicle),
          selected: busVehicleKey(vehicle) === selectedKey,
          dimmed: selectedRouteId != null && vehicle.routeId !== selectedRouteId,
          // only on the selected route, or every busy corridor glows
          bunched:
            selectedRouteId != null &&
            vehicle.routeId === selectedRouteId &&
            vehicle.tripId != null &&
            bunchedTripIds.has(vehicle.tripId),
        });
      });
      setSourceData(mapRef.current, VEHICLE_SOURCE_ID, featureCollection(features));
      if (animated && fraction < 1) frame = requestAnimationFrame(draw);
    };
    draw(started);
    return () => cancelAnimationFrame(frame);
  }, [bunchedTripIds, mapReady, selectedKey, selectedRouteId, shapeCoordinates, vehicles]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;

    if (vehicles.length === 0 || lastFitKeyRef.current === "vehicles" || selectedKey) return;
    lastFitKeyRef.current = "vehicles";
    if (vehicles.length === 1) {
      mapRef.current.easeTo({
        center: [vehicles[0].longitude, vehicles[0].latitude],
        zoom: 10,
        duration: motionMs(),
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
    mapRef.current.fitBounds(bounds, { padding: 48, maxZoom: 10, duration: motionMs() });
  }, [mapReady, selectedKey, vehicles]);

  // a bus picked from the list can be off screen, so bring it into view once
  // per selection. polls move it later but shouldn't drag the camera along
  useEffect(() => {
    const map = mapRef.current;
    if (!selectedKey) {
      followedKeyRef.current = null;
      return;
    }
    if (!mapReady || !map || !selectedVehicle || followedKeyRef.current === selectedKey) return;
    followedKeyRef.current = selectedKey;
    // above 900px the summary card overlays the left of the map and the
    // details sheet the right, so only the strip between them counts
    const wide = window.matchMedia("(min-width: 901px)").matches;
    const left = wide ? 340 : 0;
    const right = wide ? 440 : 0;

    // a bunch only reads as one on screen together, so frame every bus in it
    const group = selectedBunch
      ? vehicles.filter(
          (vehicle) => vehicle.tripId != null && selectedBunch.tripIds.includes(vehicle.tripId),
        )
      : [];
    if (group.length > 1) {
      const bounds = new maplibregl.LngLatBounds(
        [group[0].longitude, group[0].latitude],
        [group[0].longitude, group[0].latitude],
      );
      for (const vehicle of group.slice(1)) bounds.extend([vehicle.longitude, vehicle.latitude]);
      map.fitBounds(bounds, {
        padding: { top: 80, bottom: 80, left: left + 60, right: right + 60 },
        maxZoom: 16,
        duration: motionMs(),
      });
      return;
    }

    const position: [number, number] = [selectedVehicle.longitude, selectedVehicle.latitude];
    const container = map.getContainer();
    const point = map.project(position);
    const visible =
      point.x >= left &&
      point.y >= 0 &&
      point.x <= container.clientWidth - right &&
      point.y <= container.clientHeight;
    if (visible) return;
    map.easeTo({
      center: position,
      offset: [(left - right) / 2, 0],
      zoom: Math.max(map.getZoom(), 11),
      duration: motionMs(),
    });
  }, [mapReady, selectedBunch, selectedKey, selectedVehicle, vehicles]);

  const speed = selectedVehicle ? speedKmh(selectedVehicle.speedMetersPerSecond) : null;
  const status = selectedVehicle ? humanizeGtfsValue(selectedVehicle.currentStatus) : null;
  const occupancy = selectedVehicle ? humanizeGtfsValue(selectedVehicle.occupancyStatus) : null;
  // NTA leaves most of these empty for most buses, so only show what was reported
  const facts: [string, string][] = selectedVehicle
    ? (
        [
          ["Status", status],
          ["Speed", speed == null ? null : `${speed} km/h`],
          ["Occupancy", occupancy],
          [
            "Stop",
            selectedVehicle.stopId ||
              (selectedVehicle.currentStopSequence == null
                ? null
                : `Sequence ${selectedVehicle.currentStopSequence}`),
          ],
          [
            "Bearing",
            selectedVehicle.bearing == null ? null : `${Math.round(selectedVehicle.bearing)}°`,
          ],
          ["Updated", updateTime(selectedVehicle.sourceTimestamp || selectedVehicle.fetchedAt)],
        ] satisfies [string, string | null][]
      ).filter((fact): fact is [string, string] => Boolean(fact[1]))
    : [];

  return (
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
              ? "Loading bus routes"
              : feedState.isLive && fetching
                ? "Loading live vehicle positions"
                : "Bus routes unavailable"}
          </strong>
          <span>
            {shapesFetching
              ? "Routes will appear when they finish loading."
              : "No bus positions or routes are available right now. Please try again shortly."}
          </span>
        </div>
      ) : null}

      {selectedVehicle ? (
        <Sheet
          label="bus details"
          onClose={() => onSelect(null)}
          eyebrow={
            <>
              <span className="bus-route-chip">{busVehicleRoute(selectedVehicle)}</span>Bus
            </>
          }
          title={
            selectedVehicle.headsign || selectedVehicle.routeLongName || "Destination not reported"
          }
          subtitle={[
            selectedVehicle.operatorName || "Operator unavailable",
            selectedVehicle.vehicleLabel || selectedVehicle.vehicleId,
          ]
            .filter(Boolean)
            .join(" · ")}
        >
          <dl className="bus-vehicle-facts">
            {facts.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {selectedBunch ? (
            <p className="bus-bunched-note">
              Bunched: {selectedBunch.tripIds.length} {busVehicleRoute(selectedVehicle)} buses
              within {selectedBunch.spreadMetres} m, timetabled {selectedBunch.scheduledGapMinutes}{" "}
              min apart.
            </p>
          ) : null}
          {selectedNotices.length > 0 ? (
            <section aria-label="Service notices for this route">
              <div className="section-label">Service notices</div>
              <ul className="bus-notice-list">
                {selectedNotices.map((notice) => (
                  <li key={notice.noticeId}>
                    <span className="eyebrow">{noticeCategoryLabel(notice.category)}</span>
                    <strong>{notice.header}</strong>
                    {notice.description && notice.description !== notice.header ? (
                      <p>{notice.description}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </Sheet>
      ) : null}

      {mapError ? (
        <div className="bus-map-empty">
          <Icon name="alert" />
          <strong>Map unavailable</strong>
          <span>The position feed loaded, but this browser could not draw the map.</span>
        </div>
      ) : null}
    </div>
  );
}
