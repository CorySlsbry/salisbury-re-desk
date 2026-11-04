import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  build: { rollupOptions: { input: { main: resolve(__dirname, "index.html"), splash: resolve(__dirname, "splash.html") } } },
  server: {
    port: 1420, strictPort: true, host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**", "**/sidecar/**", "**/vendor/**"] },
  },
}));
