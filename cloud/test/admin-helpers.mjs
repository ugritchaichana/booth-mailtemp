import assert from "node:assert/strict";
import crypto from "node:crypto";
import { openD1 } from "./d1-shim.mjs";
import { createFakeGithub } from "./fake-github.mjs";
import { handle } from "../src/api.js";
import { ADMIN_COOKIE, adminCookieValue } from "../src/admin.js";
import { ingest } from "../src/store.js";

export const DOMAIN = "booth.pp.ua";
export const SESSION_KEY = "admin-unit-test-key";
export const OWNER = { id: 1001, login: "owner-one" };
export const OWNER_TWO = { id: 1002, login: "owner-two" };
export const HELPER = { id: 2001, login: "helper-admin" };
export const SECOND = { id: 2002, login: "second-admin" };
export const STRANGER = { id: 3001, login: "stranger" };
export const ORG = { id: 4001, login: "some-org" };

export const logged = [];
console.log = (line) => logged.push(String(line));

export const fake = createFakeGithub({ origins: { oauth: "https://github.com", api: "https://api.github.com" } });
for (const user of [OWNER, OWNER_TWO, HELPER, SECOND, STRANGER]) fake.addAccount(user.login, user.id);
fake.addAccount(ORG.login, ORG.id, "Organization");
globalThis.fetch = (input, init) => fake.handle(new Request(input, init));

export const setup = (overrides = {}) => {
  fake.reset();
  logged.length = 0;
  return {
    DB: openD1(),
    SESSION_KEY,
    GITHUB_CLIENT_ID: fake.clientId,
    GITHUB_CLIENT_SECRET: fake.clientSecret,
    OWNER_GITHUB_IDS: `${OWNER.id},${OWNER_TWO.id}`,
    MAIL_DOMAIN: DOMAIN,
    STORED_BYTES_CAP: "400000000",
    ...overrides,
  };
};

export async function call(env, method, path, { body, cookie, ip = "203.0.113.7", headers = {}, https = true } = {}) {
  const init = { method, headers: { "cf-connecting-ip": ip, ...headers } };
  if (cookie) init.headers.Cookie = cookie;
  if (body !== undefined) {
    init.headers["Content-Type"] ??= "application/json";
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return handle(new Request(`${https ? "https" : "http"}://mail.test${path}`, init), env, {});
}

export const post = (env, path, body, options = {}) => call(env, "POST", path, { body, ...options, headers: { "X-Admin": "1", ...options.headers } });

export const addAdminRow = (env, user, addedBy = OWNER.id) => env.DB.raw.prepare("INSERT OR IGNORE INTO admins (github_id, login, added_by, added_at) VALUES (?, ?, ?, ?)").run(user.id, user.login, addedBy, 1_700_000_000);

export async function signIn(env, user = OWNER) {
  if (user !== OWNER && user !== OWNER_TWO) addAdminRow(env, user);
  return `${ADMIN_COOKIE}=${await adminCookieValue(env, user)}`;
}

export const cookieNamed = (res, name) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));

export async function githubFlow(env, login, { https = true, tamper } = {}) {
  fake.signInAs(login);
  const start = await call(env, "GET", "/api/admin/auth/login", { https });
  const oauth = cookieNamed(start, "mt_oauth").split(";")[0];
  const back = await fake.handle(new Request(start.headers.get("location")));
  const callback = new URL(back.headers.get("location"));
  return call(env, "GET", callback.pathname + callback.search, { cookie: tamper ? tamper(oauth) : oauth, https });
}

export function mail({ to = "alice@booth.pp.ua", from = "sender@example.com", subject = "hello", id = crypto.randomUUID(), size = 2000, extra = [] } = {}) {
  const head = [`From: ${from}`, `To: ${to}`, `Subject: ${subject}`, `Message-ID: <${id}@example.com>`, "Date: Fri, 16 Oct 2026 10:00:00 +0000", ...extra].join("\r\n");
  const body = crypto.randomBytes(Math.max(size - head.length - 4, 0));
  return new Uint8Array(Buffer.concat([Buffer.from(`${head}\r\n\r\n`), body]));
}

export async function store(env, options = {}) {
  const raw = mail(options);
  const to = options.envelopeTo ?? [options.to ?? "alice@booth.pp.ua"];
  const result = await ingest(env.DB, raw, { to }, DOMAIN);
  assert.equal(result.stored, true);
  return { id: result.id, raw };
}

export const count = (env, table, column, id) => env.DB.raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(id).n;
export const flip = (value) => value.slice(0, -1) + (value.endsWith("0") ? "1" : "0");
export const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
