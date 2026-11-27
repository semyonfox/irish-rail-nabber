import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { StyleSheet, Text, View } from "react-native";
import MapView, { Marker } from "react-native-maps";

import { ireland, mapGroups, type VehicleMapProps } from "./map-data";
import { fonts, usePalette } from "./theme";
import { useReducedMotion } from "./ui";

// custom view markers re-snapshot on every frame unless tracking is off, but
// android can snapshot a blank view if it's off from the start. track briefly,
// then stop. the key changes with the content, which remounts the marker
function StillMarker(props: ComponentProps<typeof Marker>) {
  const [tracking, setTracking] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setTracking(false), 500);
    return () => clearTimeout(timer);
  }, []);
  return <Marker {...props} tracksViewChanges={tracking} />;
}

export default function VehicleMap({
  points,
  mode,
  onSelect,
}: VehicleMapProps) {
  const colours = usePalette();
  const reduced = useReducedMotion();
  const [region, setRegion] = useState(ireland);
  const map = useRef<MapView>(null);
  const groups = useMemo(() => mapGroups(points, region), [points, region]);
  const fill = mode === "bus" ? colours.bus : colours.brand;
  const ink = mode === "bus" ? "#18120a" : colours.onBrand;

  return (
    <MapView
      ref={map}
      style={StyleSheet.absoluteFill}
      initialRegion={ireland}
      userInterfaceStyle={colours.dark ? "dark" : "light"}
      onRegionChangeComplete={setRegion}
      rotateEnabled={false}
      pitchEnabled={false}
      toolbarEnabled={false}
      showsIndoors={false}
    >
      {groups.map(({ id, key, latitude, longitude, count, label }) => (
        <StillMarker
          key={`${key}:${count}:${colours.dark}`}
          coordinate={{ latitude, longitude }}
          anchor={{ x: 0.5, y: 0.5 }}
          accessibilityLabel={count > 1 ? `${count} vehicles. Zoom in` : label}
          onPress={() => {
            if (count === 1) onSelect(id);
            else
              map.current?.animateToRegion(
                {
                  latitude,
                  longitude,
                  latitudeDelta: region.latitudeDelta * 0.4,
                  longitudeDelta: region.longitudeDelta * 0.4,
                },
                reduced ? 0 : 240,
              );
          }}
        >
          <View style={styles.hit}>
            <View
              style={[
                styles.dot,
                { backgroundColor: fill, borderColor: colours.card },
                count > 1 && styles.cluster,
              ]}
            >
              {count > 1 ? (
                <Text
                  style={{ color: ink, fontFamily: fonts.mono, fontSize: 12 }}
                >
                  {count}
                </Text>
              ) : null}
            </View>
          </View>
        </StillMarker>
      ))}
    </MapView>
  );
}

const styles = StyleSheet.create({
  hit: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  dot: { width: 14, height: 14, borderRadius: 14, borderWidth: 2 },
  cluster: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
});
