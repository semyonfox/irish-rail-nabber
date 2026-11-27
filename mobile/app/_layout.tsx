import { GeistMono_400Regular } from "@expo-google-fonts/geist-mono/400Regular";
import { InstrumentSerif_400Regular } from "@expo-google-fonts/instrument-serif/400Regular";
import { SchibstedGrotesk_400Regular } from "@expo-google-fonts/schibsted-grotesk/400Regular";
import { SchibstedGrotesk_600SemiBold } from "@expo-google-fonts/schibsted-grotesk/600SemiBold";
import { useFonts } from "expo-font";
import { Tabs } from "expo-router/js-tabs";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Icon } from "../src/icons";
import { accountEnabled, SessionProvider } from "../src/session";
import { fonts, usePalette } from "../src/theme";

export default function Layout() {
  const colours = usePalette();
  const { bottom } = useSafeAreaInsets();
  const [loaded, error] = useFonts({
    [fonts.body]: SchibstedGrotesk_400Regular,
    [fonts.strong]: SchibstedGrotesk_600SemiBold,
    [fonts.display]: InstrumentSerif_400Regular,
    [fonts.mono]: GeistMono_400Regular,
  });

  if (!loaded && !error) return null;

  return (
    <SessionProvider>
      <StatusBar style={colours.dark ? "light" : "dark"} />
      <Tabs
        screenOptions={{
          headerShown: false,
          animation: "none",
          tabBarHideOnKeyboard: true,
          tabBarActiveTintColor: colours.brand,
          tabBarInactiveTintColor: colours.secondary,
          tabBarStyle: {
            backgroundColor: colours.card,
            borderTopColor: colours.line,
            // the item needs 54px for icon, label and its own padding
            height: 68 + bottom,
            paddingTop: 6,
            paddingBottom: 8 + bottom,
          },
          tabBarLabelStyle: {
            fontFamily: fonts.strong,
            fontSize: 12,
            lineHeight: 16,
          },
          tabBarItemStyle: { minHeight: 44 },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: "Live",
            tabBarIcon: ({ color }) => <Icon name="live" colour={color} />,
          }}
        />
        <Tabs.Screen
          name="stations"
          options={{
            title: "Stations",
            tabBarIcon: ({ color }) => <Icon name="train" colour={color} />,
          }}
        />
        <Tabs.Screen
          name="buses"
          options={{
            title: "Buses",
            tabBarIcon: ({ color }) => <Icon name="bus" colour={color} />,
          }}
        />
        <Tabs.Screen
          name="account"
          options={{
            href: accountEnabled ? undefined : null,
            title: "Account",
            tabBarIcon: ({ color }) => <Icon name="account" colour={color} />,
          }}
        />
      </Tabs>
    </SessionProvider>
  );
}
