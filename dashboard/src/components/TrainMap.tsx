import { useEffect, useRef, useCallback } from "react";
import maplibregl from "maplibre-gl";
import { LIVE_TRAINS } from "../graphql/queries";
import { usePollingQuery } from "../utils/usePollingQuery";
import { delayColor } from "../utils/format";

interface Train {
  trainCode: string;
  latitude: number | null;
  longitude: number | null;
  trainStatus: string | null;
  direction: string | null;
  fetchedAt: string | null;
}

interface TrainsData {
  liveTrains: Train[];
}

interface Props {
  onTrainClick?: (trainCode: string) => void;
}

const IRELAND_CENTER: [number, number] = [-7.5, 53.4];
const POLL_MS = 5000;

export default function TrainMap({ onTrainClick }: Props) {
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<Map<string, maplibregl.Marker>>(new Map());
  const onTrainClickRef = useRef(onTrainClick);
  onTrainClickRef.current = onTrainClick;

  // use callback ref so we only init the map once per DOM node
  const containerRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    if (mapRef.current) return;

    const map = new maplibregl.Map({
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
            id: "osm",
            type: "raster",
            source: "osm",
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

    map.addControl(new maplibregl.NavigationControl(), "top-right");
    mapRef.current = map;
  }, []);

  // cleanup on unmount
  useEffect(() => {
    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
        markersRef.current.clear();
      }
    };
  }, []);

  const [{ data }] = usePollingQuery<TrainsData>({
    query: LIVE_TRAINS,
    pollInterval: POLL_MS,
  });

  // update markers when data changes
  useEffect(() => {
    if (!mapRef.current || !data?.liveTrains) return;

    const activeCodes = new Set<string>();

    for (const train of data.liveTrains) {
      if (train.latitude == null || train.longitude == null) continue;

      activeCodes.add(train.trainCode);
      const existing = markersRef.current.get(train.trainCode);

      if (existing) {
        existing.setLngLat([train.longitude, train.latitude]);
      } else {
        const el = document.createElement("div");
        el.style.width = "12px";
        el.style.height = "12px";
        el.style.borderRadius = "50%";
        el.style.backgroundColor = delayColor(null);
        el.style.border = "2px solid white";
        el.style.cursor = "pointer";

        el.addEventListener("click", () => {
          onTrainClickRef.current?.(train.trainCode);
        });

        const popup = new maplibregl.Popup({ offset: 10 }).setHTML(
          `<div style="color:#000;font-size:13px">
            <strong>${train.trainCode}</strong><br/>
            ${train.direction || ""}
          </div>`,
        );

        const marker = new maplibregl.Marker({ element: el })
          .setLngLat([train.longitude, train.latitude])
          .setPopup(popup)
          .addTo(mapRef.current!);

        markersRef.current.set(train.trainCode, marker);
      }
    }

    // remove stale markers
    for (const [code, marker] of markersRef.current) {
      if (!activeCodes.has(code)) {
        marker.remove();
        markersRef.current.delete(code);
      }
    }
  }, [data]);

  return <div ref={containerRef} className="h-full w-full" />;
}
