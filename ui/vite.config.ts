import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => ({
  // GitHub Pages serves the read-only demo below the landing page.
  base: mode === "demo" ? "/home-twin/demo/" : "/",
  plugins: [
    react(),
    {
      // Pages serves the demo below a site root that has no favicon to fall back on.
      name: "demo-favicon",
      transformIndexHtml: (html) =>
        mode === "demo" ? html.replace("</head>", '  <link rel="icon" href="data:," />\n  </head>') : html,
    },
  ],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": process.env.HOME_TWIN_API ?? "http://127.0.0.1:8123",
    },
  },
  build: {
    sourcemap: mode !== "demo",
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
}));
