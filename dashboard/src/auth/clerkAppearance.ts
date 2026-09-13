// clerk derives its colour scales from concrete values, so these mirror the
// css tokens in index.css rather than referencing them
export const clerkAppearance = {
  variables: {
    colorPrimary: "#121814",
    colorPrimaryForeground: "#ffffff",
    colorBackground: "#ffffff",
    colorForeground: "#121814",
    colorInput: "#ffffff",
    colorInputForeground: "#121814",
    colorMutedForeground: "#6b726c",
    colorBorder: "#e5e2da",
    colorNeutral: "#121814",
    colorDanger: "#b8301e",
    colorSuccess: "#117a47",
    borderRadius: "0.75rem",
    fontFamily: '"Schibsted Grotesk Variable", ui-sans-serif, system-ui, sans-serif',
  },
  elements: {
    rootBox: "w-full",
    cardBox: "w-full !max-w-none !rounded-[18px] !shadow-[var(--shadow-card)]",
    header: "!items-start !text-left",
    headerTitle:
      "!font-display !text-[46px] !font-normal !leading-none !tracking-[-0.01em] !text-ink",
    headerSubtitle: "!mt-3 !text-[15px] !text-ink-2",
  },
};
