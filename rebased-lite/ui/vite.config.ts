import { defineConfig } from "vite";

// The dev server proxies commands to `rebased-devserver` when the UI runs in a browser.
export default defineConfig({
  clearScreen: false,
  server: { port: 5173, strictPort: true, proxy: { "/api": "http://127.0.0.1:5174" } },
  build: { target: "es2022", chunkSizeWarningLimit: 4000 },
});
