import { useMemo } from "react";

import type { MapPoint } from "../src/map-data";
import { MapPanel } from "../src/map-panel";
import { useApi } from "../src/session";
import { Screen } from "../src/ui";
import { useResource } from "../src/use-resource";

export default function Live() {
  const { trains } = useApi();
  const live = useResource(trains, { interval: 45_000 });
  const points = useMemo(
    () =>
      (live.data ?? []).flatMap<MapPoint>((train) => {
        const { latitude, longitude } = train;
        if (
          latitude == null ||
          longitude == null ||
          (latitude === 0 && longitude === 0)
        )
          return [];
        return [
          {
            id: `${train.trainCode}:${train.trainDate ?? ""}`,
            latitude,
            longitude,
            label: `Train ${train.trainCode}`,
            detail: [train.trainType, train.trainStatus, train.direction]
              .filter(Boolean)
              .join(" · "),
          },
        ];
      }),
    [live.data],
  );
  const unmapped = (live.data?.length ?? 0) - points.length;

  return (
    <Screen
      title="Live trains"
      refresh={live.refresh}
      refreshing={live.refreshing}
    >
      <MapPanel
        points={points}
        mode="rail"
        caption={unmapped > 0 ? `${unmapped} without a position` : null}
        loading={live.kind === "loading"}
        error={live.error}
        empty={
          live.data?.length
            ? "No trains have reported a position."
            : "No train positions reported."
        }
        retry={live.refresh}
      />
    </Screen>
  );
}
