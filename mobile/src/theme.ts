import { useColorScheme } from "react-native";

const light = {
  dark: false,
  paper: "#f3f1ec",
  card: "#ffffff",
  wash: "#f7f6f2",
  line: "#e5e2da",
  lineStrong: "#d3cfc4",
  // text field boundary, 3.25:1 on paper and 3.67:1 on card
  control: "#818782",
  ink: "#121814",
  secondary: "#3d4540",
  muted: "#6b726c",
  brand: "#0b6b4d",
  brandSoft: "#e3f0ea",
  onBrand: "#ffffff",
  bus: "#d88a05",
  busDeep: "#8a5100",
  busSoft: "#fff1cf",
  ok: "#117a47",
  warn: "#945800",
  bad: "#b8301e",
  badSoft: "#fbe5e0",
  map: "#e9ebe6",
};

const dark: typeof light = {
  dark: true,
  paper: "#101512",
  card: "#171e1a",
  wash: "#1d2621",
  line: "#2b352f",
  lineStrong: "#3c4942",
  // 4.58:1 on paper and 4.21:1 on card
  control: "#77817b",
  ink: "#f2f0e9",
  secondary: "#c6cdc7",
  muted: "#929d96",
  brand: "#58c99b",
  brandSoft: "#173a2c",
  onBrand: "#101512",
  bus: "#f0aa2a",
  busDeep: "#ffc45b",
  busSoft: "#3a2b12",
  ok: "#63cf91",
  warn: "#f2b548",
  bad: "#ff806f",
  badSoft: "#3c211d",
  map: "#111713",
};

export const fonts = {
  body: "Schibsted",
  strong: "SchibstedSemiBold",
  display: "InstrumentSerif",
  mono: "GeistMono",
};

export function usePalette() {
  return useColorScheme() === "dark" ? dark : light;
}
