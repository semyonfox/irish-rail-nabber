import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  AccessibilityInfo,
  Animated,
  BackHandler,
  Easing,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type PressableProps,
  type TextInputProps,
  type TextProps,
} from "react-native";
import { useFocusEffect } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";

import { Icon } from "./icons";
import { fonts, usePalette } from "./theme";

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: {
    width: "100%",
    maxWidth: 640,
    alignSelf: "center",
    padding: 20,
    paddingTop: 16,
    paddingBottom: 24,
    gap: 20,
  },
  heading: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  headingCopy: { flex: 1, gap: 2 },
  label: { fontSize: 15, fontFamily: fonts.strong, lineHeight: 21 },
  body: { fontSize: 16, lineHeight: 24 },
  small: { fontSize: 14, lineHeight: 20 },
  title: { fontFamily: fonts.display, fontSize: 47, lineHeight: 51 },
  section: { fontFamily: fonts.strong, fontSize: 19, lineHeight: 25 },
  mono: { fontFamily: fonts.mono, fontVariant: ["tabular-nums"] },
  button: {
    minWidth: 44,
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
    borderWidth: 1,
  },
  iconButton: { width: 44, paddingHorizontal: 0 },
  input: {
    minHeight: 50,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderRadius: 8,
    fontFamily: fonts.body,
    fontSize: 16,
    flex: 1,
  },
  card: { overflow: "hidden", borderWidth: 1, borderRadius: 14 },
  notice: {
    padding: 14,
    gap: 8,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "flex-start",
  },
  row: {
    minHeight: 55,
    paddingHorizontal: 13,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
});

type CopyProps = TextProps & {
  variant?: "title" | "section" | "body" | "small" | "label";
  tone?: keyof Omit<ReturnType<typeof usePalette>, "dark">;
};

export function Copy({
  variant = "body",
  tone = "ink",
  style,
  ...props
}: CopyProps) {
  const colours = usePalette();
  return (
    <Text
      {...props}
      style={[
        { color: colours[tone], fontFamily: fonts.body },
        styles[variant],
        style,
      ]}
    />
  );
}

export function Figures(props: CopyProps) {
  return <Copy {...props} style={[styles.mono, props.style]} />;
}

type ButtonProps = {
  label: string;
  onPress: NonNullable<PressableProps["onPress"]>;
  selected?: boolean;
  primary?: boolean;
  busy?: boolean;
  disabled?: boolean;
  icon?: "refresh" | "close";
};

export function Button({
  label,
  onPress,
  selected,
  primary,
  busy,
  disabled,
  icon,
}: ButtonProps) {
  const colours = usePalette();
  const [focused, setFocused] = useState(false);
  const colour = primary ? colours.onBrand : colours.brand;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected, busy, disabled: busy || disabled }}
      disabled={busy || disabled}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={({ pressed }) => [
        styles.button,
        icon && styles.iconButton,
        {
          backgroundColor: primary
            ? colours.brand
            : selected || pressed
              ? colours.brandSoft
              : colours.card,
          borderColor:
            focused || selected || primary ? colours.brand : colours.lineStrong,
          opacity: busy || disabled || (primary && pressed) ? 0.7 : 1,
        },
      ]}
    >
      {icon ? (
        <Icon name={icon} colour={colour} />
      ) : (
        <Copy variant="label" style={{ color: colour }}>
          {label}
        </Copy>
      )}
    </Pressable>
  );
}

export function Screen({
  title,
  refresh,
  refreshing = false,
  children,
}: {
  title: string;
  refresh?: () => Promise<void>;
  refreshing?: boolean;
  children: ReactNode;
}) {
  const colours = usePalette();
  return (
    <SafeAreaView
      edges={["top", "left", "right"]}
      style={[styles.scroll, { backgroundColor: colours.paper }]}
    >
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          refresh && Platform.OS !== "web" ? (
            <RefreshControl
              refreshing={refreshing}
              onRefresh={refresh}
              tintColor={colours.brand}
              colors={[colours.brand]}
            />
          ) : undefined
        }
      >
        <View style={styles.heading}>
          <View style={styles.headingCopy}>
            <Copy
              variant="label"
              tone={title === "Buses" ? "busDeep" : "brand"}
            >
              Traein
            </Copy>
            <Copy variant="title" accessibilityRole="header">
              {title}
            </Copy>
          </View>
          {refresh ? (
            <Button
              label="Refresh"
              icon="refresh"
              onPress={refresh}
              busy={refreshing}
            />
          ) : null}
        </View>
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  const colours = usePalette();
  const [focused, setFocused] = useState(false);
  return (
    <View style={{ gap: 5 }}>
      <Copy variant="label" tone="secondary">
        {label}
      </Copy>
      <TextInput
        {...props}
        accessibilityLabel={label}
        autoCapitalize="none"
        autoCorrect={false}
        placeholderTextColor={colours.muted}
        selectionColor={colours.brand}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[
          styles.input,
          {
            color: colours.ink,
            borderColor: focused ? colours.brand : colours.control,
            backgroundColor: colours.card,
          },
        ]}
      />
    </View>
  );
}

export function Card({ children }: { children: ReactNode }) {
  const colours = usePalette();
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: colours.card, borderColor: colours.line },
      ]}
    >
      {children}
    </View>
  );
}

export function Row({
  children,
  onPress,
  first = false,
}: {
  children: ReactNode;
  onPress?: () => void;
  first?: boolean;
}) {
  const colours = usePalette();
  const [focused, setFocused] = useState(false);
  const border = {
    borderTopWidth: first ? 0 : 1,
    borderTopColor: colours.line,
  };
  if (!onPress) return <View style={[styles.row, border]}>{children}</View>;

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={({ pressed }) => [
        styles.row,
        border,
        {
          backgroundColor:
            focused || pressed ? colours.brandSoft : colours.card,
        },
      ]}
    >
      {children}
      <Icon name="next" colour={colours.muted} size={17} />
    </Pressable>
  );
}

export function Notice({
  title,
  children,
  darken = false,
  retry,
}: {
  title: string;
  children?: ReactNode;
  darken?: boolean;
  retry?: () => void;
}) {
  const colours = usePalette();
  useAnnounce(title);
  return (
    <View
      style={[
        styles.notice,
        {
          backgroundColor: darken ? colours.badSoft : colours.wash,
          borderColor: colours.line,
        },
      ]}
    >
      <Copy
        variant="label"
        tone={darken ? "bad" : "ink"}
        accessibilityLiveRegion="polite"
      >
        {title}
      </Copy>
      {children ? (
        <Copy variant="small" tone="secondary">
          {children}
        </Copy>
      ) : null}
      {retry ? <Button label="Try again" onPress={retry} /> : null}
    </View>
  );
}

// boards are in-tab state, not routes, so android back has to close them
export function useBack(onBack: () => void) {
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener("hardwareBackPress", () => {
        onBack();
        return true;
      });
      return () => sub.remove();
    }, [onBack]),
  );
}

// accessibilityLiveRegion is android only, so ios needs an explicit announcement
export function useAnnounce(message: string | null | undefined) {
  useEffect(() => {
    if (message && Platform.OS === "ios")
      AccessibilityInfo.announceForAccessibility(message);
  }, [message]);
}

export function useReducedMotion() {
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    let active = true;
    if (Platform.OS === "web" && typeof window !== "undefined") {
      const query = window.matchMedia("(prefers-reduced-motion: reduce)");
      const update = () => setReduced(query.matches);
      update();
      query.addEventListener("change", update);
      return () => query.removeEventListener("change", update);
    }
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (active) setReduced(value);
    });
    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReduced,
    );
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);
  return reduced;
}

export function Skeleton({
  label,
  mapHeight,
}: {
  label: string;
  mapHeight?: number;
}) {
  const colours = usePalette();
  const reduced = useReducedMotion();
  const [slow, setSlow] = useState(false);
  const [progress] = useState(() => new Animated.Value(0));

  useEffect(() => {
    const timeout = setTimeout(() => setSlow(true), 3000);
    return () => clearTimeout(timeout);
  }, []);

  useEffect(() => {
    if (reduced || slow) return;
    const wave = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: 1250,
        easing: Easing.linear,
        useNativeDriver: Platform.OS !== "web",
        isInteraction: false,
      }),
    );
    wave.start();
    return () => {
      wave.stop();
      progress.setValue(0);
    };
  }, [progress, reduced, slow]);

  const shimmer = (
    <Animated.View
      style={{
        width: 70,
        height: "100%",
        backgroundColor: colours.wash,
        opacity: 0.65,
        transform: [
          {
            translateX: progress.interpolate({
              inputRange: [0, 1],
              outputRange: [-90, 640],
            }),
          },
        ],
      }}
    />
  );

  return (
    <View
      accessible
      accessibilityLabel={label}
      accessibilityRole="progressbar"
      accessibilityState={{ busy: true }}
    >
      {mapHeight ? (
        <View
          style={{
            height: mapHeight,
            overflow: "hidden",
            backgroundColor: colours.map,
          }}
        >
          {!reduced && !slow ? shimmer : null}
        </View>
      ) : (
        <Card>
          {[0, 1, 2].map((row) => (
            <Row key={row} first={row === 0}>
              <View
                style={{
                  height: 12,
                  width: row === 1 ? "62%" : "46%",
                  backgroundColor: colours.line,
                  borderRadius: 4,
                  overflow: "hidden",
                }}
              >
                {!reduced && !slow ? shimmer : null}
              </View>
            </Row>
          ))}
        </Card>
      )}
      {slow ? (
        <Copy variant="small" tone="secondary" accessibilityLiveRegion="polite">
          {label}…
        </Copy>
      ) : null}
    </View>
  );
}

// a clock that ticks, so countdowns move between polls
export function useNow(interval = 30_000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [interval]);
  return now;
}

// riders think in minutes until it leaves, not clock times
export function dueText(minutes: number) {
  if (minutes <= 0) return "Due";
  if (minutes < 60) return `in ${minutes} min`;
  return null;
}

export function Delay({
  minutes,
  cancelled = false,
  scheduled = false,
  gone,
}: {
  minutes: number | null;
  cancelled?: boolean;
  scheduled?: boolean;
  gone?: "Departed" | "Arrived";
}) {
  const label = cancelled
    ? "Cancelled"
    : gone
      ? gone
      : minutes == null
        ? scheduled
          ? "No live delay"
          : "No estimate"
        : minutes > 0
          ? `+${minutes} min`
          : minutes < 0
            ? `${Math.abs(minutes)} min early`
            : "On time";

  return (
    <Figures
      variant="small"
      tone={
        cancelled
          ? "bad"
          : gone
            ? "secondary"
            : (minutes ?? 0) >= 15
              ? "bad"
              : (minutes ?? 0) > 0
                ? "warn"
                : minutes === 0
                  ? "ok"
                  : "secondary"
      }
      style={{ textAlign: "right", maxWidth: "30%" }}
    >
      {label}
    </Figures>
  );
}
