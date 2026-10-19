import { cookieValue, hex } from "./sessions.js";
import { ID_RE } from "./rules.js";
import { chunkStream, deleteMessages } from "./store.js";
import { fail, json } from "./http.js";

export const ADMIN_COOKIE = "mt_admin";
export const OAUTH_COOKIE = "mt_oauth";
export const ADMIN_SECONDS = 12 * 3600;
export const OAUTH_SECONDS = 600;
const DEFAULT_OAUTH_BASE = "https://github.com";
const DEFAULT_API_BASE = "https://api.github.com";
const GITHUB_TIMEOUT_MS = 10000;
const PAGE_SIZE = 100;
const MAX_DELETE = 100;
const MAX_BODY = 16384;
const MAX_PATTERN_BYTES = 50;
const AUDIT_LIMIT = 200;
const CURSOR_RE = /^\d{1,15}$/;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const SESSION_RE = /^(\d{1,15})\.([A-Za-z0-9-]{1,39})\.(\d{1,12})\.([0-9a-f]{64})$/;
const STATE_RE = /^([A-Za-z0-9_-]{43})\.(\d{1,12})\.([0-9a-f]{64})$/;
const OWNER_ROUTES = new Set(["GET admins", "POST admins", "POST admins/remove", "GET audit"]);
const encoder = new TextEncoder();

const now = () => Math.floor(Date.now() / 1000);
const log = (event, fields = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function hmac(env, text) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(env.SESSION_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(text)));
}

function sameBytes(a, b) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ (b[i] ?? 0);
  return diff === 0;
}

const sameText = (a, b) => sameBytes(encoder.encode(a), encoder.encode(b));
const sign = async (env, kind, text) => hex(await hmac(env, `${kind}:${text}`));
const ownerIds = (env) => new Set(String(env.OWNER_GITHUB_IDS ?? "").split(",").map((s) => s.trim()).filter((s) => /^\d{1,15}$/.test(s)).map(Number));
const githubBases = (env) => ({ oauth: env.GITHUB_OAUTH_BASE || DEFAULT_OAUTH_BASE, api: env.GITHUB_API_BASE || DEFAULT_API_BASE });

export async function adminCookieValue(env, { id, login }, issuedAt = now()) {
  const body = `${id}.${login}.${issuedAt + ADMIN_SECONDS}`;
  return `${body}.${await sign(env, "admin-session", body)}`;
}

async function resolveSession(request, env) {
  const match = SESSION_RE.exec(cookieValue(request.headers.get("cookie"), ADMIN_COOKIE));
  if (!match || Number(match[3]) <= now()) return null;
  const [, rawId, login, expires, mac] = match;
  if (!sameText(mac, await sign(env, "admin-session", `${rawId}.${login}.${expires}`))) return null;
  const id = Number(rawId);
  if (ownerIds(env).has(id)) return { id, login, role: "owner" };
  const row = await env.DB.prepare("SELECT 1 AS x FROM admins WHERE github_id = ?").bind(id).first();
  return row ? { id, login, role: "admin" } : null;
}

const cookieHeader = (name, value, { path, sameSite, secure, maxAge }) => `${name}=${value}; HttpOnly; SameSite=${sameSite}; Path=${path}; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
const sessionCookie = (value, secure, maxAge = ADMIN_SECONDS) => cookieHeader(ADMIN_COOKIE, value, { path: "/api/admin", sameSite: "Strict", secure, maxAge });
const oauthCookie = (value, secure, maxAge = OAUTH_SECONDS) => cookieHeader(OAUTH_COOKIE, value, { path: "/api/admin/auth", sameSite: "Lax", secure, maxAge });

async function readBody(request) {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return fail(415, "expected application/json");
  if (request.headers.get("x-admin") !== "1") return fail(403, "missing X-Admin header");
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) throw new Error("body too large");
    const body = JSON.parse(text || "{}");
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("body must be an object");
    return body;
  } catch {
    return fail(400, "invalid body");
  }
}

function likePattern(text) {
  const build = (chars) => `%${chars.join("").replace(/[\\%_]/g, "\\$&")}%`;
  const chars = [...text];
  while (chars.length && encoder.encode(build(chars)).length > MAX_PATTERN_BYTES) chars.pop();
  return build(chars);
}

async function listMessages(env, url) {
  const before = url.searchParams.get("before");
  if (before !== null && !CURSOR_RE.test(before)) return fail(400, "invalid before");
  const q = (url.searchParams.get("q") ?? "").trim();
  const where = [];
  const args = [];
  if (before !== null) {
    where.push("m.rowid < ?");
    args.push(Number(before));
  }
  if (q) {
    where.push(`(m.subject LIKE ? ESCAPE '\\' OR m.from_addr LIKE ? ESCAPE '\\' OR m.from_name LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM recipients x WHERE x.message_id = m.id AND x.address LIKE ? ESCAPE '\\'))`);
    args.push(...Array(4).fill(likePattern(q)));
  }
  const { results } = await env.DB.prepare(
    `SELECT m.rowid AS rid, m.id, m.created, m.from_name, m.from_addr, m.subject, m.size, m.attachments,
            (SELECT group_concat(r.address, ',') FROM recipients r WHERE r.message_id = m.id) AS recipients
       FROM messages m ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY m.rowid DESC LIMIT ?`,
  ).bind(...args, PAGE_SIZE + 1).all();
  const page = results.slice(0, PAGE_SIZE);
  return json(200, {
    messages: page.map((m) => ({
      rid: m.rid,
      id: m.id,
      created: new Date(m.created * 1000).toISOString(),
      from: { Name: m.from_name, Address: m.from_addr },
      to: m.recipients ? m.recipients.split(",") : [],
      subject: m.subject,
      size: m.size,
      attachments: m.attachments,
    })),
    next: results.length > PAGE_SIZE ? page[page.length - 1].rid : null,
  });
}

async function rawMessage(env, id) {
  if (!ID_RE.test(id)) return fail(404, "not found");
  const message = await env.DB.prepare("SELECT id, chunks FROM messages WHERE id = ?").bind(id).first();
  if (!message) return fail(404, "not found");
  return new Response(chunkStream(env.DB, message), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": 'attachment; filename="message.eml"',
      "Content-Security-Policy": "sandbox",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

const auditRow = (env, actor, action, target = "", detail = "") => env.DB.prepare(
  "INSERT INTO admin_audit (at, actor_id, actor_login, action, target, detail) VALUES (?, ?, ?, ?, ?, ?)",
).bind(now(), actor.id, actor.login, action, target, detail);

async function deleteSelected(request, env, actor) {
  const body = await readBody(request);
  if (body instanceof Response) return body;
  const { ids } = body;
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_DELETE || !ids.every((id) => typeof id === "string" && ID_RE.test(id))) {
    return fail(400, `ids must be 1-${MAX_DELETE} message ids`);
  }
  const unique = [...new Set(ids)];
  await auditRow(env, actor, "delete", `${unique.length} messages`, unique.join(",")).run();
  const deleted = await deleteMessages(env.DB, unique);
  log("admin_delete", { actor: actor.id, requested: ids.length, deleted });
  return json(200, { deleted });
}

async function stats(env) {
  const { results, meta } = await env.DB.prepare(
    "SELECT COUNT(*) AS messages, COALESCE(SUM(stored), 0) AS stored, MIN(created) AS oldest, MAX(created) AS latest FROM messages",
  ).all();
  const [row] = results;
  const iso = (seconds) => (seconds ? new Date(seconds * 1000).toISOString() : null);
  return json(200, {
    messages: row.messages,
    storedBytes: row.stored,
    storedBytesCap: Number(env.STORED_BYTES_CAP) || null,
    d1SizeBytes: meta?.size_after ?? null,
    oldestAt: iso(row.oldest),
    lastIngestAt: iso(row.latest),
  });
}

const githubFetch = (url, init = {}) => fetch(url, {
  ...init,
  signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  headers: { Accept: "application/json", "User-Agent": "mailtemp-cloud", ...init.headers },
});

const parseUser = (body) => (Number.isSafeInteger(body?.id) && body.id > 0 && typeof body.login === "string" && LOGIN_RE.test(body.login) ? { id: body.id, login: body.login, type: body.type } : null);

async function githubIdentity(env, code, redirectUri) {
  const bases = githubBases(env);
  const tokenRes = await githubFetch(`${bases.oauth}/login/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: redirectUri }),
  });
  const token = tokenRes.ok ? (await tokenRes.json()).access_token : null;
  if (typeof token !== "string" || !token) return null;
  const userRes = await githubFetch(`${bases.api}/user`, { headers: { Authorization: `Bearer ${token}` } });
  return userRes.ok ? parseUser(await userRes.json()) : null;
}

async function lookupUser(env, login) {
  const res = await githubFetch(`${githubBases(env).api}/users/${encodeURIComponent(login)}`);
  if (res.status === 404) return { missing: true };
  if (!res.ok) throw new Error(`github users lookup ${res.status}`);
  return parseUser(await res.json()) ?? { missing: true };
}

function html(status, message, cookies = []) {
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
  });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin sign in</title>`
    + `<style>body{font:16px system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem}</style>`
    + `<h1>Admin sign in</h1><p>${message}</p><p><a href="/admin">Back to the admin page</a></p>`,
    { status, headers },
  );
}

async function startLogin(url, env, secure) {
  const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const body = `${state}.${now() + OAUTH_SECONDS}`;
  const authorize = new URL(`${githubBases(env).oauth}/login/oauth/authorize`);
  authorize.search = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: `${url.origin}/api/admin/auth/callback`,
    state,
    scope: "",
    allow_signup: "false",
  });
  const headers = new Headers({ Location: authorize.href, "Cache-Control": "no-store" });
  headers.append("Set-Cookie", oauthCookie(`${body}.${await sign(env, "admin-oauth", body)}`, secure));
  return new Response(null, { status: 302, headers });
}

async function verifiedState(request, env, given) {
  const match = STATE_RE.exec(cookieValue(request.headers.get("cookie"), OAUTH_COOKIE));
  if (!match || Number(match[2]) <= now() || given === null) return false;
  if (!sameText(match[3], await sign(env, "admin-oauth", `${match[1]}.${match[2]}`))) return false;
  return sameText(match[1], given);
}

async function finishLogin(request, env, url, secure) {
  const clear = oauthCookie("", secure, 0);
  if (!(await verifiedState(request, env, url.searchParams.get("state")))) {
    return html(400, "This sign-in link has expired or was not started here. Start again from the admin page.", [clear]);
  }
  const code = url.searchParams.get("code") ?? "";
  if (url.searchParams.has("error") || !code || code.length > 200) return html(403, "GitHub sign-in was cancelled or refused.", [clear]);
  let user = null;
  try {
    user = await githubIdentity(env, code, `${url.origin}/api/admin/auth/callback`);
  } catch {
    log("admin_login", { ok: false, github: "unreachable" });
  }
  if (!user) return html(502, "GitHub did not confirm the sign-in. Try again in a minute.", [clear]);
  const allowed = ownerIds(env).has(user.id) || (await env.DB.prepare("SELECT 1 AS x FROM admins WHERE github_id = ?").bind(user.id).first());
  if (!allowed) {
    log("admin_login", { ok: false, id: user.id });
    return html(403, "This GitHub account is not authorised for the admin area.", [clear]);
  }
  log("admin_login", { ok: true, id: user.id });
  const headers = new Headers({ Location: "/admin", "Cache-Control": "no-store" });
  headers.append("Set-Cookie", sessionCookie(await adminCookieValue(env, user), secure));
  headers.append("Set-Cookie", clear);
  return new Response(null, { status: 302, headers });
}

async function listAdmins(env) {
  const { results } = await env.DB.prepare("SELECT github_id, login, added_by, added_at FROM admins ORDER BY added_at, github_id").all();
  return json(200, {
    owners: [...ownerIds(env)],
    admins: results.map((r) => ({ id: r.github_id, login: r.login, addedBy: r.added_by, addedAt: new Date(r.added_at * 1000).toISOString() })),
  });
}

async function addAdmin(request, env, actor) {
  const body = await readBody(request);
  if (body instanceof Response) return body;
  const login = typeof body.login === "string" ? body.login.trim() : "";
  if (!LOGIN_RE.test(login)) return fail(400, "enter a GitHub username");
  let user;
  try {
    user = await lookupUser(env, login);
  } catch (err) {
    log("admin_lookup", { ok: false, error: String(err.message) });
    return fail(502, "GitHub lookup failed, try again in a minute");
  }
  if (user.missing) return fail(404, "no GitHub user with that name");
  if (user.type !== "User") return fail(400, "that GitHub account is not a user");
  if (ownerIds(env).has(user.id)) return fail(400, "owners are set in the Worker config and cannot be added");
  if (await env.DB.prepare("SELECT 1 AS x FROM admins WHERE github_id = ?").bind(user.id).first()) return fail(409, "already an admin");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO admins (github_id, login, added_by, added_at) VALUES (?, ?, ?, ?)").bind(user.id, user.login, actor.id, now()),
    auditRow(env, actor, "admin_add", user.login, `id=${user.id}`),
  ]);
  log("admin_add", { actor: actor.id, id: user.id });
  return json(200, { id: user.id, login: user.login });
}

async function removeAdmin(request, env, actor) {
  const body = await readBody(request);
  if (body instanceof Response) return body;
  const id = body.github_id;
  if (!Number.isSafeInteger(id) || id <= 0) return fail(400, "github_id must be a number");
  if (ownerIds(env).has(id)) return fail(400, "owners are set in the Worker config and cannot be removed");
  const row = await env.DB.prepare("SELECT login FROM admins WHERE github_id = ?").bind(id).first();
  if (!row) return fail(404, "not an admin");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM admins WHERE github_id = ?").bind(id),
    auditRow(env, actor, "admin_remove", row.login, `id=${id}`),
  ]);
  log("admin_remove", { actor: actor.id, id });
  return json(200, { removed: id });
}

async function auditLog(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, at, actor_id, actor_login, action, target, detail FROM admin_audit ORDER BY id DESC LIMIT ?",
  ).bind(AUDIT_LIMIT).all();
  return json(200, {
    entries: results.map((r) => ({ id: r.id, at: new Date(r.at * 1000).toISOString(), actorId: r.actor_id, actor: r.actor_login, action: r.action, target: r.target, detail: r.detail })),
  });
}

export async function handleAdmin(request, env) {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return fail(404, "not found");
  const url = new URL(request.url);
  const secure = url.protocol === "https:";
  const method = request.method;
  const segments = url.pathname.split("/").filter(Boolean).slice(2);
  const route = segments.join("/");

  if (method === "GET" && route === "auth/login") return startLogin(url, env, secure);
  if (method === "GET" && route === "auth/callback") return finishLogin(request, env, url, secure);
  if (method === "POST" && route === "logout") {
    const body = await readBody(request);
    return body instanceof Response ? body : json(200, { ok: true }, { "Set-Cookie": sessionCookie("", secure, 0) });
  }
  const me = await resolveSession(request, env);
  if (!me) return fail(401, "sign in required");
  if (OWNER_ROUTES.has(`${method} ${route}`) && me.role !== "owner") return fail(403, "owner only");

  if (method === "GET" && route === "me") return json(200, { id: me.id, login: me.login, role: me.role });
  if (method === "GET" && route === "stats") return stats(env);
  if (method === "GET" && route === "messages") return listMessages(env, url);
  if (method === "GET" && segments[0] === "messages" && segments[2] === "raw" && segments.length === 3) return rawMessage(env, segments[1]);
  if (method === "POST" && route === "delete") return deleteSelected(request, env, me);
  if (method === "GET" && route === "admins") return listAdmins(env);
  if (method === "POST" && route === "admins") return addAdmin(request, env, me);
  if (method === "POST" && route === "admins/remove") return removeAdmin(request, env, me);
  if (method === "GET" && route === "audit") return auditLog(env);
  return fail(404, "not found");
}
