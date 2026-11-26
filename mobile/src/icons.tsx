import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";

const paths = {
  live: "M3 12h4l3-7 4 14 3-7h4",
  train:
    "M5 15V6a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3Zm0-4h14M9 18l-3 3m9-3 3 3M8.5 14.5h.01m6.99 0h.01",
  bus: "M4 16V7a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Zm0-4h16M7 18v3m10-3v3M8 15h.01M16 15h.01",
  account:
    "M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a5 5 0 0 1 5-5h6a5 5 0 0 1 5 5v2",
  search: "m21 21-5-5m2-5a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z",
  next: "m9 18 6-6-6-6",
  refresh: "M20 10a8 8 0 1 0-.9 6M20 4v6h-6",
  close: "m6 6 12 12M6 18 18 6",
};

export function Icon({
  name,
  colour,
  size = 21,
}: {
  name: keyof typeof paths;
  colour: ColorValue;
  size?: number;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessible={false}>
      <Path
        d={paths[name]}
        fill="none"
        stroke={colour}
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
