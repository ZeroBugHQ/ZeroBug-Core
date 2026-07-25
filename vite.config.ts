import { defineConfig, loadEnv, mergeConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";

// TanStack Start + Vite configuration. Production SSR error handling lives in
// src/server.ts (error-capture + renderErrorPage).
export default defineConfig(({ mode }) => {
  // VITE_* env injection — Vite exposes these to import.meta.env already, but the
  // wrapper defined them explicitly so SSR and the build see identical values.
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const define = Object.fromEntries(
    Object.entries(env).map(([k, v]) => [`import.meta.env.${k}`, JSON.stringify(v)]),
  );

  return mergeConfig(
    {
      // Dev server default (matches the wrapper): all interfaces, port 8080.
      server: { host: "::", port: 8080 },
    },
    {
      define,
      // Lightning CSS in BOTH dev and build so the dev preview matches the built
      // CSS output (e.g. -webkit-backdrop-filter collapsing). Dropping this causes
      // dev/build drift.
      css: { transformer: "lightningcss" },
      resolve: {
        alias: { "@": `${process.cwd()}/src` },
        // Dedupe React/TanStack across the SSR + client graphs to avoid duplicate
        // copies (invalid-hook-call class breakage).
        dedupe: [
          "react",
          "react-dom",
          "react/jsx-runtime",
          "react/jsx-dev-runtime",
          "@tanstack/react-query",
          "@tanstack/query-core",
        ],
      },
      plugins: [
        tailwindcss(),
        tsConfigPaths({ projects: ["./tsconfig.json"] }),
        tanstackStart({
          // Block server-only modules from the client bundle.
          importProtection: {
            behavior: "error",
            client: { files: ["**/server/**"], specifiers: ["server-only"] },
          },
          // Redirect TanStack's bundled server entry to src/server.ts (our SSR
          // error wrapper).
          server: { entry: "server" },
        }),
        viteReact(),
      ],
    },
  );
});
