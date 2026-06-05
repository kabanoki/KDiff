import { defineConfig } from "vite";

// Tauri expects a fixed dev port; keep the build lean for fast startup.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "esnext", minify: "esbuild", sourcemap: false },
});
