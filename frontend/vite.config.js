import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The React dev server runs on :5173 and forwards the WebSocket and API
// calls to Django on :8000, so the browser never has to deal with CORS.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/ws": { target: "ws://127.0.0.1:8000", ws: true, changeOrigin: true },
      "/api": { target: "http://127.0.0.1:8000", changeOrigin: true },
    },
  },
});
