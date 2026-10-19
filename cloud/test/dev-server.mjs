import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createFakeGithub } from "./fake-github.mjs";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = path.join(root, "node_modules", "wrangler", "bin", "wrangler.js");

export async function startDev({ port, vars = {} }) {
  const token = crypto.randomUUID();
  const base = `http://127.0.0.1:${port}`;
  const devVars = path.join(root, ".dev.vars");
  const probeVars = path.join(root, "test", "probe", ".dev.vars");
  const persist = fs.mkdtempSync(path.join(os.tmpdir(), "mailtemp-cloud-"));
  let log = "";
  const lines = Object.entries({ SESSION_KEY: crypto.randomBytes(24).toString("hex"), ...vars }).map(([key, value]) => `${key}=${value}\n`);
  fs.writeFileSync(devVars, lines.join(""));
  fs.writeFileSync(probeVars, `PROBE_TOKEN=${token}\n`);
  const migrate = spawnSync(process.execPath, [wrangler, "d1", "migrations", "apply", "DB", "--local", "--persist-to", persist], { cwd: root, encoding: "utf8" });
  assert.equal(migrate.status, 0, migrate.stdout + migrate.stderr);
  const dev = spawn(process.execPath, [wrangler, "dev", "-c", "test/probe/wrangler.toml", "-c", "wrangler.toml", "--local", "--port", String(port), "--local-upstream", `127.0.0.1:${port}`, "--persist-to", persist], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
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

export const SSO_USERS = {
  owner: { id: 7001, login: "sso-owner" },
  admin: { id: 7002, login: "sso-helper" },
  stranger: { id: 7003, login: "sso-stranger" },
};

export async function startSsoDev({ port, interactive = false }) {
  const github = createFakeGithub({ interactive });
  for (const user of Object.values(SSO_USERS)) github.addAccount(user.login, user.id);
  const githubPort = await github.listen();
  try {
    const dev = await startDev({
      port,
      vars: {
        GITHUB_CLIENT_ID: github.clientId,
        GITHUB_CLIENT_SECRET: github.clientSecret,
        OWNER_GITHUB_IDS: String(SSO_USERS.owner.id),
        GITHUB_OAUTH_BASE: `http://localhost:${githubPort}`,
        GITHUB_API_BASE: `http://127.0.0.1:${githubPort}`,
      },
    });
    return { ...dev, github, githubPort, stop: async () => { await dev.stop(); await github.close(); } };
  } catch (err) {
    await github.close();
    throw err;
  }
}
