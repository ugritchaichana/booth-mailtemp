import { runMonitorSafely } from "./monitor.js";
import { KV_TTL_SECONDS } from "./constants.js";

const INGEST_TIMEOUT_MS = 15000;
const REPLAY_BATCH = 15;

const log = (event, fields = {}) => console.log(JSON.stringify({ event, ...fields }));

async function ingest(env, body, from, to) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("ingest timeout")), INGEST_TIMEOUT_MS); });
  try {
    return await Promise.race([env.CLOUD.ingest(body, { from, to: [to] }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function logOutcome(captureId, to, size, result, extra = {}) {
  if (result?.stored === false) log("CAPTURE_NOT_STORED", { captureId, size, reason: String(result.reason ?? "").slice(0, 100), ...extra });
  else log("CAPTURE_DELIVERED", { captureId, to, size, target: "cloud", ...extra });
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

    let ingestError = "";
    try {
      const result = await ingest(env, body, from, to);
      logOutcome(captureId, to, body.byteLength, result);
      return;
    } catch (err) {
      ingestError = String(err?.message ?? err).slice(0, 200);
    }

    try {
      await env.CAPTURE_FALLBACK.put(captureId, body, {
        metadata: { from, to, size: body.byteLength },
        expirationTtl: KV_TTL_SECONDS,
      });
      log("CAPTURE_FALLBACK", { captureId, to, size: body.byteLength, reason: ingestError });
    } catch (err) {
      log("CAPTURE_ERROR", { captureId, to, stage: "kv-put", error: String(err) });
      if (env.LAST_RESORT === "rethrow") throw err;
      log("CAPTURE_DROPPED", { captureId, from, to, size: body.byteLength });
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runMonitorSafely(env));
    const { keys } = await env.CAPTURE_FALLBACK.list({ limit: REPLAY_BATCH });
    for (const { name } of keys) {
      try {
        const entry = await env.CAPTURE_FALLBACK.getWithMetadata(name, "arrayBuffer");
        if (!entry.value) continue;
        const result = await ingest(env, entry.value, entry.metadata.from, entry.metadata.to);
        await env.CAPTURE_FALLBACK.delete(name);
        logOutcome(name, entry.metadata.to, entry.metadata.size, result, { replay: true });
      } catch (err) {
        log("CAPTURE_ERROR", { captureId: name, stage: "replay", error: String(err) });
      }
    }
  },
};
