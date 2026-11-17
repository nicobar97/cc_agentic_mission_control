// `npm run dev`: the Python API on :8765 (reused if one already answers there) plus Vite on :5173,
// which proxies /api. Ctrl-C stops what this script started.
import { spawn } from "node:child_process";

const api = process.env.MC_API_PORT || "8765";
const dev = process.env.MC_DEV_PORT || "5173";
let running = false;
try { running = (await fetch(`http://127.0.0.1:${api}/api/health`)).ok; } catch {}

const kids = [];
if (running) console.log(`API already running on :${api}, reusing it (write mode needs it started with --dev-origin http://127.0.0.1:${dev})`);
else kids.push(spawn("python3", ["-B", "server/server.py", "--port", api, "--dev-origin", `http://127.0.0.1:${dev}`], {
  stdio: "inherit", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
}));
kids.push(spawn("npx", ["vite"], { stdio: "inherit", env: { ...process.env, MC_API_PORT: api } }));

const stop = () => { kids.forEach((k) => k.kill("SIGTERM")); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
kids.forEach((k) => k.on("exit", stop));
