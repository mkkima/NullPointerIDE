import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  build: {
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: "oxc",
    sourcemap: false,
  },
});
