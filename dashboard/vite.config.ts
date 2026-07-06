import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // MapLibre is isolated behind the lazy live-map route. Keep the warning
    // budget above that vendor chunk so future non-map route regressions are
    // visible without treating the intentionally split map engine as app code.
    chunkSizeWarningLimit: 1100,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes("node_modules/maplibre-gl")) {
            return "vendor-map";
          }
          if (id.includes("node_modules/recharts")) {
            return "vendor-charts";
          }
          if (id.includes("node_modules/@tanstack/react-table")) {
            return "vendor-table";
          }
        },
      },
    },
  },
  server: {
    proxy: {
      "/graphql": "http://localhost:8000",
      "/api/chat": {
        target: "http://localhost:8000",
        rewrite: (path) => path.replace(/^\/api\/chat/, "/chat"),
      },
      "/auth": "http://localhost:8000",
      "/billing": "http://localhost:8000",
    },
  },
});
