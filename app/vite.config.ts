import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Cross-origin isolation lets bb.js use threads (SharedArrayBuffer). Without it
// proving still works, single-threaded and slower.
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  base: "./",
  plugins: [react()],
  server: { headers: isolation, port: 5173 },
  preview: { headers: isolation, port: 4173 },
  optimizeDeps: {
    exclude: ["@aztec/bb.js", "@noir-lang/noir_js", "@noir-lang/acvm_js", "@noir-lang/noirc_abi"],
    esbuildOptions: { target: "esnext" },
  },
  build: { target: "esnext", chunkSizeWarningLimit: 4200 },
  worker: { format: "es" },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
} as never);
