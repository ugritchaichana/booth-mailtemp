import { cookieValue, hex, limiter } from "./sessions.js";
import { ID_RE } from "./rules.js";
import { chunkStream, deleteMessages } from "./store.js";
import { fail, json } from "./http.js";

export const ADMIN_COOKIE = "mt_admin";
export const ADMIN_SECONDS = 12 * 3600;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_SECONDS = 600;
const PAGE_SIZE = 100;
const MAX_DELETE = 100;
const MAX_BODY = 16384;
const MAX_PATTERN_BYTES = 50;
const CURSOR_RE = /^\d{1,15}$/;
const COOKIE_RE = /^(\d{1,12})\.([0-9a-f]{64})$/;
const encoder = new TextEncoder();

const now = () => Math.floor(Date.now() / 1000);
const log = (event, fields = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));

async function hmac(env, text) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(env.SESSION_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(text)));
}

function sameBytes(a, b) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ (b[i] ?? 0);
  return diff === 0;
}

const passwordMatches = async (env, given) => sameBytes(await hmac(env, `admin-pw:${given}`), await hmac(env, `admin-pw:${env.ADMIN_PASSWORD}`));
const signature = async (env, expires) => hex(await hmac(env, `admin-v1:${expires}:${env.ADMIN_PASSWORD}`));

export async function adminCookieValue(env, issuedAt = now()) {
  const expires = issuedAt + ADMIN_SECONDS;
  return `${expires}.${await signature(env, expires)}`;
}

async function isAdmin(request, env) {
  const match = COOKIE_RE.exec(cookieValue(request.headers.get("cookie"), ADMIN_COOKIE));
  if (!match || Number(match[1]) <= now()) return false;
  return sameBytes(encoder.encode(match[2]), encoder.encode(await signature(env, match[1])));
}

const cookieHeader = (value, secure, maxAge) => `${ADMIN_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;

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

async function deleteSelected(request, env) {
  const body = await readBody(request);
  if (body instanceof Response) return body;
  const { ids } = body;
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_DELETE || !ids.every((id) => typeof id === "string" && ID_RE.test(id))) {
    return fail(400, `ids must be 1-${MAX_DELETE} message ids`);
  }
  const deleted = await deleteMessages(env.DB, [...new Set(ids)]);
  log("admin_delete", { requested: ids.length, deleted });
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

async function login(request, env, secure) {
  const body = await readBody(request);
  if (body instanceof Response) return body;
  const attempts = limiter(env.DB, "admin-login", LOGIN_MAX_FAILURES, LOGIN_WINDOW_SECONDS);
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (await attempts.full(ip)) {
    log("admin_login", { ok: false, limited: true });
    return fail(429, "too many attempts, try again later");
  }
  if (typeof body.password !== "string" || !(await passwordMatches(env, body.password))) {
    await attempts.hit(ip);
    log("admin_login", { ok: false });
    return fail(401, "wrong password");
  }
  log("admin_login", { ok: true });
  return json(200, { ok: true }, { "Set-Cookie": cookieHeader(await adminCookieValue(env), secure, ADMIN_SECONDS) });
}

export async function handleAdmin(request, env) {
  if (!env.ADMIN_PASSWORD) return fail(404, "not found");
  const url = new URL(request.url);
  const secure = url.protocol === "https:";
  const method = request.method;
  const segments = url.pathname.split("/").filter(Boolean).slice(2);
  const route = segments.join("/");

  if (method === "POST" && route === "login") return login(request, env, secure);
  if (method === "POST" && route === "logout") {
    const body = await readBody(request);
    return body instanceof Response ? body : json(200, { ok: true }, { "Set-Cookie": cookieHeader("", secure, 0) });
  }
  if (!(await isAdmin(request, env))) return fail(401, "sign in required");

  if (method === "GET" && route === "stats") return stats(env);
  if (method === "GET" && route === "messages") return listMessages(env, url);
  if (method === "GET" && segments[0] === "messages" && segments[2] === "raw" && segments.length === 3) return rawMessage(env, segments[1]);
  if (method === "POST" && route === "delete") return deleteSelected(request, env);
  return fail(404, "not found");
}
