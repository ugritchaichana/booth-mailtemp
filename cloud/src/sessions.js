export const SESSION_SECONDS = 365 * 86400;
const TOUCH_SECONDS = 86400;
const SID_RE = /^v3\.([A-Za-z0-9_-]{43})\.(\d+)\.([0-9a-f]{64})$/;
const COOKIE = "inboxes";
const encoder = new TextEncoder();

const now = () => Math.floor(Date.now() / 1000);
const hex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const cookieValue = (header, name) => new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(header ?? "")?.[1] ?? "";

export function openAccounts(db, secret) {
  const keyPromise = crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sign = async (text) => hex(await crypto.subtle.sign("HMAC", await keyPromise, encoder.encode(text)));
  const sidHash = async (sid) => hex(await crypto.subtle.digest("SHA-256", encoder.encode(sid)));
  const flags = (secure, maxAge) => `HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;

  async function view(sid) {
    const id = await sidHash(sid);
    const { results } = await db.prepare(
      `SELECT s.active, s.seen, sa.username FROM sessions s
         LEFT JOIN session_accounts sa ON sa.session = s.id WHERE s.id = ? ORDER BY sa.position`,
    ).bind(id).all();
    const names = results.map((r) => r.username).filter(Boolean);
    if (!results.length || !names.length) return null;
    const { active, seen } = results[0];
    return { sid, id, seen, accounts: names, active: names.includes(active) ? active : names[0] };
  }

  const strip = ({ sid, accounts, active }) => ({ sid, accounts, active });

  return {
    async open(username) {
      const result = await db.prepare("INSERT OR IGNORE INTO users (username, created) VALUES (?, ?)").bind(username, now()).run();
      return { created: (result.meta?.changes ?? 0) === 1 };
    },
    async exists(username) {
      return (await db.prepare("SELECT 1 AS x FROM users WHERE username = ?").bind(username).first()) !== null;
    },
    async start() {
      const sid = base64url(crypto.getRandomValues(new Uint8Array(32)));
      await db.prepare("INSERT INTO sessions (id, active, created, seen) VALUES (?, NULL, ?, ?)").bind(await sidHash(sid), now(), now()).run();
      return sid;
    },
    async issue(sid, secure) {
      const iat = now();
      return [`${COOKIE}=v3.${sid}.${iat}.${await sign(`v3:${sid}.${iat}`)}; ${flags(secure, SESSION_SECONDS)}`];
    },
    clear: (secure = false) => [`${COOKIE}=; ${flags(secure, 0)}`],
    async sessionFrom(cookieHeader) {
      const m = SID_RE.exec(cookieValue(cookieHeader, COOKIE));
      if (!m || now() - Number(m[2]) >= SESSION_SECONDS || (await sign(`v3:${m[1]}.${m[2]}`)) !== m[3]) return null;
      const session = await view(m[1]);
      if (session && now() - session.seen > TOUCH_SECONDS) await db.prepare("UPDATE sessions SET seen = ? WHERE id = ?").bind(now(), session.id).run();
      return session && strip(session);
    },
    async add(sid, username) {
      const id = await sidHash(sid);
      await db.batch([
        db.prepare("INSERT OR IGNORE INTO session_accounts (session, username, position) VALUES (?1, ?2, (SELECT COALESCE(MAX(position), 0) + 1 FROM session_accounts WHERE session = ?1))").bind(id, username),
        db.prepare("UPDATE sessions SET active = ? WHERE id = ?").bind(username, id),
      ]);
      return strip(await view(sid));
    },
    async activate(sid, username) {
      await db.prepare("UPDATE sessions SET active = ? WHERE id = ?").bind(username, await sidHash(sid)).run();
      return strip(await view(sid));
    },
    async forget(sid, username) {
      const id = await sidHash(sid);
      await db.batch([
        db.prepare("DELETE FROM session_accounts WHERE session = ? AND username = ?").bind(id, username),
        db.prepare("UPDATE sessions SET active = (SELECT username FROM session_accounts WHERE session = ?1 ORDER BY position DESC LIMIT 1) WHERE id = ?1 AND active = ?2").bind(id, username),
        db.prepare("DELETE FROM sessions WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM session_accounts WHERE session = ?1)").bind(id),
      ]);
      const left = await view(sid);
      return left && strip(left);
    },
  };
}

export function limiter(db, name, max, windowSeconds) {
  const window = () => Math.floor(now() / windowSeconds);
  const key = (ip) => `${name}:${ip}`;
  return {
    async full(ip) {
      const row = await db.prepare("SELECT hits FROM rate_hits WHERE key = ? AND window = ?").bind(key(ip), window()).first();
      return (row?.hits ?? 0) >= max;
    },
    async hit(ip) {
      await db.prepare(
        "INSERT INTO rate_hits (key, window, hits, expires) VALUES (?1, ?2, 1, ?3) ON CONFLICT (key, window) DO UPDATE SET hits = hits + 1",
      ).bind(key(ip), window(), now() + windowSeconds * 2).run();
    },
  };
}
