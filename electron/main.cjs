// Minimal Electron shell: starts the Python server on a free local port, opens it in a window, stops it on quit.
// Needs python3 on the machine and a built `dist/` (npm run build). Nothing else is bundled.
const { app, BrowserWindow, shell, dialog } = require("electron");
const { spawn, execFileSync } = require("child_process");
const net = require("net");
const path = require("path");
const fs = require("fs");
const http = require("http");

const ROOT = path.join(__dirname, "..");
let server = null;

// A GUI app on macOS doesn't inherit the shell PATH: add the usual places, then ask a login shell for `claude`.
function fixEnv() {
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", path.join(process.env.HOME || "", ".local/bin")];
  process.env.PATH = [...extra, process.env.PATH || ""].join(":");
  if (process.env.MC_CLAUDE_BIN) return;
  try {
    const p = execFileSync(process.env.SHELL || "/bin/zsh", ["-ilc", "command -v claude"], { encoding: "utf8", timeout: 5000 }).trim().split("\n").pop();
    if (p && fs.existsSync(p)) process.env.MC_CLAUDE_BIN = p;   // write mode needs it; read-only mode works without
  } catch (_) { /* no claude found: write mode will say so */ }
}

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer().unref().on("error", rej).listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
});

const waitUp = (port) => new Promise((res, rej) => {
  const t0 = Date.now();
  const tick = () => http.get({ host: "127.0.0.1", port, path: "/api/health" }, (r) => { r.resume(); res(); })
    .on("error", () => (Date.now() - t0 > 30000 ? rej(new Error("The server did not start in 30 s.")) : setTimeout(tick, 250)));
  tick();
});

async function start() {
  if (!fs.existsSync(path.join(ROOT, "dist", "index.html"))) throw new Error("dist/ is missing. Run `npm run build` first.");
  fixEnv();
  const port = await freePort();
  server = spawn("python3", ["-B", path.join(ROOT, "server", "server.py"), "--static", path.join(ROOT, "dist"), "--port", String(port)],
    { cwd: ROOT, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, stdio: "inherit" });
  server.on("exit", (code) => { if (!app.isQuitting && code) dialog.showErrorBox("Mission Control", `The server stopped (exit ${code}).`); });
  await waitUp(port);
  const win = new BrowserWindow({ width: 1400, height: 900, title: "Mission Control", backgroundColor: "#0b0d10" });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });   // external links open in the browser
  win.loadURL(`http://127.0.0.1:${port}/`);
}

app.on("before-quit", () => { app.isQuitting = true; if (server) server.kill(); });
app.on("window-all-closed", () => app.quit());
app.whenReady().then(() => { try { app.dock?.setIcon(path.join(ROOT, "build", "icon.png")); } catch (_) { /* packaged app: the .icns is used */ } return start(); }).catch((e) => { dialog.showErrorBox("Mission Control", String(e.message || e)); app.quit(); });
