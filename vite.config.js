import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [tailwindcss(), sveltekit()],
  resolve: {
    alias: {
      $core: new URL("./src/lib/core", import.meta.url).pathname,
      $features: new URL("./src/lib/features", import.meta.url).pathname,
      $shared: new URL("./src/lib/shared", import.meta.url).pathname
    }
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: /** @param {string} id */ (id) => {
          if (!id.includes("node_modules")) return;
          if (id.includes("monaco-editor")) return "vendor-monaco";
          if (id.includes("@xterm")) return "vendor-xterm";
          if (id.includes("marked") || id.includes("svelte-streamdown")) {
            return "vendor-markdown";
          }
          if (id.includes("@tauri-apps")) return "vendor-tauri";
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
