import assert from "node:assert/strict";
import crypto from "node:crypto";
import { buildMessage } from "./probe/worker.js";
import { probeIngest, startDev } from "./dev-server.mjs";

const MIB = 1024 * 1024;
const sizes = { small: 100_000, medium: 5 * MIB, large: 24 * MIB };
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const live = Boolean(process.env.PROBE_URL);
const port = Number(process.env.PORT ?? 8799);
const base = live ? (process.env.PUBLIC_URL ?? "https://mail.booth.pp.ua") : `http://127.0.0.1:${port}`;
const probeBase = live ? process.env.PROBE_URL : base;
const adminPassword = crypto.randomBytes(12).toString("hex");
const owner = live ? "cloudcheck" : "inboxcheck";
let token = live ? process.env.PROBE_TOKEN : null;
let dev = null;

const ingest = (params) => probeIngest(probeBase, token, params);

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

async function adminChecks() {
  const call = (method, pathname, { body, cookie, csrf = true } = {}) => fetch(`${base}${pathname}`, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(csrf && method !== "GET" ? { "X-Admin": "1" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  const page = await call("GET", "/admin");
  assert.equal(page.status, 200, "/admin serves admin.html without a redirect");
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.equal(page.headers.get("content-security-policy"), "frame-ancestors 'none'");
  assert.match(await page.text(), /Admin sign in/);
  for (const p of ["/api/admin/stats", "/api/admin/messages", "/api/admin/messages/abc/raw"]) assert.equal((await call("GET", p)).status, 401, p);
  assert.equal((await call("POST", "/api/admin/login", { body: { password: adminPassword }, csrf: false })).status, 403);
  assert.equal((await call("POST", "/api/admin/login", { body: { password: "wrong" } })).status, 401);
  const login = await call("POST", "/api/admin/login", { body: { password: adminPassword } });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.match(login.headers.get("set-cookie"), /HttpOnly; SameSite=Strict; Path=\/api\/admin/);

  const reserved = await ingest({ size: 30_000, to: "qa1@booth.pp.ua", id: "admin-reserved", subject: "admin reserved" });
  assert.equal(reserved.result.stored, true);
  const listed = await (await call("GET", "/api/admin/messages?q=qa1%40booth", { cookie })).json();
  assert.deepEqual(listed.messages.map((m) => m.subject), ["admin reserved"]);
  assert.deepEqual(listed.messages[0].to, ["qa1@booth.pp.ua"]);
  const id = listed.messages[0].id;
  const all = (await (await call("GET", "/api/admin/messages", { cookie })).json()).messages;
  assert.ok(all.some((m) => m.subject === mail("small").subject) && all.some((m) => m.subject === "since mine"), "admin lists every name's mail");

  const raw = new Uint8Array(await (await call("GET", `/api/admin/messages/${id}/raw`, { cookie })).arrayBuffer());
  assert.equal(sha(raw), sha(buildMessage({ size: 30_000, to: "qa1@booth.pp.ua", id: "admin-reserved", subject: "admin reserved" })));
  const stats = await (await call("GET", "/api/admin/stats", { cookie })).json();
  assert.ok(stats.messages >= all.length && stats.storedBytes > 0 && stats.d1SizeBytes > 0 && stats.storedBytesCap === 400000000, JSON.stringify(stats));

  assert.equal((await call("POST", "/api/admin/delete", { body: { ids: [id] }, cookie, csrf: false })).status, 403);
  assert.deepEqual(await (await call("POST", "/api/admin/delete", { body: { ids: [id] }, cookie })).json(), { deleted: 1 });
  assert.equal((await call("GET", `/api/admin/messages/${id}/raw`, { cookie })).status, 404);
  assert.equal((await call("POST", "/api/admin/logout", { body: {}, cookie })).status, 200);
  console.log(`admin: /admin served, ${all.length} messages listed across all names, raw byte-identical, delete verified, d1SizeBytes=${stats.d1SizeBytes}`);
}

const mail = (name) => ({
  to: `${owner}${name === "small" ? "" : "+01"}@booth.pp.ua`,
  subject: `${owner} ${name}`,
  id: `${owner}-${name}`,
});

try {
  if (!live) {
    dev = await startDev({ port, adminPassword });
    token = dev.token;
  }
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
  if (!live) await adminChecks();
  console.log("integration: all checks passed");
} finally {
  await dev?.stop();
}
process.exit(0);
