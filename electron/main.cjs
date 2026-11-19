// Minimal Electron shell: starts the Python server on a free local port, opens it in a window, stops it on quit.
// Needs python3 on the machine and a built `dist/` (npm run build). Nothing else is bundled.
const { app, BrowserWindow, Menu, shell, dialog } = require("electron");
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
  // the server picks the newest `claude` it finds (runner.py), no slow login-shell lookup needed; MC_CLAUDE_BIN overrides
}

const PROFILE = "https://github.com/nicobar97";
const REPO = PROFILE + "/cc_agentic_mission_control";

// version from package.json; the build number comes from electron/build-info.json, written by `npm run bundle`
function buildInfo() {
  let b = {};
  try { b = JSON.parse(fs.readFileSync(path.join(__dirname, "build-info.json"), "utf8")); } catch (_) { /* running from source */ }
  return { version: b.version || app.getVersion(), build: b.build || "dev" };
}

// Menu bar: the standard menus plus an "Info" menu (version, license, author's GitHub profile). Links open in the browser.
function setMenu() {
  const { version, build } = buildInfo();
  const open = (url) => () => shell.openExternal(url);
  app.setAboutPanelOptions({ applicationName: "Mission Control", applicationVersion: version, version: String(build),
    copyright: "MIT License · © 2026 nicobar97", website: REPO });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: "appMenu" }, { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" },
    { label: "Info", submenu: [
      { label: `Mission Control v${version} · build ${build}`, enabled: false },
      { type: "separator" },
      { label: "License: MIT", click: open(REPO + "/blob/main/LICENSE") },
      { label: "GitHub profile: nicobar97", click: open(PROFILE) },
      { label: "Source code", click: open(REPO) },
    ] },
  ]));
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
  setMenu();
  const port = await freePort();
  // the packaged app carries its own Python (Resources/python); from source it falls back to the system python3
  const bundled = path.join(process.resourcesPath || "", "python", "bin", "python3");
  server = spawn(fs.existsSync(bundled) ? bundled : "python3", ["-B", path.join(ROOT, "server", "server.py"), "--static", path.join(ROOT, "dist"), "--port", String(port)],
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
