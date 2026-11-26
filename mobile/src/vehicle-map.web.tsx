import { useEffect, useRef, useState } from "react";
import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./vehicle-map.css";

import { ireland, mapGroups, type VehicleMapProps } from "./map-data";
import { usePalette } from "./theme";

export default function VehicleMap({
  points,
  mode,
  onSelect,
}: VehicleMapProps) {
  const colours = usePalette();
  const node = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const markerLayer = useRef<L.LayerGroup | null>(null);
  const tiles = useRef<L.TileLayer | null>(null);
  const [tilesUnavailable, setTilesUnavailable] = useState(false);

  useEffect(() => {
    if (!node.current) return;
    const instance = L.map(node.current, {
      scrollWheelZoom: false,
      zoomAnimation: false,
      fadeAnimation: false,
      markerZoomAnimation: false,
      inertia: false,
      minZoom: 5,
      zoomSnap: 0.5,
      maxZoom: 18,
    }).setView([ireland.latitude, ireland.longitude], 6.5);
    map.current = instance;
    markerLayer.current = L.layerGroup().addTo(instance);
    instance.attributionControl.setPrefix(false);
    let loadedTiles = 0;
    const base = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution:
        '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>',
      maxNativeZoom: 19,
    })
      .on("loading", () => {
        loadedTiles = 0;
      })
      .on("tileload", () => {
        loadedTiles += 1;
      })
      .on("load", () => setTilesUnavailable(loadedTiles === 0))
      .addTo(instance);
    tiles.current = base;
    const observer = new ResizeObserver(() =>
      instance.invalidateSize({ pan: false }),
    );
    observer.observe(node.current);
    return () => {
      observer.disconnect();
      instance.remove();
      map.current = null;
      markerLayer.current = null;
      tiles.current = null;
    };
  }, []);

  useEffect(() => {
    const instance = map.current;
    const layer = markerLayer.current;
    if (!instance || !layer) return;

    function draw() {
      if (!instance || !layer) return;
      const bounds = instance.getBounds();
      const centre = bounds.getCenter();
      layer.clearLayers();

      if (!instance.getSize().x || !instance.getSize().y) return;
      for (const { id, latitude, longitude, count, label } of mapGroups(
        points,
        {
          latitude: centre.lat,
          longitude: centre.lng,
          latitudeDelta: bounds.getNorth() - bounds.getSouth(),
          longitudeDelta: bounds.getEast() - bounds.getWest(),
        },
      )) {
        const title = count > 1 ? `${count} vehicles. Zoom in` : label;
        const icon = L.divIcon({
          className: `traein-pin ${mode} ${count > 1 ? "cluster" : ""}`,
          html: `<span>${count > 1 ? count : ""}</span>`,
          iconSize: [44, 44],
          iconAnchor: [22, 22],
        });
        const marker = L.marker([latitude, longitude], {
          title,
          alt: title,
          icon,
        })
          .on("click", () => {
            if (count === 1) onSelect(id);
            else
              instance.setView([latitude, longitude], instance.getZoom() + 2, {
                animate: false,
              });
          })
          .addTo(layer);
        marker.getElement()?.setAttribute("aria-label", title);
      }
    }
    draw();
    instance.on("moveend resize", draw);
    return () => {
      instance.off("moveend resize", draw);
    };
  }, [mode, onSelect, points]);

  return (
    <div className={colours.dark ? "traein-map dark" : "traein-map"}>
      <div
        className="traein-tiles"
        aria-label={mode === "rail" ? "Train positions" : "Bus positions"}
        role="region"
        ref={node}
        style={{ backgroundColor: colours.map }}
      />
      {tilesUnavailable ? (
        <button
          className="traein-map-retry"
          onClick={() => tiles.current?.redraw()}
        >
          Street map unavailable. Retry
        </button>
      ) : null}
    </div>
  );
}
