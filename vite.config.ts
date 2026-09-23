import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  publicDir: "desktop/public",
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/.qa/**", "**/src-tauri/target/**", "**/public/**"] },
  },
  build: { target: "es2022", outDir: "dist-desktop" },
});
