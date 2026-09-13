import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";

import {
  busVehicleKey,
  busVehicleRoute,
  humanizeGtfsValue,
  speedKmh,
  type BusVehicle,
} from "../utils/busVehicles";
import { Card, Icon } from "./ui";
import {
  createIrelandMap,
  emptyCollection,
  featureCollection,
  pointFeature,
  setSourceData,
} from "./transitMap";

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

export default function BusVehicleMap({
  vehicles,
  fetching,
}: {
  vehicles: BusVehicle[];
  fetching: boolean;
}) {
  const mapRef = useRef<maplibregl.Map | null>(null);
  const fittedRef = useRef(false);
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

  const containerRef = useCallback((node: HTMLDivElement | null) => {
    if (!node || mapRef.current) return;

    let map: maplibregl.Map;
    try {
      map = createIrelandMap(node);
    } catch (error) {
      setMapError(error instanceof Error ? error.message : "Map unavailable");
      return;
    }

    map.addControl(new maplibregl.NavigationControl(), "top-right");
    map.on("load", () => {
      try {
        map.addSource(VEHICLE_SOURCE_ID, { type: "geojson", data: emptyCollection() });
        map.addLayer({
          id: VEHICLE_HALO_LAYER_ID,
          type: "circle",
          source: VEHICLE_SOURCE_ID,
          paint: {
            "circle-radius": ["case", ["get", "selected"], 17, 11],
            "circle-color": ["case", ["get", "selected"], "#171a18", "#d88a05"],
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
            "circle-color": ["case", ["get", "selected"], "#171a18", "#d88a05"],
            "circle-stroke-color": "#ffffff",
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
            "text-color": "#171a18",
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
      mapRef.current?.remove();
      mapRef.current = null;
      setMapReady(false);
    };
  }, []);

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

    if (fittedRef.current || vehicles.length === 0) return;
    fittedRef.current = true;
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
      title="Live bus positions"
      description="Vehicle locations from the same NTA snapshot as the departure boards."
      index={2}
      className="bus-map-card"
      actions={
        <span className="bus-map-count">
          <span className="live-dot" />
          {fetching && vehicles.length === 0
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
          aria-label="Live bus map"
        />

        {vehicles.length === 0 ? (
          <div className="bus-map-empty">
            <Icon name="bus" />
            <strong>{fetching ? "Loading live vehicle positions" : "No live positions yet"}</strong>
            <span>
              Stop search and schedule data still work. Tracking appears after a successful NTA
              realtime poll.
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
