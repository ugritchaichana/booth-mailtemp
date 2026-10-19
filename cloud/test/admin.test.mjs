import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { openD1 } from "./d1-shim.mjs";
import { handle } from "../src/api.js";
import { ADMIN_COOKIE, ADMIN_SECONDS, adminCookieValue } from "../src/admin.js";
import { ingest } from "../src/store.js";

const DOMAIN = "booth.pp.ua";
const PASSWORD = "correct horse battery staple";
const SESSION_KEY = "admin-unit-test-key";
const logged = [];
console.log = (line) => logged.push(String(line));
const flip = (value) => value.slice(0, -1) + (value.endsWith("0") ? "1" : "0");
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

const setup = (overrides = {}) => ({ DB: openD1(), SESSION_KEY, ADMIN_PASSWORD: PASSWORD, MAIL_DOMAIN: DOMAIN, STORED_BYTES_CAP: "400000000", ...overrides });

async function call(env, method, path, { body, cookie, ip = "203.0.113.7", headers = {}, https = true } = {}) {
  const init = { method, headers: { "cf-connecting-ip": ip, ...headers } };
  if (cookie) init.headers.Cookie = cookie;
  if (body !== undefined) {
    init.headers["Content-Type"] ??= "application/json";
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return handle(new Request(`${https ? "https" : "http"}://mail.test${path}`, init), env, {});
}

const post = (env, path, body, options = {}) => call(env, "POST", path, { body, ...options, headers: { "X-Admin": "1", ...options.headers } });

async function signIn(env, ip) {
  const res = await post(env, "/api/admin/login", { password: PASSWORD }, { ip });
  assert.equal(res.status, 200);
  return res.headers.get("set-cookie").split(";")[0];
}

function mail({ to = "alice@booth.pp.ua", from = "sender@example.com", subject = "hello", id = crypto.randomUUID(), size = 2000, extra = [] } = {}) {
  const head = [`From: ${from}`, `To: ${to}`, `Subject: ${subject}`, `Message-ID: <${id}@example.com>`, "Date: Fri, 16 Oct 2026 10:00:00 +0000", ...extra].join("\r\n");
  const body = crypto.randomBytes(Math.max(size - head.length - 4, 0));
  return new Uint8Array(Buffer.concat([Buffer.from(`${head}\r\n\r\n`), body]));
}

async function store(env, options = {}) {
  const raw = mail(options);
  const to = options.envelopeTo ?? [options.to ?? "alice@booth.pp.ua"];
  const result = await ingest(env.DB, raw, { to }, DOMAIN);
  assert.equal(result.stored, true);
  return { id: result.id, raw };
}

const count = (env, table, column, id) => env.DB.raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(id).n;

test("with no ADMIN_PASSWORD every admin route answers 404, even with a valid-looking cookie", async () => {
  const env = setup({ ADMIN_PASSWORD: undefined });
  const cookie = `${ADMIN_COOKIE}=${await adminCookieValue({ ...env, ADMIN_PASSWORD: PASSWORD })}`;
  for (const [method, path] of [["POST", "/api/admin/login"], ["POST", "/api/admin/logout"], ["GET", "/api/admin/stats"], ["GET", "/api/admin/messages"], ["GET", "/api/admin/messages/x/raw"], ["POST", "/api/admin/delete"], ["GET", "/api/admin"]]) {
    const res = await call(env, method, path, { cookie, headers: { "X-Admin": "1" }, body: method === "POST" ? { password: PASSWORD } : undefined });
    assert.equal(res.status, 404, `${method} ${path}`);
  }
  assert.equal((await call({ ...env, ADMIN_PASSWORD: "" }, "GET", "/api/admin/stats")).status, 404);
});

test("login with the right password sets a signed HttpOnly SameSite=Strict cookie that opens the admin API", async () => {
  const env = setup();
  const res = await post(env, "/api/admin/login", { password: PASSWORD });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const set = res.headers.get("set-cookie");
  assert.match(set, new RegExp(`^${ADMIN_COOKIE}=\\d{10}\\.[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=${ADMIN_SECONDS}; Secure$`));
  assert.equal((await call(env, "GET", "/api/admin/stats", { cookie: set.split(";")[0] })).status, 200);
  assert.doesNotMatch((await post(env, "/api/admin/login", { password: PASSWORD }, { https: false })).headers.get("set-cookie"), /Secure/);
});

test("a wrong, missing or non-string password is refused without a cookie", async () => {
  const env = setup();
  const bodies = [{ password: "wrong" }, { password: "" }, {}, { password: 12345 }, { password: [PASSWORD] }, { password: `${PASSWORD} ` }];
  for (const [i, body] of bodies.entries()) {
    const res = await post(env, "/api/admin/login", body, { ip: `203.0.113.${i}` });
    assert.equal(res.status, 401, JSON.stringify(body));
    assert.equal(res.headers.get("set-cookie"), null);
  }
  assert.equal((await post(env, "/api/admin/login", "{not json")).status, 400);
  assert.equal((await post(env, "/api/admin/login", [PASSWORD])).status, 400);
});

test("the sixth failed login in ten minutes is rate limited, even with the right password, per IP", async () => {
  const env = setup();
  for (let i = 0; i < 5; i += 1) assert.equal((await post(env, "/api/admin/login", { password: `wrong${i}` })).status, 401);
  assert.equal((await post(env, "/api/admin/login", { password: "wrong5" })).status, 429);
  const blocked = await post(env, "/api/admin/login", { password: PASSWORD });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("set-cookie"), null);
  assert.equal((await post(env, "/api/admin/login", { password: PASSWORD }, { ip: "198.51.100.9" })).status, 200);
});

test("successful logins do not count against the limit", async () => {
  const env = setup();
  for (let i = 0; i < 8; i += 1) assert.equal((await post(env, "/api/admin/login", { password: PASSWORD })).status, 200);
  assert.equal((await post(env, "/api/admin/login", { password: "wrong" })).status, 401);
});

test("a tampered, forged, garbled or password-rotated cookie is a 401", async () => {
  const env = setup();
  const good = await adminCookieValue(env);
  const [expires, mac] = good.split(".");
  const forged = [
    `${expires}.${flip(mac)}`,
    `${Number(expires) + 86400}.${mac}`,
    `${expires}.${mac.toUpperCase()}`,
    `${expires}.${mac.slice(1)}`,
    expires,
    "garbage",
    `${await adminCookieValue({ ...env, SESSION_KEY: "another-key" })}`,
    `${await adminCookieValue({ ...env, ADMIN_PASSWORD: "rotated" })}`,
  ];
  for (const value of forged) assert.equal((await call(env, "GET", "/api/admin/stats", { cookie: `${ADMIN_COOKIE}=${value}` })).status, 401, value);
  assert.equal((await call(env, "GET", "/api/admin/stats", { cookie: `${ADMIN_COOKIE}=${good}` })).status, 200);
});

test("a correctly signed cookie is refused once it has expired and accepted just before", async () => {
  const env = setup();
  const issued = Math.floor(Date.now() / 1000);
  const open = (at) => adminCookieValue(env, at).then((value) => call(env, "GET", "/api/admin/stats", { cookie: `${ADMIN_COOKIE}=${value}` }));
  assert.equal((await open(issued - ADMIN_SECONDS + 60)).status, 200);
  assert.equal((await open(issued - ADMIN_SECONDS - 1)).status, 401);
  assert.equal((await open(issued - 13 * 3600)).status, 401);
});

test("the inbox session cookie does not open the admin API", async () => {
  const env = setup();
  const res = await call(env, "GET", "/api/admin/stats", { cookie: "inboxes=v3.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.1.00" });
  assert.equal(res.status, 401);
});

test("every admin endpoint except login and logout is 401 without the cookie", async () => {
  const env = setup();
  const { id } = await store(env);
  for (const [method, path, body] of [["GET", "/api/admin/stats"], ["GET", "/api/admin/messages"], ["GET", `/api/admin/messages/${id}/raw`], ["POST", "/api/admin/delete", { ids: [id] }]]) {
    const res = await call(env, method, path, { body, headers: { "X-Admin": "1" } });
    assert.equal(res.status, 401, `${method} ${path}`);
  }
  assert.equal(count(env, "messages", "id", id), 1);
});

test("a state-changing request needs JSON and the X-Admin header", async () => {
  const env = setup();
  const cookie = await signIn(env);
  const { id } = await store(env);
  assert.equal((await call(env, "POST", "/api/admin/login", { body: { password: PASSWORD } })).status, 403);
  assert.equal((await call(env, "POST", "/api/admin/logout", { cookie, body: {} })).status, 403);
  assert.equal((await call(env, "POST", "/api/admin/delete", { cookie, body: { ids: [id] } })).status, 403);
  assert.equal((await post(env, "/api/admin/delete", "ids=1", { cookie, headers: { "Content-Type": "application/x-www-form-urlencoded" } })).status, 415);
  assert.equal((await post(env, "/api/admin/delete", { ids: [id] }, { cookie, headers: { "X-Admin": "0" } })).status, 403);
  assert.equal(count(env, "messages", "id", id), 1);
});

test("logout clears the cookie", async () => {
  const env = setup();
  const res = await post(env, "/api/admin/logout", {}, { cookie: await signIn(env) });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("set-cookie"), new RegExp(`^${ADMIN_COOKIE}=; .*Max-Age=0`));
});

test("the list shows mail for reserved names and envelope-only recipients, newest first", async () => {
  const env = setup();
  const cookie = await signIn(env);
  await store(env, { to: "alice@booth.pp.ua", subject: "normal" });
  await store(env, { to: "qa1@booth.pp.ua", subject: "reserved qa" });
  await store(env, { to: "root@booth.pp.ua", subject: "reserved root" });
  await store(env, { to: "visible@booth.pp.ua", envelopeTo: ["visible@booth.pp.ua", "hidden-bcc@booth.pp.ua"], subject: "with bcc" });
  const res = await call(env, "GET", "/api/admin/messages", { cookie });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const { messages, next } = await res.json();
  assert.deepEqual(messages.map((m) => m.subject), ["with bcc", "reserved root", "reserved qa", "normal"]);
  assert.equal(next, null);
  assert.deepEqual(messages[0].to.sort(), ["hidden-bcc@booth.pp.ua", "visible@booth.pp.ua"]);
  assert.deepEqual(messages[2].to, ["qa1@booth.pp.ua"]);
  assert.deepEqual(Object.keys(messages[0]).sort(), ["attachments", "created", "from", "id", "rid", "size", "subject", "to"]);
  assert.deepEqual(messages[0].from, { Name: "", Address: "sender@example.com" });
  assert.match(messages[0].created, /^\d{4}-\d{2}-\d{2}T/);
});

test("search matches recipient, sender and subject, ignores case, and treats LIKE wildcards literally", async () => {
  const env = setup();
  const cookie = await signIn(env);
  await store(env, { to: "alice@booth.pp.ua", from: "billing@shop.example", subject: "Invoice 100%" });
  await store(env, { to: "qa7@booth.pp.ua", from: "sender@example.com", subject: "reset link" });
  await store(env, { to: "bob@booth.pp.ua", from: "news@letter.example", subject: "weekly_digest" });
  const find = async (q) => (await (await call(env, "GET", `/api/admin/messages?q=${encodeURIComponent(q)}`, { cookie })).json()).messages.map((m) => m.subject).sort();
  assert.deepEqual(await find("QA7"), ["reset link"]);
  assert.deepEqual(await find("shop.example"), ["Invoice 100%"]);
  assert.deepEqual(await find("RESET"), ["reset link"]);
  assert.deepEqual(await find("100%"), ["Invoice 100%"]);
  assert.deepEqual(await find("%"), ["Invoice 100%"]);
  assert.deepEqual(await find("_"), ["weekly_digest"]);
  assert.deepEqual(await find("nothing-like-this"), []);
  assert.equal((await find("")).length, 3);
});

test("a very long search is cut to the D1 LIKE pattern limit instead of failing", async () => {
  const env = setup();
  const cookie = await signIn(env);
  await store(env, { subject: "x".repeat(60) });
  for (const q of ["x".repeat(500), "%".repeat(80), "ก".repeat(60)]) {
    const res = await call(env, "GET", `/api/admin/messages?q=${encodeURIComponent(q)}`, { cookie });
    assert.equal(res.status, 200, q.slice(0, 5));
  }
  assert.equal((await (await call(env, "GET", `/api/admin/messages?q=${"x".repeat(500)}`, { cookie })).json()).messages.length, 1);
});

test("the list pages by rowid cursor, 100 per page, without gaps or repeats", async () => {
  const env = setup();
  const cookie = await signIn(env);
  for (let i = 0; i < 105; i += 1) await store(env, { subject: `m${String(i).padStart(3, "0")}` });
  const first = await (await call(env, "GET", "/api/admin/messages", { cookie })).json();
  assert.equal(first.messages.length, 100);
  assert.equal(first.messages[0].subject, "m104");
  assert.equal(first.next, first.messages[99].rid);
  const second = await (await call(env, "GET", `/api/admin/messages?before=${first.next}`, { cookie })).json();
  assert.deepEqual(second.messages.map((m) => m.subject), ["m004", "m003", "m002", "m001", "m000"]);
  assert.equal(second.next, null);
  const filtered = await (await call(env, "GET", `/api/admin/messages?q=m10&before=${first.messages[0].rid}`, { cookie })).json();
  assert.deepEqual(filtered.messages.map((m) => m.subject), ["m103", "m102", "m101", "m100"]);
  for (const before of ["abc", "-1", "1.5", "9999999999999999"]) assert.equal((await call(env, "GET", `/api/admin/messages?before=${before}`, { cookie })).status, 400, before);
});

test("raw returns the stored bytes untouched, including a Bcc header the inbox hides", async () => {
  const env = setup();
  const cookie = await signIn(env);
  const { id, raw } = await store(env, { to: "qa1@booth.pp.ua", size: 3_000_000, extra: ["Bcc: secret@example.org"] });
  const res = await call(env, "GET", `/api/admin/messages/${id}/raw`, { cookie });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-disposition"), 'attachment; filename="message.eml"');
  assert.equal(res.headers.get("content-security-policy"), "sandbox");
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.equal(sha(bytes), sha(raw));
  assert.match(Buffer.from(bytes.subarray(0, 400)).toString("latin1"), /Bcc: secret@example\.org/);
});

test("raw answers 404 for an unknown or malformed id", async () => {
  const env = setup();
  const cookie = await signIn(env);
  for (const id of ["does-not-exist", "a".repeat(65), "%2e%2e", "x%20y"]) assert.equal((await call(env, "GET", `/api/admin/messages/${id}/raw`, { cookie })).status, 404, id);
});

test("delete removes the messages, their chunks, recipients, reads and hides, and nothing else", async () => {
  const env = setup();
  const cookie = await signIn(env);
  const big = await store(env, { to: "qa1@booth.pp.ua", size: 3_000_000 });
  const small = await store(env, { to: "alice@booth.pp.ua" });
  const keep = await store(env, { to: "alice@booth.pp.ua", subject: "keep" });
  env.DB.raw.prepare("INSERT INTO reads (username, id) VALUES ('alice', ?)").run(small.id);
  env.DB.raw.prepare("INSERT INTO hidden (username, id) VALUES ('alice', ?)").run(small.id);
  assert.equal(count(env, "chunks", "message_id", big.id), 3);
  const res = await post(env, "/api/admin/delete", { ids: [big.id, small.id, small.id, "never-existed"] }, { cookie });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { deleted: 2 });
  for (const { id } of [big, small]) {
    for (const [table, column] of [["messages", "id"], ["chunks", "message_id"], ["recipients", "message_id"], ["reads", "id"], ["hidden", "id"]]) assert.equal(count(env, table, column, id), 0, `${table} ${id}`);
  }
  assert.equal(count(env, "messages", "id", keep.id), 1);
  assert.equal(count(env, "chunks", "message_id", keep.id), 1);
  assert.equal(count(env, "recipients", "message_id", keep.id), 1);
  assert.equal((await call(env, "GET", `/api/admin/messages/${big.id}/raw`, { cookie })).status, 404);
  assert.deepEqual((await (await post(env, "/api/admin/delete", { ids: [big.id] }, { cookie })).json()), { deleted: 0 });
});

test("delete takes up to 100 ids in one call and refuses malformed requests", async () => {
  const env = setup();
  const cookie = await signIn(env);
  const ids = [];
  for (let i = 0; i < 100; i += 1) ids.push((await store(env, { subject: `bulk ${i}` })).id);
  const bad = [{}, { ids: "abc" }, { ids: [] }, { ids: [123] }, { ids: ["has space"] }, { ids: ["../x"] }, { ids: [...ids, "one-more"] }, { ids: [null] }];
  for (const body of bad) assert.equal((await post(env, "/api/admin/delete", body, { cookie })).status, 400, JSON.stringify(body).slice(0, 40));
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM messages").get().n, 100);
  assert.deepEqual(await (await post(env, "/api/admin/delete", { ids }, { cookie })).json(), { deleted: 100 });
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM messages").get().n, 0);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM chunks").get().n, 0);
});

test("stats report counts, stored bytes against the cap, database size and the time range", async () => {
  const env = setup();
  const cookie = await signIn(env);
  const empty = await (await call(env, "GET", "/api/admin/stats", { cookie })).json();
  assert.deepEqual({ ...empty, d1SizeBytes: typeof empty.d1SizeBytes }, { messages: 0, storedBytes: 0, storedBytesCap: 400000000, d1SizeBytes: "number", oldestAt: null, lastIngestAt: null });
  await store(env, { size: 3_000 });
  await store(env, { size: 2_000_000 });
  env.DB.raw.prepare("UPDATE messages SET created = created - 86400 WHERE rowid = 1").run();
  const stats = await (await call(env, "GET", "/api/admin/stats", { cookie })).json();
  assert.deepEqual(Object.keys(stats).sort(), ["d1SizeBytes", "lastIngestAt", "messages", "oldestAt", "storedBytes", "storedBytesCap"]);
  assert.equal(stats.messages, 2);
  assert.equal(stats.storedBytes, env.DB.raw.prepare("SELECT SUM(stored) AS s FROM messages").get().s);
  assert.ok(stats.storedBytes > 2_000_000 * 1.3);
  assert.ok(stats.d1SizeBytes > 0);
  assert.ok(Date.parse(stats.lastIngestAt) - Date.parse(stats.oldestAt) >= 86_000_000);
  assert.equal((await call(setup({ DB: env.DB, STORED_BYTES_CAP: undefined }), "GET", "/api/admin/stats", { cookie })).status, 200);
});

test("the admin routes do not change the inbox API", async () => {
  const env = setup();
  assert.equal((await call(env, "GET", "/api/messages")).status, 401);
  assert.equal((await call(env, "GET", "/api/status")).status, 200);
  assert.equal((await call(env, "GET", "/api/adminx")).status, 401);
});

test("the log records admin events as counts and flags, never the password, cookie or mail content", async () => {
  logged.length = 0;
  const env = setup();
  const cookie = await signIn(env);
  await post(env, "/api/admin/login", { password: "guess-1234" });
  const { id } = await store(env, { subject: "private subject" });
  await post(env, "/api/admin/delete", { ids: [id] }, { cookie });
  const text = logged.join("\n");
  assert.match(text, /"event":"admin_login","ok":true/);
  assert.match(text, /"event":"admin_login","ok":false/);
  assert.match(text, /"event":"admin_delete","requested":1,"deleted":1/);
  for (const secret of [PASSWORD, "guess-1234", cookie.split("=")[1], "private subject", "203.0.113.7"]) assert.ok(!text.includes(secret), secret);
});
