import { defineConfig } from "vite";

// The demo is the Vite root: `index.html` at the repository root loads
// `src/demo/main.ts`. The library build is a separate `tsup` invocation
// (`npm run build:lib`), so nothing here has to serve two masters.
export default defineConfig({
  build: {
    outDir: "dist-demo",
    emptyOutDir: true,
    target: "es2022",
  },
  server: { host: "127.0.0.1" },
  preview: { host: "127.0.0.1" },
});
