import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig, Plugin } from "vite";
import react from "@vitejs/plugin-react";

const API = `http://127.0.0.1:${process.env.MC_API_PORT || 8765}`;

// Version = package.json (bump with `npm version patch|minor|major`). Build = the git commit count at build time
// (always increasing), with the short sha, a "+" when the sources have uncommitted changes, and the build date.
const git = (a: string) => { try { return execSync("git " + a, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return ""; } };
const BUILD = {
  version: JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version as string,
  build: git("rev-list --count HEAD") || "0",
  commit: git("rev-parse --short HEAD"),
  dirty: !!git("status --porcelain -- src server electron scripts package.json index.html"),
  date: new Date().toISOString().slice(0, 10),
};

// Write mode in dev: the API (started with --dev-origin) hands its per-launch token to this server-side
// plugin only, which injects it into index.html exactly like the API does in production.
const injectToken = (): Plugin => ({
  name: "mc-token",
  async transformIndexHtml(html) {
    try {
      const r = await fetch(`${API}/api/dev-token`);
      if (!r.ok) return html;
      const { token } = (await r.json()) as { token: string };
      return html.replace("</head>", `<meta name="mc-token" content="${token}"></head>`);
    } catch {
      return html;
    }
  },
});

export default defineConfig({
  define: { __MC_BUILD__: JSON.stringify(BUILD) },
  plugins: [react(), injectToken()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.MC_DEV_PORT || 5173),
    strictPort: true,
    proxy: { "/api": { target: API, changeOrigin: true } },
  },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 900 },
});
