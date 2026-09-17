import type { Theme } from "../theme";

const palettes = {
  light: {
    primary: "#121814",
    primaryForeground: "#ffffff",
    background: "#ffffff",
    foreground: "#121814",
    muted: "#6b726c",
    border: "#e5e2da",
    danger: "#b8301e",
    success: "#117a47",
  },
  dark: {
    primary: "#58c99b",
    primaryForeground: "#101512",
    background: "#171e1a",
    foreground: "#f2f0e9",
    muted: "#929d96",
    border: "#2b352f",
    danger: "#ff806f",
    success: "#63cf91",
  },
} as const;

// Clerk derives additional colour scales from concrete values, so these mirror
// the active CSS theme instead of passing custom properties through to Clerk.
export function clerkAppearance(theme: Theme) {
  const palette = palettes[theme];
  return {
    variables: {
      colorPrimary: palette.primary,
      colorPrimaryForeground: palette.primaryForeground,
      colorBackground: palette.background,
      colorForeground: palette.foreground,
      colorInput: palette.background,
      colorInputForeground: palette.foreground,
      colorMutedForeground: palette.muted,
      colorBorder: palette.border,
      colorNeutral: palette.foreground,
      colorDanger: palette.danger,
      colorSuccess: palette.success,
      borderRadius: "0.75rem",
      fontFamily: '"Schibsted Grotesk Variable", ui-sans-serif, system-ui, sans-serif',
    },
    elements: {
      rootBox: "w-full min-w-0",
      cardBox: "w-full !max-w-none !rounded-[18px] !shadow-[var(--shadow-card)]",
      card: "!px-4 sm:!px-8",
      formFieldInput: "!min-h-11 !text-base sm:!text-sm",
      formButtonPrimary: "!min-h-11",
      socialButtonsBlockButton: "!min-h-11",
      header: "!items-start !text-left",
      headerTitle:
        "!font-display !text-[38px] sm:!text-[46px] !font-normal !leading-[1.08] !tracking-[-0.01em] !text-ink",
      headerSubtitle: "!mt-3 !text-[15px] !text-ink-2",
    },
  };
}
