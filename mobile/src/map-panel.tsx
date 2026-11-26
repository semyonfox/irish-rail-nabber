import { useState } from "react";
import { useWindowDimensions, View } from "react-native";

import type { MapPoint } from "./map-data";
import { usePalette } from "./theme";
import { Button, Card, Copy, Figures, Notice, Skeleton } from "./ui";
import VehicleMap from "./vehicle-map";

const noun = (mode: "rail" | "bus", count: number) =>
  mode === "rail"
    ? count === 1
      ? "train"
      : "trains"
    : count === 1
      ? "bus"
      : "buses";

export function MapPanel({
  points,
  mode,
  caption,
  loading,
  error,
  empty,
  retry,
}: {
  points: MapPoint[];
  mode: "rail" | "bus";
  caption?: string | null;
  loading: boolean;
  error?: string;
  empty: string;
  retry: () => void;
}) {
  const colours = usePalette();
  const { height } = useWindowDimensions();
  const mapHeight = Math.max(320, Math.min(500, Math.round(height * 0.54)));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = points.find(({ id }) => id === selectedId);

  return (
    <View style={{ gap: 10 }}>
      {error ? (
        <Notice
          title={
            points.length > 0
              ? "Showing the last positions"
              : "Positions unavailable"
          }
          darken
          retry={retry}
        >
          {error}
        </Notice>
      ) : null}
      <Card>
        {loading ? (
          <Skeleton
            label={mode === "rail" ? "Loading trains" : "Loading buses"}
            mapHeight={mapHeight}
          />
        ) : (
          <View style={{ height: mapHeight, backgroundColor: colours.map }}>
            <VehicleMap points={points} mode={mode} onSelect={setSelectedId} />
          </View>
        )}
        {!loading ? (
          <View
            style={{
              paddingHorizontal: 13,
              paddingVertical: 10,
              gap: 6,
              borderTopWidth: 1,
              borderColor: colours.line,
            }}
          >
            {selected ? (
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                }}
              >
                <View style={{ flex: 1 }}>
                  <Copy variant="label">{selected.label}</Copy>
                  {selected.detail ? (
                    <Copy variant="small" tone="secondary">
                      {selected.detail}
                    </Copy>
                  ) : null}
                </View>
                <Button
                  label="Close vehicle details"
                  icon="close"
                  onPress={() => setSelectedId(null)}
                />
              </View>
            ) : (
              <Figures
                variant="small"
                tone="secondary"
                accessibilityLiveRegion="polite"
              >
                {points.length > 0
                  ? `${points.length} ${noun(mode, points.length)} on the map${caption ? ` · ${caption}` : ""}`
                  : error
                    ? "Positions unavailable"
                    : empty}
              </Figures>
            )}
          </View>
        ) : null}
      </Card>
    </View>
  );
}
