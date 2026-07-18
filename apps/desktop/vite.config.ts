import { defineConfig, lazyPlugins } from "vite-plus";
// @vitejs/plugin-react 6+ uses the Oxc transform by default (the old Babel path
// and the short-lived -oxc fork are both retired), so it's clean under Vite 8.
import react from "@vitejs/plugin-react";

// Tauri expects a fixed port and leaves the terminal output alone so its own
// logs stay readable. src-tauri is ignored so Rust rebuilds don't trip HMR.
export default defineConfig({
  plugins: lazyPlugins(() => [react()]),
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
