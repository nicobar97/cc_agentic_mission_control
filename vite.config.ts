import { defineConfig, Plugin } from "vite";
import react from "@vitejs/plugin-react";

const API = `http://127.0.0.1:${process.env.MC_API_PORT || 8765}`;

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
  plugins: [react(), injectToken()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.MC_DEV_PORT || 5173),
    strictPort: true,
    proxy: { "/api": { target: API, changeOrigin: true } },
  },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 900 },
});
