// The page's build (UI-55): Preact, `ui/dist`, no inline scripts or data URIs (UI-4's CSP). `npm run
// dev:ui` proxies `/api` to the running loop and borrows its token so actions work in dev.

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import preact from "@preact/preset-vite";
import { defineConfig, type Plugin } from "vite";

const LOOP = process.env.TOWERCAB_UI_API ?? "http://127.0.0.1:7311";

/** In dev, put the running loop's token in the page so POSTs pass UI-4's check. */
function loopToken(): Plugin {
  return {
    name: "towercab-token",
    apply: "serve",
    async transformIndexHtml(html) {
      try {
        const page = await (await fetch(`${LOOP}/`)).text();
        const token = /name="towercab-token" content="([0-9a-f]*)"/.exec(page)?.[1];
        if (token)
          return html.replace(
            /<meta name="towercab-token"[^>]*>/,
            `<meta name="towercab-token" content="${token}" />`,
          );
      } catch {
        // No loop running: the page is read-only.
      }
      return html;
    },
  };
}

export default defineConfig({
  root: dirname(fileURLToPath(import.meta.url)),
  plugins: [preact(), loopToken()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
  server: {
    proxy: {
      "/api": {
        target: LOOP,
        changeOrigin: true,
        configure(proxy) {
          // The loop checks Origin against its own Host.
          proxy.on("proxyReq", (req) => {
            if (req.getHeader("origin")) req.setHeader("origin", LOOP);
          });
        },
      },
    },
  },
});
