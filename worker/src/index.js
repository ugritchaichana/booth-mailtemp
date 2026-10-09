const PUSH_TIMEOUT_MS = 15000;
const KV_TTL_SECONDS = 604800;
const REPLAY_BATCH = 15;

const log = (event, fields = {}) => console.log(JSON.stringify({ event, ...fields }));
const toHex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function sign(env, captureId, timestamp, body) {
  const bodyHash = toHex(await crypto.subtle.digest("SHA-256", body));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.HMAC_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${captureId}.${timestamp}.${bodyHash}`));
  return toHex(mac);
}

async function push(env, captureId, body, from, to) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers = {
    "X-Capture-Id": captureId,
    "X-Capture-Timestamp": timestamp,
    "X-Capture-Signature": await sign(env, captureId, timestamp, body),
    "X-Envelope-From": from,
    "X-Envelope-To": to,
  };
  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = env.CF_ACCESS_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = env.CF_ACCESS_CLIENT_SECRET;
  }
  const res = await fetch(env.BRIDGE_URL, { method: "POST", headers, body, signal: AbortSignal.timeout(PUSH_TIMEOUT_MS) });
  await res.body?.cancel();
  if (res.status < 200 || res.status > 299) throw new Error(`bridge status ${res.status}`);
}

export default {
  async email(message, env) {
    const captureId = crypto.randomUUID();
    const from = message.from;
    const to = message.to;
    let body;
    try {
      body = await new Response(message.raw).arrayBuffer();
    } catch (err) {
      log("CAPTURE_ERROR", { captureId, to, stage: "buffer", error: String(err) });
      return;
    }

    let pushError = "";
    try {
      await push(env, captureId, body, from, to);
      log("CAPTURE_DELIVERED", { captureId, to, size: body.byteLength });
      return;
    } catch (err) {
      pushError = String(err);
    }

    try {
      await env.CAPTURE_FALLBACK.put(captureId, body, {
        metadata: { from, to, size: body.byteLength },
        expirationTtl: KV_TTL_SECONDS,
      });
      log("CAPTURE_FALLBACK", { captureId, to, size: body.byteLength, reason: pushError });
    } catch (err) {
      log("CAPTURE_ERROR", { captureId, to, stage: "kv-put", error: String(err) });
      if (env.LAST_RESORT === "rethrow") throw err;
      log("CAPTURE_DROPPED", { captureId, from, to, size: body.byteLength });
    }
  },

  async scheduled(controller, env) {
    const { keys } = await env.CAPTURE_FALLBACK.list({ limit: REPLAY_BATCH });
    for (const { name } of keys) {
      try {
        const entry = await env.CAPTURE_FALLBACK.getWithMetadata(name, "arrayBuffer");
        if (!entry.value) continue;
        await push(env, name, entry.value, entry.metadata.from, entry.metadata.to);
        await env.CAPTURE_FALLBACK.delete(name);
        log("CAPTURE_DELIVERED", { captureId: name, to: entry.metadata.to, size: entry.metadata.size, replay: true });
      } catch (err) {
        log("CAPTURE_ERROR", { captureId: name, stage: "replay", error: String(err) });
      }
    }
  },
};
