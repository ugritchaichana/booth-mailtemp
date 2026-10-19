import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = path.join(root, "node_modules", "wrangler", "bin", "wrangler.js");

export async function startDev({ port, adminPassword }) {
  const token = crypto.randomUUID();
  const base = `http://127.0.0.1:${port}`;
  const devVars = path.join(root, ".dev.vars");
  const probeVars = path.join(root, "test", "probe", ".dev.vars");
  const persist = fs.mkdtempSync(path.join(os.tmpdir(), "mailtemp-cloud-"));
  let log = "";
  fs.writeFileSync(devVars, `SESSION_KEY=${crypto.randomBytes(24).toString("hex")}\n${adminPassword ? `ADMIN_PASSWORD=${adminPassword}\n` : ""}`);
  fs.writeFileSync(probeVars, `PROBE_TOKEN=${token}\n`);
  const migrate = spawnSync(process.execPath, [wrangler, "d1", "migrations", "apply", "DB", "--local", "--persist-to", persist], { cwd: root, encoding: "utf8" });
  assert.equal(migrate.status, 0, migrate.stdout + migrate.stderr);
  const dev = spawn(process.execPath, [wrangler, "dev", "-c", "test/probe/wrangler.toml", "-c", "wrangler.toml", "--local", "--port", String(port), "--persist-to", persist], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  dev.stdout.on("data", (d) => { log += d; });
  dev.stderr.on("data", (d) => { log += d; });
  const stop = async () => {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(dev.pid), "/T", "/F"]);
    else dev.kill();
    await new Promise((r) => setTimeout(r, 1000));
    fs.rmSync(devVars, { force: true });
    fs.rmSync(probeVars, { force: true });
    try { fs.rmSync(persist, { recursive: true, force: true }); } catch {}
  };
  for (let i = 0; i < 120; i += 1) {
    try {
      if ((await fetch(`${base}/api/status`)).status === 200) return { base, token, log: () => log, stop };
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  await stop();
  throw new Error(`wrangler dev did not start\n${log}`);
}

export async function probeIngest(base, token, params) {
  const res = await fetch(`${base}/__probe/ingest?${new URLSearchParams(params)}`, { method: "POST", headers: { "x-probe-token": token } });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return body;
}
