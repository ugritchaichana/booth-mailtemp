const MIN_TOKEN_CHARS = 32;
const MAX_RAW_BYTES = 25 * 1024 * 1024;
const encoder = new TextEncoder();

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

async function sameSecret(given, expected) {
  const [a, b] = await Promise.all([given, expected].map((v) => crypto.subtle.digest("SHA-256", encoder.encode(v))));
  return crypto.subtle.timingSafeEqual(a, b);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/import") return reply(404, { error: "not found" });
    if (typeof env.IMPORT_TOKEN !== "string" || env.IMPORT_TOKEN.length < MIN_TOKEN_CHARS) return reply(503, { error: "import is not configured" });
    const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
    if (!(await sameSecret(bearer, env.IMPORT_TOKEN))) return reply(401, { error: "unauthorized" });
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_RAW_BYTES) return reply(413, { error: "message too large" });
    const raw = await request.arrayBuffer();
    if (raw.byteLength > MAX_RAW_BYTES) return reply(413, { error: "message too large" });
    const to = (request.headers.get("x-envelope-to") ?? "").split(",").map((a) => a.trim()).filter(Boolean);
    const createdAt = request.headers.get("x-created-at") ?? undefined;
    try {
      return reply(200, await env.CLOUD.ingest(raw, { to }, { createdAt }));
    } catch (err) {
      return reply(502, { error: String(err?.message ?? err) });
    }
  },
};
