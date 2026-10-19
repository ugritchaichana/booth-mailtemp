import { openAccounts, limiter } from "./sessions.js";
import { ID_RE, usernameError } from "./rules.js";
import { hide, lastIngest, listFor, markRead, ownMessage, rawStream } from "./store.js";

const RANDOM_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
const MAX_BODY = 2048;
const CURSOR_RE = /^\d{1,15}$/;

const json = (status, body, extra = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra },
});
const fail = (status, error) => json(status, { error });

async function readUsername(request) {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return fail(415, "expected application/json");
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) throw new Error("body too large");
    const body = JSON.parse(text || "{}");
    if (body === null || typeof body !== "object") throw new Error("body must be an object");
    return String(body.username ?? "").trim().toLowerCase();
  } catch {
    return fail(400, "invalid body");
  }
}

export async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const secure = url.protocol === "https:";
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const db = env.DB;
  const domain = env.MAIL_DOMAIN;
  const accounts = openAccounts(db, env.SESSION_KEY);
  const randomRequests = limiter(db, "random", 30, 60);
  const creations = limiter(db, "create", 30, 3600);
  const sessionStarts = limiter(db, "session", 300, 3600);
  const meBody = ({ accounts: list, active }) => ({ active, address: active ? `${active}@${domain}` : null, accounts: list });
  const reply = async (session, extra = {}) => json(200, { ...meBody(session ?? { accounts: [], active: null }), ...extra }, { "Set-Cookie": session ? (await accounts.issue(session.sid, secure))[0] : accounts.clear(secure)[0] });

  const { pathname } = url;
  const method = request.method;
  if (method === "GET" && pathname === "/api/status") {
    try {
      const at = await lastIngest(db);
      return json(200, { d1: "ok", lastIngestAt: at ? new Date(at * 1000).toISOString() : null, lastIngestAgeSeconds: at ? Math.floor(Date.now() / 1000) - at : null });
    } catch {
      return json(200, { d1: "down", lastIngestAt: null, lastIngestAgeSeconds: null });
    }
  }
  if (method === "GET" && pathname === "/api/random") {
    if (await randomRequests.full(ip)) return fail(429, "Too many requests, try again in a moment");
    await randomRequests.hit(ip);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const pick = crypto.getRandomValues(new Uint8Array(6));
      const name = `rand-${[...pick].map((b) => RANDOM_CHARS[b % RANDOM_CHARS.length]).join("")}`;
      if (!(await accounts.exists(name))) return json(200, { username: name });
    }
    return fail(503, "no free random name, try again");
  }
  if (method === "POST" && pathname === "/api/open") {
    const username = await readUsername(request);
    if (username instanceof Response) return username;
    const problem = usernameError(username);
    if (problem) return fail(400, problem);
    const current = await accounts.sessionFrom(request.headers.get("cookie"));
    if ((await creations.full(ip)) && !(await accounts.exists(username))) return fail(429, "too many new addresses, try later");
    if (!current && (await sessionStarts.full(ip))) return fail(429, "too many new browsers, try later");
    const { created } = await accounts.open(username);
    if (created) await creations.hit(ip);
    if (!current) await sessionStarts.hit(ip);
    return reply(await accounts.add(current?.sid ?? (await accounts.start()), username), { created });
  }

  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "api") return fail(404, "not found");
  const session = await accounts.sessionFrom(request.headers.get("cookie"));
  if (!session) return fail(401, "sign in required");

  if (method === "GET" && pathname === "/api/me") return json(200, meBody(session));
  if (method === "POST" && (pathname === "/api/switch" || pathname === "/api/forget")) {
    const username = await readUsername(request);
    if (username instanceof Response) return username;
    if (!session.accounts.includes(username)) return fail(403, "address is not opened in this browser");
    return reply(pathname === "/api/switch" ? await accounts.activate(session.sid, username) : await accounts.forget(session.sid, username));
  }
  if (segments[1] !== "messages") return fail(404, "not found");

  if (segments.length === 2) {
    if (method !== "GET") return fail(404, "not found");
    const since = url.searchParams.get("since");
    if (since !== null && !CURSOR_RE.test(since)) return fail(400, "invalid since");
    return json(200, await listFor(db, session.active, domain, since === null ? null : Number(since)));
  }
  const id = segments[2];
  if (!ID_RE.test(id)) return fail(404, "not found");
  const message = await ownMessage(db, session.active, id);
  if (!message) return fail(404, "not found");
  if (segments.length === 3 && method === "DELETE") {
    await hide(db, session.active, id);
    return json(200, { deleted: true });
  }
  if (segments.length === 4 && segments[3] === "raw" && method === "GET") {
    await markRead(db, session.active, id);
    return new Response(rawStream(db, message, session.active, domain), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": 'attachment; filename="message.eml"',
        "Content-Security-Policy": "sandbox",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  return fail(404, "not found");
}
