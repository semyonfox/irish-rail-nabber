import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/graphql": "http://localhost:8000",
      "/auth": "http://localhost:8000",
      "/billing": "http://localhost:8000",
    },
  },
});
