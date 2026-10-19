import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildMessage } from "./probe/worker.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = path.join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const MIB = 1024 * 1024;
const sizes = { small: 100_000, medium: 5 * MIB, large: 24 * MIB };
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const live = Boolean(process.env.PROBE_URL);
const port = Number(process.env.PORT ?? 8799);
const base = live ? (process.env.PUBLIC_URL ?? "https://mail.booth.pp.ua") : `http://127.0.0.1:${port}`;
const probeBase = live ? process.env.PROBE_URL : base;
const token = live ? process.env.PROBE_TOKEN : crypto.randomUUID();
const devVars = path.join(root, ".dev.vars");
const probeVars = path.join(root, "test", "probe", ".dev.vars");
const persist = live ? null : fs.mkdtempSync(path.join(os.tmpdir(), "mailtemp-cloud-"));
const owner = live ? "cloudcheck" : "inboxcheck";
let dev = null;
let devLog = "";

async function startLocal() {
  fs.writeFileSync(devVars, `SESSION_KEY=${crypto.randomBytes(24).toString("hex")}\n`);
  fs.writeFileSync(probeVars, `PROBE_TOKEN=${token}\n`);
  const migrate = spawnSync(process.execPath, [wrangler, "d1", "migrations", "apply", "DB", "--local", "--persist-to", persist], { cwd: root, encoding: "utf8" });
  assert.equal(migrate.status, 0, migrate.stdout + migrate.stderr);
  dev = spawn(process.execPath, [wrangler, "dev", "-c", "test/probe/wrangler.toml", "-c", "wrangler.toml", "--local", "--port", String(port), "--persist-to", persist], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  dev.stdout.on("data", (d) => { devLog += d; });
  dev.stderr.on("data", (d) => { devLog += d; });
  for (let i = 0; i < 120; i += 1) {
    try {
      if ((await fetch(`${base}/api/status`)).status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`wrangler dev did not start\n${devLog}`);
}

async function cleanup() {
  if (dev) {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(dev.pid), "/T", "/F"]);
    else dev.kill();
    await new Promise((r) => setTimeout(r, 1000));
  }
  fs.rmSync(devVars, { force: true });
  fs.rmSync(probeVars, { force: true });
  if (persist) {
    try { fs.rmSync(persist, { recursive: true, force: true }); } catch {}
  }
}

async function ingest(params) {
  const res = await fetch(`${probeBase}/__probe/ingest?${new URLSearchParams(params)}`, { method: "POST", headers: { "x-probe-token": token } });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return body;
}

class Browser {
  cookie = "";

  async call(method, pathname, body) {
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0];
    return res;
  }

  async open(username) {
    const res = await this.call("POST", "/api/open", { username });
    assert.equal(res.status, 200, await res.clone().text());
    return res.json();
  }

  async list() {
    return (await (await this.call("GET", "/api/messages")).json()).messages;
  }
}

const mail = (name) => ({
  to: `${owner}${name === "small" ? "" : "+01"}@booth.pp.ua`,
  subject: `${owner} ${name}`,
  id: `${owner}-${name}`,
});

try {
  if (!live) await startLocal();
  const status = await (await fetch(`${base}/api/status`)).json();
  assert.equal(status.d1, "ok");
  assert.equal((await fetch(`${base}/api/messages`)).status, 401);
  assert.equal((await fetch(`${base}/api/messages/abc/raw`)).status, 401);
  if (live) console.log(`home ${(await fetch(`${base}/`)).status}`);

  const stored = {};
  for (const [name, size] of Object.entries(sizes)) {
    const body = await ingest({ size, ...mail(name), ...(name === "medium" ? { stream: "1" } : {}) });
    stored[name] = body;
    assert.equal(body.result.stored, true);
    console.log(`ingest ${name} size=${size} chunks=${body.result.chunks} wallMs=${body.wallMs}`);
  }
  assert.equal(stored.small.result.chunks, 1);
  assert.equal(stored.large.result.chunks, Math.ceil(sizes.large / 1_440_000));
  if (!live) {
    assert.equal((await ingest({ size: 100_000, ...mail("small") })).result.duplicate, true);
    await ingest({ size: 20_000, to: "someoneelse@booth.pp.ua", id: "other-1", subject: "stranger" });
  }

  const alice = new Browser();
  assert.equal((await alice.open(owner)).address, `${owner}@booth.pp.ua`);
  const listed = await alice.list();
  for (const name of Object.keys(sizes)) assert.ok(listed.some((m) => m.subject === mail(name).subject), `${name} is listed`);
  assert.equal(listed.find((m) => m.subject === mail("small").subject).attachments, 1);

  const tagged = new Browser();
  await tagged.open(`${owner}+01`);
  const taggedSubjects = (await tagged.list()).map((m) => m.subject).sort();
  assert.deepEqual(taggedSubjects, [mail("large").subject, mail("medium").subject].sort());
  console.log(`${owner} lists ${listed.length}, ${owner}+01 lists ${taggedSubjects.length}`);

  const stranger = new Browser();
  await stranger.open(live ? "cloudcheck-other" : "someoneelse");
  assert.ok(!(await stranger.list()).some((m) => m.subject.startsWith(owner)));

  for (const [name, size] of Object.entries(sizes)) {
    const id = listed.find((m) => m.subject === mail(name).subject).id;
    const res = await alice.call("GET", `/api/messages/${id}/raw`);
    assert.equal(res.status, 200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const expected = buildMessage({ size, ...mail(name) });
    console.log(`raw ${name} bytes=${bytes.length} sha256=${sha(bytes)} equal=${sha(bytes) === sha(expected)}`);
    assert.equal(bytes.length, expected.length, name);
    assert.equal(sha(bytes), sha(expected), name);
    assert.equal((await stranger.call("GET", `/api/messages/${id}/raw`)).status, 404);
    if (name === "small") assert.equal((await tagged.call("GET", `/api/messages/${id}/raw`)).status, 404, "the +01 name must not read base-name mail");
  }

  const polled = (browser, since) => browser.call("GET", `/api/messages?since=${since}`).then((res) => res.json());
  const { cursor } = await (await alice.call("GET", "/api/messages")).json();
  assert.ok(cursor > 0);
  const idle = await polled(alice, cursor);
  assert.deepEqual([idle.messages, idle.cursor, idle.incremental], [[], cursor, true]);
  assert.equal((await alice.call("GET", "/api/messages?since=abc")).status, 400);
  assert.equal((await alice.call("GET", "/api/messages?since=-1")).status, 400);
  if (!live) {
    await ingest({ size: 20_000, to: `${owner}@booth.pp.ua`, id: "since-mine", subject: "since mine" });
    await ingest({ size: 20_000, to: "someoneelse@booth.pp.ua", id: "since-theirs", subject: "since theirs" });
    const next = await polled(alice, cursor);
    assert.deepEqual(next.messages.map((m) => m.subject), ["since mine"]);
    assert.ok(next.cursor > cursor);
    assert.deepEqual((await polled(stranger, cursor)).messages.map((m) => m.subject), ["since theirs"]);
    assert.deepEqual((await polled(alice, next.cursor)).messages, []);
    console.log(`since poll: idle 0 messages, one new mail, cursor ${cursor} -> ${next.cursor}`);
  }

  if (!live) {
    assert.equal((await alice.list()).find((m) => m.subject === mail("small").subject).read, true);
    assert.equal((await tagged.list()).find((m) => m.subject === mail("medium").subject).read, false);
    const target = listed.find((m) => m.subject === mail("small").subject).id;
    assert.equal((await tagged.call("DELETE", `/api/messages/${target}`)).status, 404);
    assert.equal((await alice.call("DELETE", `/api/messages/${target}`)).status, 200);
    assert.equal((await alice.call("GET", `/api/messages/${target}/raw`)).status, 404);
    assert.equal((await alice.call("POST", "/api/switch", { username: "never-opened" })).status, 403);
    assert.match((await (await alice.call("GET", "/api/random")).json()).username, /^rand-[a-z0-9]{6}$/);
    assert.equal((await alice.call("POST", "/api/open", { username: "qa-blocked" })).status, 400);
    assert.equal((await (await alice.call("POST", "/api/forget", { username: owner })).json()).active, null);
    assert.equal((await alice.call("GET", "/api/me")).status, 401);
  }
  console.log("integration: all checks passed");
} finally {
  await cleanup();
}
process.exit(0);
