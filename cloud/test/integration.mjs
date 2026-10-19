import assert from "node:assert/strict";
import crypto from "node:crypto";
import { buildMessage } from "./probe/worker.js";
import { SSO_USERS, probeIngest, startSsoDev } from "./dev-server.mjs";

const MIB = 1024 * 1024;
const sizes = { small: 100_000, medium: 5 * MIB, large: 24 * MIB };
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const live = Boolean(process.env.PROBE_URL);
const port = Number(process.env.PORT ?? 8799);
const base = live ? (process.env.PUBLIC_URL ?? "https://mail.booth.pp.ua") : `http://127.0.0.1:${port}`;
const probeBase = live ? process.env.PROBE_URL : base;
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

async function adminChecks(github, githubPort) {
  const call = (method, pathname, { body, cookie, csrf = true } = {}) => fetch(`${base}${pathname}`, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(csrf && method !== "GET" ? { "X-Admin": "1" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  const cookieOf = (res, name) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
  const json = async (res) => res.json();

  const page = await call("GET", "/admin");
  assert.equal(page.status, 200, "/admin serves admin.html without a redirect");
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.equal(page.headers.get("content-security-policy"), "frame-ancestors 'none'");
  assert.match(await page.text(), /Sign in with GitHub/);
  for (const p of ["/api/admin/me", "/api/admin/stats", "/api/admin/messages", "/api/admin/messages/abc/raw", "/api/admin/admins", "/api/admin/audit"]) assert.equal((await call("GET", p)).status, 401, p);

  const start = await call("GET", "/api/admin/auth/login");
  assert.equal(start.status, 302);
  const target = new URL(start.headers.get("location"));
  assert.equal(target.origin, `http://localhost:${githubPort}`);
  assert.equal(target.pathname, "/login/oauth/authorize");
  assert.equal(target.searchParams.get("client_id"), github.clientId);
  assert.equal(target.searchParams.get("redirect_uri"), `${base}/api/admin/auth/callback`);
  assert.equal(target.searchParams.get("scope"), "");
  assert.match(cookieOf(start, "mt_oauth"), /; HttpOnly; SameSite=Lax; Path=\/api\/admin\/auth; Max-Age=600$/);
  const oauth = cookieOf(start, "mt_oauth").split(";")[0];
  assert.equal((await call("GET", "/api/admin/auth/callback?code=x&state=wrong", { cookie: oauth })).status, 400);
  assert.equal((await call("GET", `/api/admin/auth/callback?code=x&state=${target.searchParams.get("state")}`)).status, 400);

  async function signIn(user) {
    github.signInAs(user.login);
    const first = await call("GET", "/api/admin/auth/login");
    const approved = await fetch(first.headers.get("location"), { redirect: "manual" });
    const callback = new URL(approved.headers.get("location"));
    assert.equal(`${callback.origin}${callback.pathname}`, `${base}/api/admin/auth/callback`);
    const res = await call("GET", callback.pathname + callback.search, { cookie: cookieOf(first, "mt_oauth").split(";")[0] });
    return { res, cookie: cookieOf(res, "mt_admin")?.split(";")[0] };
  }

  const stranger = await signIn(SSO_USERS.stranger);
  assert.equal(stranger.res.status, 403);
  assert.equal(stranger.cookie, undefined);
  const owner = await signIn(SSO_USERS.owner);
  assert.equal(owner.res.status, 302);
  assert.equal(owner.res.headers.get("location"), "/admin");
  assert.match(cookieOf(owner.res, "mt_admin"), /; HttpOnly; SameSite=Strict; Path=\/api\/admin; Max-Age=43200$/);
  assert.deepEqual(await json(await call("GET", "/api/admin/me", { cookie: owner.cookie })), { ...SSO_USERS.owner, role: "owner" });

  assert.equal((await call("POST", "/api/admin/login", { body: { password: "anything" }, cookie: owner.cookie })).status, 404, "password login is gone");
  const reserved = await ingest({ size: 30_000, to: "qa1@booth.pp.ua", id: "admin-reserved", subject: "admin reserved" });
  assert.equal(reserved.result.stored, true);
  const listed = await json(await call("GET", "/api/admin/messages?q=qa1%40booth", { cookie: owner.cookie }));
  assert.deepEqual(listed.messages.map((m) => m.subject), ["admin reserved"]);
  assert.deepEqual(listed.messages[0].to, ["qa1@booth.pp.ua"]);
  const id = listed.messages[0].id;
  const all = (await json(await call("GET", "/api/admin/messages", { cookie: owner.cookie }))).messages;
  assert.ok(all.some((m) => m.subject === mail("small").subject) && all.some((m) => m.subject === "since mine"), "admin lists every name's mail");
  const raw = new Uint8Array(await (await call("GET", `/api/admin/messages/${id}/raw`, { cookie: owner.cookie })).arrayBuffer());
  assert.equal(sha(raw), sha(buildMessage({ size: 30_000, to: "qa1@booth.pp.ua", id: "admin-reserved", subject: "admin reserved" })));
  const stats = await json(await call("GET", "/api/admin/stats", { cookie: owner.cookie }));
  assert.ok(stats.messages >= all.length && stats.storedBytes > 0 && stats.d1SizeBytes > 0 && stats.storedBytesCap === 400000000, JSON.stringify(stats));

  assert.equal((await call("POST", "/api/admin/admins", { body: { login: SSO_USERS.admin.login }, cookie: owner.cookie, csrf: false })).status, 403);
  assert.equal((await call("POST", "/api/admin/admins", { body: { login: SSO_USERS.owner.login }, cookie: owner.cookie })).status, 400);
  assert.equal((await call("POST", "/api/admin/admins", { body: { login: "no-such-user-here" }, cookie: owner.cookie })).status, 404);
  assert.equal((await call("POST", "/api/admin/admins", { body: { login: SSO_USERS.admin.login }, cookie: owner.cookie })).status, 200);
  const admins = await json(await call("GET", "/api/admin/admins", { cookie: owner.cookie }));
  assert.deepEqual(admins.admins.map((a) => [a.id, a.login]), [[SSO_USERS.admin.id, SSO_USERS.admin.login]]);

  const helper = await signIn(SSO_USERS.admin);
  assert.equal(helper.res.status, 302);
  assert.deepEqual(await json(await call("GET", "/api/admin/me", { cookie: helper.cookie })), { ...SSO_USERS.admin, role: "admin" });
  assert.equal((await call("GET", "/api/admin/stats", { cookie: helper.cookie })).status, 200);
  for (const [method, p, body] of [["GET", "/api/admin/admins"], ["GET", "/api/admin/audit"], ["POST", "/api/admin/admins", { login: SSO_USERS.stranger.login }], ["POST", "/api/admin/admins/remove", { github_id: SSO_USERS.admin.id }]]) {
    assert.equal((await call(method, p, { body, cookie: helper.cookie })).status, 403, `admin must not reach ${method} ${p}`);
  }

  assert.equal((await call("POST", "/api/admin/delete", { body: { ids: [id] }, cookie: helper.cookie, csrf: false })).status, 403);
  assert.deepEqual(await json(await call("POST", "/api/admin/delete", { body: { ids: [id] }, cookie: helper.cookie })), { deleted: 1 });
  assert.equal((await call("GET", `/api/admin/messages/${id}/raw`, { cookie: helper.cookie })).status, 404);

  assert.equal((await call("POST", "/api/admin/admins/remove", { body: { github_id: SSO_USERS.owner.id }, cookie: owner.cookie })).status, 400);
  assert.equal((await call("POST", "/api/admin/admins/remove", { body: { github_id: SSO_USERS.admin.id }, cookie: owner.cookie })).status, 200);
  assert.equal((await call("GET", "/api/admin/stats", { cookie: helper.cookie })).status, 401, "a removed admin is locked out on the next request");
  assert.equal((await signIn(SSO_USERS.admin)).res.status, 403);

  const audit = (await json(await call("GET", "/api/admin/audit", { cookie: owner.cookie }))).entries;
  assert.deepEqual(audit.map((e) => [e.action, e.actor]).reverse(), [["admin_add", SSO_USERS.owner.login], ["delete", SSO_USERS.admin.login], ["admin_remove", SSO_USERS.owner.login]]);
  assert.equal((await call("POST", "/api/admin/logout", { body: {}, cookie: owner.cookie })).status, 200);
  const lookups = github.requests.filter((r) => r.path.startsWith("/users/"));
  assert.ok(lookups.length >= 3 && lookups.every((r) => r.authorization === null), "username lookups carry no credentials");
  console.log(`admin: github sign-in as owner and admin, roles enforced, ${all.length} messages listed across all names, raw byte-identical, delete and admin changes audited, removed admin locked out, d1SizeBytes=${stats.d1SizeBytes}`);
}

const mail = (name) => ({
  to: `${owner}${name === "small" ? "" : "+01"}@booth.pp.ua`,
  subject: `${owner} ${name}`,
  id: `${owner}-${name}`,
});

try {
  if (!live) {
    dev = await startSsoDev({ port });
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
  if (!live) await adminChecks(dev.github, dev.githubPort);
  console.log("integration: all checks passed");
} finally {
  await dev?.stop();
}
process.exit(0);
