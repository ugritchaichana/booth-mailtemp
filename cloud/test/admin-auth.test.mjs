import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ADMIN_COOKIE, ADMIN_SECONDS, OAUTH_COOKIE, OAUTH_SECONDS, adminCookieValue } from "../src/admin.js";
import { HELPER, OWNER, OWNER_TWO, ORG, SECOND, STRANGER, addAdminRow, call, cookieNamed, fake, flip, githubFlow, logged, post, setup, signIn, store } from "./admin-helpers.mjs";

const OWNER_ROUTES = [["GET", "/api/admin/admins"], ["POST", "/api/admin/admins", { login: HELPER.login }], ["POST", "/api/admin/admins/remove", { github_id: HELPER.id }], ["GET", "/api/admin/audit"]];
const adminRows = (env) => env.DB.raw.prepare("SELECT github_id FROM admins ORDER BY github_id").all().map((r) => r.github_id);
const auditRows = (env) => env.DB.raw.prepare("SELECT actor_id, actor_login, action, target, detail FROM admin_audit ORDER BY id").all().map((r) => ({ ...r }));
const sessionOf = (res) => cookieNamed(res, ADMIN_COOKIE).split(";")[0];
const me = async (env, cookie) => (await call(env, "GET", "/api/admin/me", { cookie })).json();

test("with no client id or no client secret every admin route answers 404, even with a valid cookie", async () => {
  const cookie = await signIn(setup());
  for (const missing of ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"]) {
    for (const blank of [undefined, ""]) {
      const env = setup({ [missing]: blank });
      for (const [method, path] of [["GET", "/api/admin/auth/login"], ["GET", "/api/admin/auth/callback?code=x&state=y"], ["POST", "/api/admin/logout"], ["GET", "/api/admin/me"], ["GET", "/api/admin/stats"], ["GET", "/api/admin/messages"], ["POST", "/api/admin/delete"], ["GET", "/api/admin/admins"], ["GET", "/api/admin/audit"], ["GET", "/api/admin"]]) {
        const res = await call(env, method, path, { cookie, headers: { "X-Admin": "1" }, body: method === "POST" ? {} : undefined });
        assert.equal(res.status, 404, `${missing}=${JSON.stringify(blank)} ${method} ${path}`);
      }
    }
  }
});

test("the login route redirects to GitHub with the client id, callback, a fresh state and an empty scope, and sets a Lax state cookie", async () => {
  const env = setup();
  const res = await call(env, "GET", "/api/admin/auth/login");
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const target = new URL(res.headers.get("location"));
  assert.equal(`${target.origin}${target.pathname}`, "https://github.com/login/oauth/authorize");
  assert.deepEqual(Object.fromEntries(target.searchParams), { client_id: "test-client-id", redirect_uri: "https://mail.test/api/admin/auth/callback", state: target.searchParams.get("state"), scope: "", allow_signup: "false" });
  assert.match(target.searchParams.get("state"), /^[A-Za-z0-9_-]{43}$/);
  const cookie = cookieNamed(res, OAUTH_COOKIE);
  assert.match(cookie, new RegExp(`^${OAUTH_COOKIE}=${target.searchParams.get("state")}\\.\\d{10}\\.[0-9a-f]{64}; HttpOnly; SameSite=Lax; Path=/api/admin/auth; Max-Age=${OAUTH_SECONDS}; Secure$`));
  assert.doesNotMatch(cookieNamed(await call(env, "GET", "/api/admin/auth/login", { https: false }), OAUTH_COOKIE), /Secure/);
  const again = new URL((await call(env, "GET", "/api/admin/auth/login")).headers.get("location"));
  assert.notEqual(again.searchParams.get("state"), target.searchParams.get("state"));
  assert.equal(fake.requests.length, 0, "starting a login never calls GitHub");
});

test("the OAuth base URLs default to real GitHub and only a test override changes them", async () => {
  const defaults = setup({ GITHUB_OAUTH_BASE: "", GITHUB_API_BASE: undefined });
  assert.match((await call(defaults, "GET", "/api/admin/auth/login")).headers.get("location"), /^https:\/\/github\.com\/login\/oauth\/authorize\?/);
  const local = setup({ GITHUB_OAUTH_BASE: "http://127.0.0.1:9999" });
  assert.match((await call(local, "GET", "/api/admin/auth/login")).headers.get("location"), /^http:\/\/127\.0\.0\.1:9999\/login\/oauth\/authorize\?/);
});

test("a callback with a missing, wrong, tampered or expired state goes back to the admin page as expired and never reaches GitHub", async () => {
  const env = setup();
  const start = await call(env, "GET", "/api/admin/auth/login");
  const stateParam = new URL(start.headers.get("location")).searchParams.get("state");
  const cookie = cookieNamed(start, OAUTH_COOKIE).split(";")[0];
  const [state, expires, mac] = cookie.split("=")[1].split(".");
  const expired = `${state}.${Math.floor(Date.now() / 1000) - 1}.${mac}`;
  const cases = [
    ["no cookie", `?code=abc&state=${stateParam}`, undefined],
    ["no state parameter", "?code=abc", cookie],
    ["empty state parameter", "?code=abc&state=", cookie],
    ["wrong state parameter", `?code=abc&state=${flip(stateParam)}`, cookie],
    ["state of another login", `?code=abc&state=${new URL((await call(env, "GET", "/api/admin/auth/login")).headers.get("location")).searchParams.get("state")}`, cookie],
    ["tampered mac", `?code=abc&state=${stateParam}`, `${OAUTH_COOKIE}=${state}.${expires}.${flip(mac)}`],
    ["tampered expiry", `?code=abc&state=${stateParam}`, `${OAUTH_COOKIE}=${state}.${Number(expires) + 600}.${mac}`],
    ["expired cookie", `?code=abc&state=${stateParam}`, `${OAUTH_COOKIE}=${expired}.${"0".repeat(64)}`],
    ["garbled cookie", `?code=abc&state=${stateParam}`, `${OAUTH_COOKIE}=garbage`],
    ["session cookie in place of the state cookie", `?code=abc&state=${stateParam}`, `${OAUTH_COOKIE}=${(await signIn(env)).split("=")[1]}`],
  ];
  for (const [name, query, header] of cases) {
    const res = await call(env, "GET", `/api/admin/auth/callback${query}`, { cookie: header });
    assert.equal(res.status, 302, name);
    assert.equal(res.headers.get("location"), "/admin?signin=expired", name);
    assert.equal(cookieNamed(res, ADMIN_COOKIE), undefined, name);
    assert.match(cookieNamed(res, OAUTH_COOKIE), /Max-Age=0/, name);
  }
  assert.equal(fake.requests.length, 0);
});

test("the state cookie is bound to the signing key: a cookie minted under another key is refused", async () => {
  const other = setup({ SESSION_KEY: "another-key" });
  const start = await call(other, "GET", "/api/admin/auth/login");
  const stateParam = new URL(start.headers.get("location")).searchParams.get("state");
  const res = await call(setup(), "GET", `/api/admin/auth/callback?code=abc&state=${stateParam}`, { cookie: cookieNamed(start, OAUTH_COOKIE).split(";")[0] });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/admin?signin=expired");
});

test("an owner id signs in as owner, gets a Strict 12 hour cookie, and the state cookie is cleared", async () => {
  const env = setup();
  const res = await githubFlow(env, OWNER.login);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/admin");
  assert.match(cookieNamed(res, ADMIN_COOKIE), new RegExp(`^${ADMIN_COOKIE}=${OWNER.id}\\.${OWNER.login}\\.\\d{10}\\.[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=${ADMIN_SECONDS}; Secure$`));
  assert.match(cookieNamed(res, OAUTH_COOKIE), /^mt_oauth=; HttpOnly; SameSite=Lax; Path=\/api\/admin\/auth; Max-Age=0; Secure$/);
  assert.deepEqual(await me(env, sessionOf(res)), { id: OWNER.id, login: OWNER.login, role: "owner" });
  assert.deepEqual(await me(env, sessionOf(await githubFlow(env, OWNER_TWO.login))), { id: OWNER_TWO.id, login: OWNER_TWO.login, role: "owner" });
  assert.doesNotMatch(cookieNamed(await githubFlow(env, OWNER.login, { https: false }), ADMIN_COOKIE), /Secure/);
});

test("an added id signs in as admin, any other id goes back to the admin page as denied with no cookie", async () => {
  const env = setup();
  addAdminRow(env, HELPER);
  const ok = await githubFlow(env, HELPER.login);
  assert.equal(ok.status, 302);
  assert.deepEqual(await me(env, sessionOf(ok)), { id: HELPER.id, login: HELPER.login, role: "admin" });
  const denied = await githubFlow(env, STRANGER.login);
  assert.equal(denied.status, 302);
  assert.equal(denied.headers.get("location"), "/admin?signin=denied");
  assert.equal(cookieNamed(denied, ADMIN_COOKIE), undefined);
  assert.match(cookieNamed(denied, OAUTH_COOKIE), /Max-Age=0/);
});

test("the numeric id decides, never the login: an owner login that now belongs to another id is refused", async () => {
  const env = setup();
  fake.addAccount("renamed-owner", 999_001);
  assert.equal((await githubFlow(env, "renamed-owner")).headers.get("location"), "/admin?signin=denied");
  fake.addAccount(OWNER.login, OWNER.id);
});

const lands = (res, reason) => {
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), `/admin?signin=${reason}`);
  assert.equal(cookieNamed(res, ADMIN_COOKIE), undefined);
  assert.match(cookieNamed(res, OAUTH_COOKIE), /Max-Age=0/);
};

test("GitHub failures end the login without a session: refused consent as cancelled, the rest as github", async () => {
  const env = setup();
  fake.state.deny = true;
  lands(await githubFlow(env, OWNER.login), "cancelled");
  fake.reset();
  fake.state.failToken = true;
  lands(await githubFlow(env, OWNER.login), "github");
  fake.reset();
  fake.state.failUser = 500;
  lands(await githubFlow(env, OWNER.login), "github");
  fake.reset();
  const real = globalThis.fetch;
  globalThis.fetch = () => { throw new TypeError("fetch failed"); };
  try {
    lands(await githubFlow(env, OWNER.login), "github");
  } finally {
    globalThis.fetch = real;
  }
});

const loginLines = () => logged.map((l) => JSON.parse(l)).filter((l) => l.event === "admin_login");

test("each GitHub failure logs its stage, status and GitHub error code and nothing that could sign in", async () => {
  const env = setup();
  const real = globalThis.fetch;
  const codes = [];
  let tokenReply = null;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/access_token")) {
      codes.push(JSON.parse(init.body).code);
      if (tokenReply) return tokenReply();
    }
    return real(input, init);
  };
  try {
    fake.state.failToken = true;
    await githubFlow(env, OWNER.login);
    fake.state.failToken = false;
    fake.state.failUser = 502;
    await githubFlow(env, OWNER.login);
    fake.state.failUser = 0;
    tokenReply = () => new Response("<html>nope</html>", { status: 200 });
    await githubFlow(env, OWNER.login);
  } finally {
    globalThis.fetch = real;
  }
  assert.deepEqual(loginLines().map(({ at, event, ...rest }) => rest), [
    { ok: false, stage: "token", status: 200, error: "bad_verification_code" },
    { ok: false, stage: "user", status: 502 },
    { ok: false, stage: "token", status: 200 },
  ]);
  const states = fake.requests.filter((r) => r.path === "/login/oauth/authorize").map((r) => r.query.state);
  assert.equal(codes.length, 3);
  assert.equal(states.length, 3);
  const text = logged.join("\n");
  for (const secret of [...states, ...codes, ...fake.issued, fake.clientSecret, "nope"]) assert.ok(!text.includes(secret), secret);
});

test("an unexpected GitHub error string is dropped from the log, a code-shaped one is kept", async () => {
  const env = setup();
  const real = globalThis.fetch;
  for (const error of ["redirect_uri_mismatch", "Bad <Code> with secret test-client-secret"]) {
    globalThis.fetch = (input, init) => (String(input).endsWith("/access_token") ? Response.json({ error }) : real(input, init));
    try {
      await githubFlow(env, OWNER.login);
    } finally {
      globalThis.fetch = real;
    }
  }
  const [kept, dropped] = loginLines();
  assert.equal(kept.error, "redirect_uri_mismatch");
  assert.equal(dropped.error, undefined);
  assert.ok(!logged.join("\n").includes("secret"));
});

test("a GitHub code works once: replaying the same callback is refused", async () => {
  const env = setup();
  fake.signInAs(OWNER.login);
  const start = await call(env, "GET", "/api/admin/auth/login");
  const back = await fake.handle(new Request(start.headers.get("location")));
  const callback = new URL(back.headers.get("location"));
  const cookie = cookieNamed(start, OAUTH_COOKIE).split(";")[0];
  assert.equal((await call(env, "GET", callback.pathname + callback.search, { cookie })).status, 302);
  const replay = await call(env, "GET", callback.pathname + callback.search, { cookie });
  lands(replay, "github");
});

test("the GitHub calls carry the right credentials and the token reaches only the /user call", async () => {
  const env = setup();
  await githubFlow(env, OWNER.login);
  const paths = fake.requests.map((r) => `${r.method} ${r.origin}${r.path}`);
  assert.deepEqual(paths, ["GET https://github.com/login/oauth/authorize", "POST https://github.com/login/oauth/access_token", "GET https://api.github.com/user"]);
  const userCall = fake.requests.find((r) => r.path === "/user");
  assert.equal(userCall.authorization, `Bearer ${fake.issued[0]}`);
  assert.equal(fake.requests.filter((r) => r.authorization).length, 1);
});

test("the GitHub token and client secret are never stored, logged or sent to the browser", async () => {
  const env = setup();
  const res = await githubFlow(env, OWNER.login);
  const cookie = sessionOf(res);
  await post(env, "/api/admin/admins", { login: HELPER.login }, { cookie });
  await githubFlow(env, STRANGER.login);
  assert.equal(fake.issued.length, 2);
  const tables = env.DB.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
  const dump = tables.map((name) => JSON.stringify(env.DB.raw.prepare(`SELECT * FROM ${name}`).all())).join("\n");
  const everything = [dump, logged.join("\n"), res.headers.getSetCookie().join("\n"), await res.text()].join("\n");
  for (const secret of [...fake.issued, fake.clientSecret]) assert.ok(!everything.includes(secret), secret.slice(0, 10));
  assert.equal(fake.requests.filter((r) => r.path === "/users/helper-admin")[0].authorization, null);
});

test("a tampered, forged, garbled or re-keyed session cookie is a 401", async () => {
  const env = setup();
  const good = await adminCookieValue(env, OWNER);
  const [id, login, expires, mac] = good.split(".");
  const forged = [
    `${id}.${login}.${expires}.${flip(mac)}`,
    `${id}.${login}.${Number(expires) + 86400}.${mac}`,
    `${OWNER_TWO.id}.${login}.${expires}.${mac}`,
    `${id}.someone-else.${expires}.${mac}`,
    `${id}.${login}.${expires}.${mac.toUpperCase()}`,
    `${id}.${login}.${expires}.${mac.slice(1)}`,
    `${id}.${login}.${expires}`,
    `${id}.${expires}.${mac}`,
    "garbage",
    await adminCookieValue({ ...env, SESSION_KEY: "another-key" }, OWNER),
    "1001.owner-one.9999999999.".padEnd(100, "0"),
  ];
  for (const value of forged) assert.equal((await call(env, "GET", "/api/admin/me", { cookie: `${ADMIN_COOKIE}=${value}` })).status, 401, value);
  assert.equal((await call(env, "GET", "/api/admin/me", { cookie: `${ADMIN_COOKIE}=${good}` })).status, 200);
});

test("a correctly signed session is refused once expired and accepted just before", async () => {
  const env = setup();
  const issued = Math.floor(Date.now() / 1000);
  const open = (at) => adminCookieValue(env, OWNER, at).then((value) => call(env, "GET", "/api/admin/me", { cookie: `${ADMIN_COOKIE}=${value}` }));
  assert.equal((await open(issued - ADMIN_SECONDS + 60)).status, 200);
  assert.equal((await open(issued - ADMIN_SECONDS - 1)).status, 401);
  assert.equal((await open(issued - 13 * 3600)).status, 401);
});

test("a signed session for an id that is neither owner nor admin is a 401", async () => {
  const env = setup();
  const cookie = `${ADMIN_COOKIE}=${await adminCookieValue(env, STRANGER)}`;
  for (const [method, path] of [["GET", "/api/admin/me"], ["GET", "/api/admin/stats"], ["GET", "/api/admin/messages"]]) assert.equal((await call(env, method, path, { cookie })).status, 401, path);
});

test("an admin removed by an owner gets 401 on their very next request with the same cookie", async () => {
  const env = setup();
  const owner = await signIn(env);
  const helper = sessionOf(await (async () => { addAdminRow(env, HELPER); return githubFlow(env, HELPER.login); })());
  assert.equal((await call(env, "GET", "/api/admin/stats", { cookie: helper })).status, 200);
  assert.equal((await post(env, "/api/admin/admins/remove", { github_id: HELPER.id }, { cookie: owner })).status, 200);
  for (const path of ["/api/admin/me", "/api/admin/stats", "/api/admin/messages"]) assert.equal((await call(env, "GET", path, { cookie: helper })).status, 401, path);
  assert.equal((await githubFlow(env, HELPER.login)).headers.get("location"), "/admin?signin=denied");
});

test("an admin added by an owner works on the next request without signing in again", async () => {
  const env = setup();
  const owner = await signIn(env);
  const cookie = `${ADMIN_COOKIE}=${await adminCookieValue(env, HELPER)}`;
  assert.equal((await call(env, "GET", "/api/admin/stats", { cookie })).status, 401);
  assert.equal((await post(env, "/api/admin/admins", { login: HELPER.login }, { cookie: owner })).status, 200);
  assert.equal((await call(env, "GET", "/api/admin/stats", { cookie })).status, 200);
});

test("an admin gets 403 on every owner route and nothing changes; an owner gets through", async () => {
  const env = setup();
  const admin = await signIn(env, HELPER);
  const owner = await signIn(env);
  const before = [adminRows(env), auditRows(env)];
  for (const [method, path, body] of OWNER_ROUTES) {
    const res = await call(env, method, path, { cookie: admin, body, headers: { "X-Admin": "1" } });
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.deepEqual(await res.json(), { error: "owner only" });
  }
  assert.deepEqual([adminRows(env), auditRows(env)], before);
  for (const [method, path] of OWNER_ROUTES.filter(([m]) => m === "GET")) assert.equal((await call(env, method, path, { cookie: owner })).status, 200, path);
  assert.equal((await call(env, "GET", "/api/admin/stats", { cookie: admin })).status, 200);
});

test("owner ids cannot be added or removed, by login or by id", async () => {
  const env = setup();
  const owner = await signIn(env);
  for (const user of [OWNER, OWNER_TWO]) {
    const add = await post(env, "/api/admin/admins", { login: user.login }, { cookie: owner });
    assert.equal(add.status, 400, user.login);
    const remove = await post(env, "/api/admin/admins/remove", { github_id: user.id }, { cookie: owner });
    assert.equal(remove.status, 400, String(user.id));
  }
  assert.deepEqual(adminRows(env), []);
  assert.deepEqual(auditRows(env), []);
});

test("adding an admin resolves the username through GitHub unauthenticated, stores the numeric id and the canonical login", async () => {
  const env = setup();
  const owner = await signIn(env);
  const res = await post(env, "/api/admin/admins", { login: "  Helper-Admin " }, { cookie: owner });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id: HELPER.id, login: HELPER.login });
  assert.deepEqual(env.DB.raw.prepare("SELECT github_id, login, added_by FROM admins").all().map((r) => ({ ...r })), [{ github_id: HELPER.id, login: HELPER.login, added_by: OWNER.id }]);
  const lookup = fake.requests.find((r) => r.path.startsWith("/users/"));
  assert.equal(lookup.origin, "https://api.github.com");
  assert.equal(lookup.path, "/users/Helper-Admin");
  assert.equal(lookup.authorization, null);
  const listed = await (await call(env, "GET", "/api/admin/admins", { cookie: owner })).json();
  assert.deepEqual(listed.owners.sort(), [OWNER.id, OWNER_TWO.id]);
  assert.deepEqual(listed.admins.map(({ id, login, addedBy }) => ({ id, login, addedBy })), [{ id: HELPER.id, login: HELPER.login, addedBy: OWNER.id }]);
});

test("adding refuses a bad name, an unknown user, an organisation, a duplicate and a GitHub outage, and writes nothing", async () => {
  const env = setup();
  const owner = await signIn(env);
  const add = (login) => post(env, "/api/admin/admins", { login }, { cookie: owner });
  for (const login of ["", "has space", "-lead", "trail-", "a".repeat(40), "../x", "x/y", 5, null, ["a"]]) assert.equal((await add(login)).status, 400, JSON.stringify(login));
  assert.equal((await post(env, "/api/admin/admins", {}, { cookie: owner })).status, 400);
  assert.equal((await add("nobody-by-this-name")).status, 404);
  assert.equal((await add(ORG.login)).status, 400);
  assert.equal((await add(HELPER.login)).status, 200);
  assert.equal((await add(HELPER.login)).status, 409);
  fake.state.failLookup = 403;
  assert.equal((await add(SECOND.login)).status, 502);
  assert.deepEqual(adminRows(env), [HELPER.id]);
  assert.deepEqual(auditRows(env).map((r) => r.action), ["admin_add"]);
});

test("removing refuses a bad id and an id that is not an admin", async () => {
  const env = setup();
  const owner = await signIn(env);
  for (const github_id of ["2001", -1, 0, 1.5, null, undefined, [2001]]) assert.equal((await post(env, "/api/admin/admins/remove", { github_id }, { cookie: owner })).status, 400, JSON.stringify(github_id));
  assert.equal((await post(env, "/api/admin/admins/remove", { github_id: 987654 }, { cookie: owner })).status, 404);
  assert.deepEqual(auditRows(env), []);
});

test("delete, add and remove each write an audit row with the actor, and the owner reads them newest first", async () => {
  const env = setup();
  const owner = await signIn(env);
  await post(env, "/api/admin/admins", { login: HELPER.login }, { cookie: owner });
  const helper = await signIn(env, HELPER);
  const kept = await store(env, { subject: "private subject" });
  const gone = await store(env, { subject: "other private subject" });
  assert.equal((await post(env, "/api/admin/delete", { ids: [gone.id, gone.id, "never-existed"] }, { cookie: helper })).status, 200);
  await post(env, "/api/admin/admins/remove", { github_id: HELPER.id }, { cookie: owner });
  assert.deepEqual(auditRows(env), [
    { actor_id: OWNER.id, actor_login: OWNER.login, action: "admin_add", target: HELPER.login, detail: `id=${HELPER.id}` },
    { actor_id: HELPER.id, actor_login: HELPER.login, action: "delete", target: "2 messages", detail: `${gone.id},never-existed` },
    { actor_id: OWNER.id, actor_login: OWNER.login, action: "admin_remove", target: HELPER.login, detail: `id=${HELPER.id}` },
  ]);
  const { entries } = await (await call(env, "GET", "/api/admin/audit", { cookie: owner })).json();
  assert.deepEqual(entries.map((e) => e.action), ["admin_remove", "delete", "admin_add"]);
  assert.deepEqual(Object.keys(entries[0]).sort(), ["action", "actor", "actorId", "at", "detail", "id", "target"]);
  assert.match(entries[0].at, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(!JSON.stringify(entries).includes("private subject"));
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM messages WHERE id = ?").get(kept.id).n, 1);
});

test("a refused delete writes no audit row, and the audit view is capped at the latest 200", async () => {
  const env = setup();
  const owner = await signIn(env);
  assert.equal((await post(env, "/api/admin/delete", { ids: [] }, { cookie: owner })).status, 400);
  assert.deepEqual(auditRows(env), []);
  const insert = env.DB.raw.prepare("INSERT INTO admin_audit (at, actor_id, actor_login, action) VALUES (?, 1, 'x', 'delete')");
  for (let i = 0; i < 230; i += 1) insert.run(1_700_000_000 + i);
  const { entries } = await (await call(env, "GET", "/api/admin/audit", { cookie: owner })).json();
  assert.equal(entries.length, 200);
  assert.ok(entries[0].id > entries[199].id);
});

test("every admin endpoint except login, callback and logout is 401 without the cookie", async () => {
  const env = setup();
  const { id } = await store(env);
  for (const [method, path, body] of [["GET", "/api/admin/me"], ["GET", "/api/admin/stats"], ["GET", "/api/admin/messages"], ["GET", `/api/admin/messages/${id}/raw`], ["POST", "/api/admin/delete", { ids: [id] }], ...OWNER_ROUTES]) {
    const res = await call(env, method, path, { body, headers: { "X-Admin": "1" } });
    assert.equal(res.status, 401, `${method} ${path}`);
  }
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM messages WHERE id = ?").get(id).n, 1);
  assert.deepEqual(auditRows(env), []);
});

test("the inbox session cookie and the state cookie do not open the admin API", async () => {
  const env = setup();
  assert.equal((await call(env, "GET", "/api/admin/stats", { cookie: "inboxes=v3.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.1.00" })).status, 401);
  const start = await call(env, "GET", "/api/admin/auth/login");
  const stateValue = cookieNamed(start, OAUTH_COOKIE).split(";")[0].split("=")[1];
  assert.equal((await call(env, "GET", "/api/admin/stats", { cookie: `${ADMIN_COOKIE}=${stateValue}` })).status, 401);
});

test("a state-changing request needs JSON and the X-Admin header", async () => {
  const env = setup();
  const cookie = await signIn(env);
  const { id } = await store(env);
  const body = { ids: [id] };
  assert.equal((await call(env, "POST", "/api/admin/logout", { cookie, body: {} })).status, 403);
  assert.equal((await call(env, "POST", "/api/admin/delete", { cookie, body })).status, 403);
  assert.equal((await call(env, "POST", "/api/admin/admins", { cookie, body: { login: HELPER.login } })).status, 403);
  assert.equal((await call(env, "POST", "/api/admin/admins/remove", { cookie, body: { github_id: 1 } })).status, 403);
  assert.equal((await post(env, "/api/admin/delete", "ids=1", { cookie, headers: { "Content-Type": "application/x-www-form-urlencoded" } })).status, 415);
  assert.equal((await post(env, "/api/admin/admins", "login=x", { cookie, headers: { "Content-Type": "text/plain" } })).status, 415);
  assert.equal((await post(env, "/api/admin/delete", body, { cookie, headers: { "X-Admin": "0" } })).status, 403);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM messages WHERE id = ?").get(id).n, 1);
  assert.deepEqual(adminRows(env), []);
});

test("the admin routes accept only the documented methods", async () => {
  const env = setup();
  const cookie = await signIn(env);
  for (const [method, path] of [["POST", "/api/admin/auth/login"], ["POST", "/api/admin/auth/callback"], ["DELETE", "/api/admin/admins"], ["PUT", "/api/admin/admins"], ["GET", "/api/admin/admins/remove"], ["POST", "/api/admin/me"], ["POST", "/api/admin/login"]]) {
    assert.equal((await call(env, method, path, { cookie, headers: { "X-Admin": "1" }, body: method === "POST" ? {} : undefined })).status, 404, `${method} ${path}`);
  }
});

test("logout clears the session cookie", async () => {
  const env = setup();
  const res = await post(env, "/api/admin/logout", {}, { cookie: await signIn(env) });
  assert.equal(res.status, 200);
  assert.match(cookieNamed(res, ADMIN_COOKIE), new RegExp(`^${ADMIN_COOKIE}=; .*Max-Age=0`));
});

test("the log records admin events as ids and counts, never the token, cookies, logins, mail content or addresses", async () => {
  const env = setup();
  const res = await githubFlow(env, OWNER.login);
  const owner = sessionOf(res);
  await githubFlow(env, STRANGER.login);
  await post(env, "/api/admin/admins", { login: HELPER.login }, { cookie: owner });
  const { id } = await store(env, { subject: "private subject" });
  await post(env, "/api/admin/delete", { ids: [id] }, { cookie: owner });
  await post(env, "/api/admin/admins/remove", { github_id: HELPER.id }, { cookie: owner });
  const text = logged.join("\n");
  assert.match(text, new RegExp(`"event":"admin_login","ok":true,"id":${OWNER.id}`));
  assert.match(text, new RegExp(`"event":"admin_login","ok":false,"id":${STRANGER.id}`));
  assert.match(text, new RegExp(`"event":"admin_add","actor":${OWNER.id},"id":${HELPER.id}`));
  assert.match(text, new RegExp(`"event":"admin_delete","actor":${OWNER.id},"requested":1,"deleted":1`));
  assert.match(text, new RegExp(`"event":"admin_remove","actor":${OWNER.id},"id":${HELPER.id}`));
  for (const secret of [owner.split("=")[1], ...fake.issued, fake.clientSecret, OWNER.login, STRANGER.login, HELPER.login, "private subject", "203.0.113.7"]) assert.ok(!text.includes(secret), secret);
});

test("migration 0002 can run twice and leaves existing data alone", async () => {
  const env = setup();
  addAdminRow(env, HELPER);
  const sql = fs.readFileSync(new URL("../migrations/0002_admin_roles.sql", import.meta.url), "utf8");
  env.DB.raw.exec(sql);
  env.DB.raw.exec(sql);
  assert.deepEqual(adminRows(env), [HELPER.id]);
});
