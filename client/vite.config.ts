import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Browser talks only to Vite; Vite forwards API calls to Go. Same origin, no CORS.
    proxy: { "/api": { target: "http://localhost:8080", ws: true } },
  },
  build: {
    outDir: "../server/internal/web/dist",
    emptyOutDir: true, // wipes .gitkeep too; postbuild restores it
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 20_000, // Argon2 derivations take ~0.5s each
  },
});
