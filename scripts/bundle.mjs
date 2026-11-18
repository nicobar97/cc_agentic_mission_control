// npm run bundle [arm64|x64]: builds the UI, embeds a relocatable Python (python-build-standalone, sha256-checked)
// and packages an unsigned macOS app plus a zip per architecture in release/. The server only needs the stdlib.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const TAG = "20261110", PY = "3.13.18";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const TRIPLE = { arm64: "aarch64-apple-darwin", x64: "x86_64-apple-darwin" };
const archs = [process.argv[2] || "arm64"];   // Apple Silicon by default; `npm run bundle x64` builds an Intel one
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: ROOT, stdio: "inherit", ...opts });
const get = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: ${r.status}`); return Buffer.from(await r.arrayBuffer()); };

async function python(arch) {
  const dir = path.join(ROOT, "build", `python-${arch}`);
  if (fs.existsSync(path.join(dir, "python", "bin", "python3"))) return dir;
  const name = `cpython-${PY}+${TAG}-${TRIPLE[arch]}-install_only_stripped.tar.gz`;
  const base = `https://github.com/astral-sh/python-build-standalone/releases/download/${TAG}/`;
  console.log(`downloading ${name}`);
  const [tgz, sums] = await Promise.all([get(base + name.replace("+", "%2B")), get(base + "SHA256SUMS")]);
  const want = sums.toString().split("\n").map((l) => l.trim().split(/\s+/)).find((p) => p[1] === name)?.[0];
  const got = createHash("sha256").update(tgz).digest("hex");
  if (!want || want !== got) throw new Error(`sha256 mismatch for ${name}: expected ${want}, got ${got}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "python.tar.gz");
  fs.writeFileSync(file, tgz);
  run("tar", ["-xzf", file, "-C", dir]);   // untrusted archive: extracted into its own new directory, never run from here
  fs.rmSync(file);
  return dir;
}

// electron-packager copies a symlink as an absolute link back into this checkout, which dangles on any other Mac:
// replace every symlink by a real copy first, and drop what the server never uses (tests, idle, pip, turtle demos)
function solidify(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.lstatSync(p).isSymbolicLink()) {
      const real = fs.realpathSync(p);
      fs.rmSync(p);
      fs.cpSync(real, p, { recursive: true, dereference: true });
    }
    if (fs.lstatSync(p).isDirectory()) solidify(p);
  }
}
function slim(py) {
  for (const d of ["lib/python3.13/test", "lib/python3.13/idlelib", "lib/python3.13/turtledemo", "lib/python3.13/ensurepip",
    "lib/python3.13/site-packages", "share", "include"]) fs.rmSync(path.join(py, d), { recursive: true, force: true });
  for (const f of fs.readdirSync(path.join(py, "bin"))) if (!/^python3(\.13)?$/.test(f)) fs.rmSync(path.join(py, "bin", f), { recursive: true, force: true });
}

run("npm", ["run", "build"]);
const IGNORE = "^/(build|src|scripts|screenshots|release|node_modules|\\.scratch|\\.git|\\.DS_Store|run\\.log|server\\.pid|index\\.html|vite\\.config\\.ts|tsconfig\\.json|README\\.md|CLAUDE\\.local\\.md)";
for (const arch of archs) {
  if (!TRIPLE[arch]) throw new Error(`unknown arch ${arch} (arm64 or x64)`);
  const dir = await python(arch);
  solidify(path.join(dir, "python"));
  slim(path.join(dir, "python"));
  run("npx", ["electron-packager", ".", "Mission Control", "--platform=darwin", `--arch=${arch}`, "--out=release", "--overwrite",
    "--prune=false", "--asar=false", "--icon=build/icon.icns", `--extra-resource=${path.join(dir, "python")}`, `--ignore=${IGNORE}`]);
  const app = path.join("release", `Mission Control-darwin-${arch}`, "Mission Control.app");
  // The packager's signature doesn't seal the files we add (Python, app code), so a quarantined copy reads as "damaged".
  // An ad-hoc signature over the whole bundle makes it valid: macOS then offers "Open Anyway" instead. (No Apple account needed.)
  run("codesign", ["--force", "--deep", "--sign", "-", app]);
  run("codesign", ["--verify", "--deep", "--strict", app]);
  const zip = path.join("release", `Mission-Control-${arch}.zip`);
  fs.rmSync(path.join(ROOT, zip), { force: true });
  run("ditto", ["-c", "-k", "--keepParent", app, zip]);   // ditto keeps the symlinks and attributes a .app needs; plain zip breaks it
  console.log(`\n${zip}  (${(fs.statSync(path.join(ROOT, zip)).size / 1e6).toFixed(0)} MB)`);
}
